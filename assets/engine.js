/* Rooftop solar payback engine — pure maths, no DOM, no network, no dependencies.
   Loaded in the browser as window.SolarPayback; also usable as a CommonJS module
   so the same code can be exercised by the test suite in tests/. */
(function (root) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. SUBSIDY CONSTANTS — the single place rates live.
   *    INDICATIVE ONLY. Central financial assistance under the scheme named
   *    below is revised from time to time, is subject to eligibility and the
   *    national portal's registered-vendor process, and several states and
   *    DISCOMs add their own top-up on top of it. Always confirm on the
   *    official portal before promising a number to anyone.
   * ------------------------------------------------------------------ */
  var SUBSIDY_SCHEME = {
    id: "PM_SURYA_GHAR",
    name: "PM Surya Ghar Muft Bijli Yojana",
    authority: "Ministry of New and Renewable Energy, Government of India",
    portal: "pmsuryaghar.gov.in",
    currency: "INR",
    appliesTo:
      "Grid-connected rooftop solar on an individual residential consumer's own electricity connection.",
    status: "INDICATIVE — not guaranteed, not a sanction, not a quotation.",
    checkedOn: "2026-11",
    /* Central financial assistance, residential consumers, slab-wise. */
    bands: [
      { label: "First 2 kW", uptoKw: 2, ratePerKwRs: 30000 },
      { label: "Third kW (2–3 kW)", uptoKw: 3, ratePerKwRs: 18000 }
    ],
    /* Cumulative ceiling: capacity above capKw earns nothing further. */
    capRs: 78000,
    capKw: 3,
    /* Figures deliberately NOT shipped as constants, because they could not be
       sourced confidently enough to put a number on a homeowner's screen. */
    notModelled: [
      "State / DISCOM top-up subsidies — state-specific and revised often; enter yours in the state top-up field.",
      "Any additional assistance for special-category states or UTs — rate not confirmed here.",
      "Group Housing Society / RWA common-facility assistance — a separate stream with its own per-kW rate and ceiling.",
      "Net-metering, banking and feed-in rules — set by your DISCOM, not by the central scheme."
    ]
  };

  /* Non-subsidy defaults. Also indicative: each one is a field the user can edit. */
  var DEFAULTS = {
    specificYieldKwhPerKwpYear: 1400, /* typical India plane-of-array yield band: ~1150–1650 */
    costPerKwRs: 60000,               /* indicative installed price band for 1–3 kW residential */
    selfConsumptionPercent: 65,
    exportRateRsPerKwh: 2.5,
    annualDegradationPercent: 0.5,
    tariffEscalationPercent: 3,
    annualOandMRs: 1500,
    horizonYears: 25,
    maxSizeKw: 10,                    /* sanity ceiling for auto-sizing a residential roof */
    sizeStepKw: 0.5
  };

  var YIELD_PRESETS = [
    { id: "low", label: "Lower sun / shaded", kwhPerKwpYear: 1250 },
    { id: "typical", label: "Typical", kwhPerKwpYear: 1400 },
    { id: "high", label: "High sun / clear roof", kwhPerKwpYear: 1550 }
  ];

  /* ------------------------------------------------------------------ *
   * 2. Small numeric helpers. Nothing here may return NaN or Infinity.
   * ------------------------------------------------------------------ */
  function num(v, fallback) {
    var n = typeof v === "number" ? v : parseFloat(v);
    if (typeof n !== "number" || !isFinite(n)) return fallback === undefined ? 0 : fallback;
    return n;
  }

  function fin(v) {
    return isFinite(v) ? v : 0;
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function nonNeg(v) {
    return v > 0 ? v : 0;
  }

  function roundTo(v, step) {
    if (!(step > 0)) return v;
    return Math.round(v / step) * step;
  }

  /* ------------------------------------------------------------------ *
   * 3. Subsidy: walk the slabs, then apply the cumulative ceiling.
   * ------------------------------------------------------------------ */
  function subsidyForKw(sizeKw, scheme) {
    var s = scheme || SUBSIDY_SCHEME;
    var kw = nonNeg(fin(num(sizeKw)));
    var bands = [];
    var total = 0;
    var covered = 0;

    for (var i = 0; i < s.bands.length; i++) {
      var band = s.bands[i];
      var upto = nonNeg(num(band.uptoKw));
      var bandKw = nonNeg(Math.min(kw, upto) - covered);
      var amount = fin(bandKw * nonNeg(num(band.ratePerKwRs)));
      total += amount;
      bands.push({
        label: band.label,
        kw: bandKw,
        ratePerKwRs: nonNeg(num(band.ratePerKwRs)),
        amountRs: amount
      });
      covered = Math.max(covered, upto);
    }

    var cap = nonNeg(num(s.capRs, Infinity));
    var capped = isFinite(cap) && total > cap;
    if (capped) total = cap;

    return {
      amountRs: fin(total),
      bands: bands,
      capped: capped,
      capRs: isFinite(cap) ? cap : null,
      unsubsidisedKw: nonNeg(kw - nonNeg(num(s.capKw))),
      scheme: s.name,
      portal: s.portal,
      status: s.status
    };
  }

  /* ------------------------------------------------------------------ *
   * 4. Sizing: how many kW would cover a year's consumption?
   *    Zero consumption or zero yield means no system, not a divide-by-zero.
   * ------------------------------------------------------------------ */
  function recommendSizeKw(annualConsumptionKwh, specificYieldKwhPerKwpYear, opts) {
    var o = opts || {};
    var consumption = nonNeg(fin(num(annualConsumptionKwh)));
    var yieldPerKwp = nonNeg(fin(num(specificYieldKwhPerKwpYear)));
    if (consumption <= 0 || yieldPerKwp <= 0) return 0;

    var step = num(o.sizeStepKw, DEFAULTS.sizeStepKw);
    var maxKw = num(o.maxSizeKw, DEFAULTS.maxSizeKw);
    var raw = consumption / yieldPerKwp;
    var rounded = roundTo(raw, step);
    if (rounded < step) rounded = step;
    return clamp(fin(rounded), 0, nonNeg(maxKw));
  }

  /* ------------------------------------------------------------------ *
   * 5. Annual consumption from either a bill or a meter reading.
   *    A zero tariff cannot be divided into a bill — that is 0 units, not NaN.
   * ------------------------------------------------------------------ */
  function annualConsumptionKwh(input) {
    var basis = input.consumptionBasis === "units" ? "units" : "bill";
    var tariff = nonNeg(fin(num(input.tariffRsPerKwh)));
    if (basis === "units") {
      return nonNeg(fin(num(input.monthlyUnitsKwh))) * 12;
    }
    var bill = nonNeg(fin(num(input.monthlyBillRs)));
    if (tariff <= 0) return 0;
    return fin(bill / tariff) * 12;
  }

  /* ------------------------------------------------------------------ *
   * 6. One year of energy and money, given a generation figure and tariff.
   *    Units offset on site can never exceed what the household actually uses.
   * ------------------------------------------------------------------ */
  function yearSplit(generationKwh, consumptionKwh, selfShare, tariff, exportRate, oandm) {
    var gen = nonNeg(fin(generationKwh));
    var wanted = gen * clamp(fin(selfShare), 0, 1);
    var selfUsed = Math.min(wanted, nonNeg(fin(consumptionKwh)));
    var exported = nonNeg(gen - selfUsed);
    var billSaving = fin(selfUsed * nonNeg(fin(tariff)));
    var exportCredit = fin(exported * nonNeg(fin(exportRate)));
    var om = nonNeg(fin(oandm));
    return {
      generationKwh: gen,
      selfUsedKwh: selfUsed,
      exportedKwh: exported,
      billSavingRs: billSaving,
      exportCreditRs: exportCredit,
      oandmRs: om,
      netSavingRs: fin(billSaving + exportCredit - om)
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. The whole calculation.
   * ------------------------------------------------------------------ */
  function compute(rawInput) {
    var input = rawInput || {};
    var scheme = input.scheme || SUBSIDY_SCHEME;

    var tariff = nonNeg(fin(num(input.tariffRsPerKwh)));
    var exportRate = nonNeg(fin(num(input.exportRateRsPerKwh, DEFAULTS.exportRateRsPerKwh)));
    var yieldPerKwp = nonNeg(fin(num(input.specificYieldKwhPerKwpYear, DEFAULTS.specificYieldKwhPerKwpYear)));
    var consumption = annualConsumptionKwh(input);

    var sizeMode = input.sizeMode === "manual" ? "manual" : "auto";
    var sizeKw =
      sizeMode === "manual"
        ? clamp(nonNeg(fin(num(input.systemSizeKw))), 0, 1000)
        : recommendSizeKw(consumption, yieldPerKwp, input);

    var selfShare = clamp(fin(num(input.selfConsumptionPercent, DEFAULTS.selfConsumptionPercent)) / 100, 0, 1);
    var degradation = clamp(fin(num(input.annualDegradationPercent, DEFAULTS.annualDegradationPercent)) / 100, 0, 0.2);
    var escalation = clamp(fin(num(input.tariffEscalationPercent, DEFAULTS.tariffEscalationPercent)) / 100, 0, 0.25);
    var oandm = nonNeg(fin(num(input.annualOandMRs, DEFAULTS.annualOandMRs)));
    if (sizeKw <= 0) oandm = 0; /* no system, nothing to clean or maintain */
    var years = Math.round(clamp(num(input.horizonYears, DEFAULTS.horizonYears), 1, 40));

    /* Cost and subsidy */
    var grossCostRs = fin(sizeKw * nonNeg(fin(num(input.costPerKwRs, DEFAULTS.costPerKwRs))));
    var slab = subsidyForKw(sizeKw, scheme);
    var stateTopUpRs = nonNeg(fin(num(input.stateTopUpRs)));
    var subsidySource = "scheme";
    var subsidyRs;
    if (input.subsidyMode === "custom") {
      subsidySource = "custom";
      subsidyRs = nonNeg(fin(num(input.customSubsidyRs)));
    } else {
      subsidyRs = slab.amountRs + stateTopUpRs;
    }
    /* A subsidy can never exceed what the system costs. */
    var subsidyCappedByCost = subsidyRs > grossCostRs;
    if (subsidyCappedByCost) subsidyRs = grossCostRs;
    var netCostRs = nonNeg(fin(grossCostRs - subsidyRs));

    /* Year 1 */
    var year1 = yearSplit(sizeKw * yieldPerKwp, consumption, selfShare, tariff, exportRate, oandm);

    /* Year-by-year cashflow: panels fade, the retail tariff climbs, the export
       rate is held flat (DISCOM feed-in rates are not indexed to retail). */
    var rows = [];
    var cumulative = 0;
    var paybackYear = null;
    var anyPositiveSaving = false;
    var previousNet = -netCostRs;
    for (var y = 1; y <= years; y++) {
      var gen = fin(sizeKw * yieldPerKwp * Math.pow(1 - degradation, y - 1));
      var tariffY = fin(tariff * Math.pow(1 + escalation, y - 1));
      var split = yearSplit(gen, consumption, selfShare, tariffY, exportRate, oandm);
      if (split.netSavingRs > 0) anyPositiveSaving = true;
      cumulative = fin(cumulative + split.netSavingRs);
      var net = fin(cumulative - netCostRs);
      if (paybackYear === null && net >= 0) {
        if (split.netSavingRs > 0 && previousNet < 0) {
          paybackYear = fin(y - 1 + -previousNet / split.netSavingRs);
        } else {
          paybackYear = y;
        }
      }
      rows.push({
        year: y,
        generationKwh: split.generationKwh,
        selfUsedKwh: split.selfUsedKwh,
        exportedKwh: split.exportedKwh,
        tariffRsPerKwh: tariffY,
        savingRs: split.netSavingRs,
        cumulativeSavingRs: cumulative,
        netPositionRs: net
      });
      previousNet = net;
    }

    /* Payback. Five distinct outcomes, none of which may divide by zero and
       none of which may surface as NaN or Infinity:
         no-system     — nothing entered yet, or a zero-size system
         no-net-cost   — subsidy covers the whole cost, so payback is day one
         pays-back     — cumulative cashflow crosses zero inside the horizon
         beyond-horizon— it saves money, but not enough to clear the cost in time
         never         — no year ever saves anything, so it never pays back */
    var status;
    var simplePaybackYears = year1.netSavingRs > 0 ? fin(netCostRs / year1.netSavingRs) : null;
    if (sizeKw <= 0) {
      status = "no-system";
      paybackYear = null;
      simplePaybackYears = null;
    } else if (netCostRs <= 0) {
      status = "no-net-cost";
      paybackYear = 0;
      simplePaybackYears = 0;
    } else if (paybackYear !== null) {
      status = "pays-back";
    } else if (!anyPositiveSaving) {
      status = "never";
    } else {
      status = "beyond-horizon";
    }

    var lifetimeSavingRs = rows.length ? rows[rows.length - 1].cumulativeSavingRs : 0;

    return {
      status: status,
      inputsUsed: {
        consumptionBasis: input.consumptionBasis === "units" ? "units" : "bill",
        tariffRsPerKwh: tariff,
        exportRateRsPerKwh: exportRate,
        specificYieldKwhPerKwpYear: yieldPerKwp,
        selfConsumptionPercent: selfShare * 100,
        annualDegradationPercent: degradation * 100,
        tariffEscalationPercent: escalation * 100,
        annualOandMRs: oandm,
        horizonYears: years,
        sizeMode: sizeMode
      },
      annualConsumptionKwh: consumption,
      monthlyConsumptionKwh: fin(consumption / 12),
      systemSizeKw: sizeKw,
      annualGenerationKwh: year1.generationKwh,
      monthlyGenerationKwh: fin(year1.generationKwh / 12),
      selfUsedKwh: year1.selfUsedKwh,
      exportedKwh: year1.exportedKwh,
      offsetPercent: consumption > 0 ? fin((year1.selfUsedKwh / consumption) * 100) : 0,
      billSavingRs: year1.billSavingRs,
      exportCreditRs: year1.exportCreditRs,
      oandmRs: year1.oandmRs,
      annualSavingRs: year1.netSavingRs,
      monthlySavingRs: fin(year1.netSavingRs / 12),
      grossCostRs: grossCostRs,
      subsidyRs: subsidyRs,
      subsidySource: subsidySource,
      subsidyBands: slab.bands,
      subsidySlabRs: slab.amountRs,
      stateTopUpRs: subsidySource === "custom" ? 0 : stateTopUpRs,
      subsidyCapped: slab.capped,
      subsidyUnsubsidisedKw: slab.unsubsidisedKw, /* capacity above the scheme's subsidised band */
      subsidyCappedByCost: subsidyCappedByCost,
      netCostRs: netCostRs,
      simplePaybackYears: simplePaybackYears,
      paybackYears: paybackYear,
      lifetimeSavingRs: lifetimeSavingRs,
      lifetimeNetRs: fin(lifetimeSavingRs - netCostRs),
      cashflow: rows,
      scheme: {
        name: scheme.name,
        portal: scheme.portal,
        status: scheme.status,
        capRs: scheme.capRs,
        capKw: scheme.capKw
      }
    };
  }

  var API = {
    SUBSIDY_SCHEME: SUBSIDY_SCHEME,
    DEFAULTS: DEFAULTS,
    YIELD_PRESETS: YIELD_PRESETS,
    subsidyForKw: subsidyForKw,
    recommendSizeKw: recommendSizeKw,
    annualConsumptionKwh: annualConsumptionKwh,
    yearSplit: yearSplit,
    compute: compute
  };

  if (typeof module === "object" && module && module.exports) module.exports = API;
  if (root) root.SolarPayback = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
