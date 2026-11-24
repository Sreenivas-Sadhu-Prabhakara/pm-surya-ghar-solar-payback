/* Table-driven tests for the payback engine. Run from the repo root:  node --test */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../assets/engine.js");

/* ---------- helpers ---------- */

/* Walk every number in a result and fail on NaN / Infinity / -Infinity. */
function assertAllFinite(value, path) {
  path = path || "result";
  if (typeof value === "number") {
    assert.ok(
      Number.isFinite(value),
      path + " is not a finite number: " + String(value)
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, path + "[" + i + "]"));
    return;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach((k) => assertAllFinite(value[k], path + "." + k));
  }
}

const close = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

/* A realistic baseline: ~₹3,000/month at ₹8/kWh = 375 units/month = 4,500/year. */
const BASE = {
  consumptionBasis: "bill",
  monthlyBillRs: 3000,
  tariffRsPerKwh: 8,
  specificYieldKwhPerKwpYear: 1400,
  sizeMode: "auto",
  costPerKwRs: 60000,
  selfConsumptionPercent: 65,
  exportRateRsPerKwh: 2.5,
  annualDegradationPercent: 0.5,
  tariffEscalationPercent: 3,
  annualOandMRs: 1500,
  horizonYears: 25
};

const withBase = (over) => Object.assign({}, BASE, over);

/* ---------- 1. subsidy slabs ---------- */

test("subsidy slabs follow the published per-kW bands and the cumulative cap", () => {
  const cases = [
    { kw: 0, expect: 0, why: "no system, no assistance" },
    { kw: 0.5, expect: 15000, why: "half of the first band" },
    { kw: 1, expect: 30000, why: "first band" },
    { kw: 1.5, expect: 45000, why: "mid first band" },
    { kw: 2, expect: 60000, why: "top of the first band" },
    { kw: 2.5, expect: 69000, why: "60,000 + half of the third-kW band" },
    { kw: 3, expect: 78000, why: "cap reached exactly" },
    { kw: 3.5, expect: 78000, why: "capped" },
    { kw: 10, expect: 78000, why: "capped far above" },
    { kw: -5, expect: 0, why: "negative size clamps to zero" },
    { kw: "abc", expect: 0, why: "junk input is zero, not NaN" },
    { kw: null, expect: 0, why: "null is zero" }
  ];
  for (const c of cases) {
    const got = E.subsidyForKw(c.kw);
    assert.equal(got.amountRs, c.expect, c.kw + " kW (" + c.why + ")");
    assertAllFinite(got, "subsidy(" + c.kw + ")");
  }
});

test("subsidy constants are labelled indicative and name the scheme and portal", () => {
  const s = E.SUBSIDY_SCHEME;
  assert.match(s.name, /PM Surya Ghar/);
  assert.match(s.status, /INDICATIVE/);
  assert.equal(s.portal, "pmsuryaghar.gov.in");
  assert.equal(s.capRs, 78000);
  assert.equal(s.capKw, 3);
  assert.ok(s.notModelled.length >= 3, "figures left out are listed, not invented");
});

test("capacity above the subsidised band is reported, not silently subsidised", () => {
  const cases = [
    { kw: 2, subsidy: 60000, over: 0 },
    { kw: 3, subsidy: 78000, over: 0 },
    { kw: 4, subsidy: 78000, over: 1 },
    { kw: 6.5, subsidy: 78000, over: 3.5 }
  ];
  for (const c of cases) {
    const r = E.compute(withBase({ sizeMode: "manual", systemSizeKw: c.kw }));
    assert.equal(r.subsidyRs, c.subsidy, c.kw + " kW subsidy");
    assert.ok(close(r.subsidyUnsubsidisedKw, c.over), c.kw + " kW unsubsidised: " + r.subsidyUnsubsidisedKw);
    assert.equal(r.grossCostRs, c.kw * 60000);
  }
});

test("the slab table is overridable without touching the engine", () => {
  const stateScheme = {
    name: "Test state scheme",
    portal: "example.invalid",
    status: "INDICATIVE",
    bands: [{ label: "First 3 kW", uptoKw: 3, ratePerKwRs: 10000 }],
    capRs: 25000,
    capKw: 3
  };
  assert.equal(E.subsidyForKw(2, stateScheme).amountRs, 20000);
  assert.equal(E.subsidyForKw(3, stateScheme).amountRs, 25000, "own cap applies");
  const r = E.compute(withBase({ scheme: stateScheme, sizeMode: "manual", systemSizeKw: 3 }));
  assert.equal(r.subsidyRs, 25000);
  assert.equal(r.scheme.name, "Test state scheme");
});

/* ---------- 2. sizing ---------- */

test("system size is recommended from annual consumption and specific yield", () => {
  const cases = [
    { kwh: 4500, yieldv: 1400, expect: 3, why: "4500/1400 = 3.21 -> nearest 0.5" },
    { kwh: 1400, yieldv: 1400, expect: 1, why: "exactly 1 kW" },
    { kwh: 100, yieldv: 1400, expect: 0.5, why: "floor is one step, not zero" },
    { kwh: 0, yieldv: 1400, expect: 0, why: "no consumption means no system" },
    { kwh: 4500, yieldv: 0, expect: 0, why: "zero yield must not divide by zero" },
    { kwh: 4500, yieldv: -1400, expect: 0, why: "negative yield is rejected" },
    { kwh: 1e9, yieldv: 1400, expect: 10, why: "clamped to the residential ceiling" }
  ];
  for (const c of cases) {
    const got = E.recommendSizeKw(c.kwh, c.yieldv);
    assert.ok(Number.isFinite(got), c.why + " -> finite");
    assert.ok(close(got, c.expect, 1e-9), c.kwh + " kWh @ " + c.yieldv + " (" + c.why + "): " + got);
  }
});

/* ---------- 3. consumption basis ---------- */

test("annual consumption comes from the bill or the meter, never from a zero divisor", () => {
  const cases = [
    { in: { consumptionBasis: "bill", monthlyBillRs: 3000, tariffRsPerKwh: 8 }, expect: 4500 },
    { in: { consumptionBasis: "bill", monthlyBillRs: 3000, tariffRsPerKwh: 0 }, expect: 0 },
    { in: { consumptionBasis: "bill", monthlyBillRs: 0, tariffRsPerKwh: 8 }, expect: 0 },
    { in: { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 0 }, expect: 4500 },
    { in: { consumptionBasis: "units", monthlyUnitsKwh: "" }, expect: 0 },
    { in: { consumptionBasis: "units", monthlyUnitsKwh: -50 }, expect: 0 }
  ];
  for (const c of cases) {
    const got = E.annualConsumptionKwh(c.in);
    assert.ok(Number.isFinite(got), "finite for " + JSON.stringify(c.in));
    assert.ok(close(got, c.expect), JSON.stringify(c.in) + " -> " + got);
  }
});

/* ---------- 4. the baseline end-to-end ---------- */

test("baseline case computes size, generation, split, subsidy and payback", () => {
  const r = E.compute(BASE);
  assertAllFinite(r);
  assert.equal(r.status, "pays-back");
  assert.equal(r.annualConsumptionKwh, 4500);
  assert.equal(r.systemSizeKw, 3);
  assert.equal(r.annualGenerationKwh, 4200);                 /* 3 kW x 1400 */
  assert.ok(close(r.selfUsedKwh, 2730), r.selfUsedKwh);      /* 65% of 4200 */
  assert.ok(close(r.exportedKwh, 1470), r.exportedKwh);
  assert.ok(close(r.billSavingRs, 21840));                   /* 2730 x 8 */
  assert.ok(close(r.exportCreditRs, 3675));                  /* 1470 x 2.5 */
  assert.ok(close(r.annualSavingRs, 21840 + 3675 - 1500));
  assert.equal(r.grossCostRs, 180000);                       /* 3 x 60,000 */
  assert.equal(r.subsidyRs, 78000);
  assert.equal(r.netCostRs, 102000);
  assert.ok(close(r.simplePaybackYears, 102000 / 24015, 1e-9));
  assert.ok(r.paybackYears > 4 && r.paybackYears < 5, "cashflow payback " + r.paybackYears);
  assert.equal(r.cashflow.length, 25);
});

test("cashflow rows are internally consistent", () => {
  const r = E.compute(BASE);
  let cumulative = 0;
  for (const row of r.cashflow) {
    cumulative += row.savingRs;
    assert.ok(close(row.cumulativeSavingRs, cumulative, 1e-6), "year " + row.year + " cumulative");
    assert.ok(close(row.netPositionRs, cumulative - r.netCostRs, 1e-6), "year " + row.year + " net");
    assert.ok(close(row.selfUsedKwh + row.exportedKwh, row.generationKwh, 1e-6), "split sums to generation");
  }
  assert.ok(close(r.lifetimeSavingRs, cumulative, 1e-6));
  assert.ok(close(r.lifetimeNetRs, cumulative - r.netCostRs, 1e-6));
});

test("with no degradation and no escalation the cashflow payback equals the simple payback", () => {
  const r = E.compute(withBase({ annualDegradationPercent: 0, tariffEscalationPercent: 0, horizonYears: 40 }));
  assert.ok(close(r.paybackYears, r.simplePaybackYears, 1e-6), r.paybackYears + " vs " + r.simplePaybackYears);
});

test("panel degradation lowers later generation and tariff escalation raises later savings", () => {
  const r = E.compute(BASE);
  const first = r.cashflow[0];
  const last = r.cashflow[r.cashflow.length - 1];
  assert.ok(last.generationKwh < first.generationKwh, "generation decays");
  assert.ok(last.tariffRsPerKwh > first.tariffRsPerKwh, "tariff escalates");
  assert.ok(last.savingRs > first.savingRs, "net saving still grows at 3% vs 0.5%");
});

/* ---------- 5. the required edge cases ---------- */

test("edge cases: zero consumption, zero tariff, export-only, never-pays-back", () => {
  const cases = [
    {
      name: "zero consumption, auto size",
      input: withBase({ monthlyBillRs: 0 }),
      check(r) {
        assert.equal(r.annualConsumptionKwh, 0);
        assert.equal(r.systemSizeKw, 0);
        assert.equal(r.annualGenerationKwh, 0);
        assert.equal(r.annualSavingRs, 0, "no system means no O&M charge either");
        assert.equal(r.status, "no-system");
        assert.equal(r.paybackYears, null);
        assert.equal(r.simplePaybackYears, null);
      }
    },
    {
      name: "zero consumption but a system was still bought",
      input: withBase({ monthlyBillRs: 0, sizeMode: "manual", systemSizeKw: 3 }),
      check(r) {
        assert.equal(r.annualConsumptionKwh, 0);
        assert.equal(r.selfUsedKwh, 0, "cannot self-consume what you do not use");
        assert.equal(r.exportedKwh, 4200, "everything goes to the grid");
        assert.equal(r.billSavingRs, 0);
        assert.ok(close(r.exportCreditRs, 10500));
        assert.equal(r.offsetPercent, 0);
      }
    },
    {
      name: "zero tariff, bill basis",
      input: withBase({ tariffRsPerKwh: 0 }),
      check(r) {
        assert.equal(r.annualConsumptionKwh, 0, "a bill cannot be divided by a zero tariff");
        assert.equal(r.systemSizeKw, 0);
        assert.equal(r.status, "no-system");
      }
    },
    {
      name: "zero tariff, units basis, manual size",
      input: withBase({
        consumptionBasis: "units",
        monthlyUnitsKwh: 375,
        tariffRsPerKwh: 0,
        sizeMode: "manual",
        systemSizeKw: 3
      }),
      check(r) {
        assert.equal(r.annualConsumptionKwh, 4500);
        assert.equal(r.billSavingRs, 0, "free electricity saves nothing");
        assert.ok(close(r.exportCreditRs, 1470 * 2.5));
        assert.ok(close(r.annualSavingRs, 1470 * 2.5 - 1500));
        assert.equal(r.status, "beyond-horizon", "export credit alone will not clear the cost in 25 years");
        assert.equal(r.paybackYears, null);
        assert.ok(r.simplePaybackYears > 25);
      }
    },
    {
      name: "export-only: nothing is consumed on site",
      input: withBase({ selfConsumptionPercent: 0, sizeMode: "manual", systemSizeKw: 3 }),
      check(r) {
        assert.equal(r.selfUsedKwh, 0);
        assert.equal(r.exportedKwh, 4200);
        assert.equal(r.billSavingRs, 0);
        assert.ok(close(r.exportCreditRs, 10500));
        assert.ok(close(r.annualSavingRs, 9000));
        assert.ok(close(r.simplePaybackYears, 102000 / 9000, 1e-9));
      }
    },
    {
      name: "never pays back: no export value and nothing offset",
      input: withBase({
        sizeMode: "manual",
        systemSizeKw: 3,
        selfConsumptionPercent: 0,
        exportRateRsPerKwh: 0,
        annualOandMRs: 1500
      }),
      check(r) {
        assert.equal(r.annualSavingRs, -1500);
        assert.equal(r.status, "never");
        assert.equal(r.paybackYears, null, "null, never Infinity");
        assert.equal(r.simplePaybackYears, null, "null, never a divide by zero");
        assert.ok(r.lifetimeNetRs < 0);
      }
    },
    {
      name: "never pays back: zero saving exactly",
      input: withBase({
        sizeMode: "manual",
        systemSizeKw: 3,
        selfConsumptionPercent: 0,
        exportRateRsPerKwh: 0,
        annualOandMRs: 0
      }),
      check(r) {
        assert.equal(r.annualSavingRs, 0);
        assert.equal(r.status, "never");
        assert.equal(r.paybackYears, null);
        assert.equal(r.simplePaybackYears, null);
      }
    },
    {
      name: "subsidy covers the whole cost",
      input: withBase({ sizeMode: "manual", systemSizeKw: 1, costPerKwRs: 20000 }),
      check(r) {
        assert.equal(r.grossCostRs, 20000);
        assert.equal(r.subsidyRs, 20000, "assistance never exceeds the cost");
        assert.equal(r.subsidyCappedByCost, true);
        assert.equal(r.netCostRs, 0);
        assert.equal(r.status, "no-net-cost");
        assert.equal(r.paybackYears, 0);
        assert.equal(r.simplePaybackYears, 0);
      }
    },
    {
      name: "everything empty",
      input: {},
      check(r) {
        assert.equal(r.status, "no-system");
        assert.equal(r.annualConsumptionKwh, 0);
        assert.equal(r.systemSizeKw, 0);
        assert.equal(r.grossCostRs, 0);
        assert.equal(r.subsidyRs, 0);
        assert.equal(r.netCostRs, 0);
        assert.equal(r.paybackYears, null);
      }
    }
  ];

  for (const c of cases) {
    const r = E.compute(c.input);
    assertAllFinite(r, c.name);
    c.check(r);
  }
});

/* ---------- 6. hostile inputs ---------- */

test("hostile and empty inputs never produce NaN or Infinity", () => {
  const hostile = [
    {},
    null,
    undefined,
    { monthlyBillRs: "", tariffRsPerKwh: "" },
    { monthlyBillRs: "abc", tariffRsPerKwh: "xyz", specificYieldKwhPerKwpYear: "oops" },
    { monthlyBillRs: -3000, tariffRsPerKwh: -8, costPerKwRs: -60000, annualOandMRs: -99 },
    { monthlyBillRs: 1e308, tariffRsPerKwh: 1e-308, sizeMode: "manual", systemSizeKw: 1e308 },
    { sizeMode: "manual", systemSizeKw: Infinity, costPerKwRs: Infinity },
    { sizeMode: "manual", systemSizeKw: NaN, tariffRsPerKwh: NaN },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, horizonYears: 0 },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, horizonYears: 1e6 },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, annualDegradationPercent: 999 },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, tariffEscalationPercent: 1e6 },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, selfConsumptionPercent: 900 },
    { consumptionBasis: "units", monthlyUnitsKwh: 375, tariffRsPerKwh: 8, selfConsumptionPercent: -900 },
    { subsidyMode: "custom", customSubsidyRs: "not a number", sizeMode: "manual", systemSizeKw: 3, costPerKwRs: 60000 },
    { subsidyMode: "custom", customSubsidyRs: 1e308, sizeMode: "manual", systemSizeKw: 3, costPerKwRs: 60000 }
  ];
  for (const input of hostile) {
    const r = E.compute(input);
    assertAllFinite(r, "hostile " + JSON.stringify(input));
    assert.ok(
      r.paybackYears === null || Number.isFinite(r.paybackYears),
      "payback is a number or null, never Infinity"
    );
    assert.ok(
      r.simplePaybackYears === null || Number.isFinite(r.simplePaybackYears),
      "simple payback is a number or null"
    );
    assert.ok(r.cashflow.length >= 1 && r.cashflow.length <= 40, "horizon stays sane: " + r.cashflow.length);
    assert.ok(r.systemSizeKw >= 0 && r.netCostRs >= 0 && r.subsidyRs >= 0, "no negative money or capacity");
  }
});

/* ---------- 7. clamps and overrides ---------- */

test("shares and rates are clamped to sane ranges", () => {
  const over = E.compute(withBase({ selfConsumptionPercent: 900, sizeMode: "manual", systemSizeKw: 3 }));
  assert.equal(over.inputsUsed.selfConsumptionPercent, 100, "self-consumption cannot exceed 100%");
  assert.equal(over.selfUsedKwh, 4200, "but it is still capped by what the home actually uses");

  const under = E.compute(withBase({ selfConsumptionPercent: -900, sizeMode: "manual", systemSizeKw: 3 }));
  assert.equal(under.inputsUsed.selfConsumptionPercent, 0);
  assert.equal(under.selfUsedKwh, 0);

  const small = E.compute(withBase({ consumptionBasis: "units", monthlyUnitsKwh: 50, sizeMode: "manual", systemSizeKw: 3 }));
  assert.equal(small.selfUsedKwh, 600, "self-use is capped at the household's 600 kWh a year");
  assert.equal(small.exportedKwh, 3600);
  assert.ok(close(small.offsetPercent, 100));
});

test("a user-entered subsidy replaces the slab figure, a state top-up adds to it", () => {
  const custom = E.compute(withBase({ sizeMode: "manual", systemSizeKw: 3, subsidyMode: "custom", customSubsidyRs: 50000 }));
  assert.equal(custom.subsidySource, "custom");
  assert.equal(custom.subsidyRs, 50000);
  assert.equal(custom.netCostRs, 130000);

  const topUp = E.compute(withBase({ sizeMode: "manual", systemSizeKw: 3, stateTopUpRs: 20000 }));
  assert.equal(topUp.subsidySource, "scheme");
  assert.equal(topUp.subsidySlabRs, 78000);
  assert.equal(topUp.subsidyRs, 98000);
  assert.equal(topUp.netCostRs, 82000);
});
