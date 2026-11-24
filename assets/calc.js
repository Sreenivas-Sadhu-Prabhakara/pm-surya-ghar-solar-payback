/* Rooftop solar payback — form wiring and rendering. No deps, no network.
   All arithmetic lives in assets/engine.js (window.SolarPayback). */
(function () {
  "use strict";

  var E = window.SolarPayback;
  if (!E) return;

  var MONEY = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  });
  var PLAIN = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  var ONE_DP = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function money(x) {
    return MONEY.format(isFinite(x) ? x : 0);
  }
  function plain(x) {
    return PLAIN.format(isFinite(x) ? x : 0);
  }
  function units(x) {
    return plain(x) + " kWh";
  }
  function kw(x) {
    if (!isFinite(x)) x = 0;
    var rounded = Math.round(x * 100) / 100;
    return (rounded % 1 === 0 ? plain(rounded) : ONE_DP.format(rounded)) + " kW";
  }
  function years(x) {
    var s = ONE_DP.format(isFinite(x) ? x : 0);
    return s + (s === "1.0" ? " year" : " years");
  }
  /* A deduction, shown as a deduction. */
  function minus(x) {
    return x > 0 ? "− " + money(x) : money(0);
  }
  function yrLabel(whole) {
    return whole + (whole === 1 ? " year" : " years");
  }

  /* ---- inputs ---- */
  var INPUT_IDS = [
    "bill", "units", "tariff", "size", "yield", "cost", "selfuse", "export",
    "topup", "custom-subsidy", "degrade", "escalate", "om", "years"
  ];
  var el = {};
  INPUT_IDS.forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var out = {};
  [
    "payback-main", "payback-sub", "r-size", "r-size-label", "r-gen", "r-self", "r-export",
    "r-billsave", "r-exportcredit", "r-om", "r-annual", "r-gross", "r-subsidy",
    "r-subsidy-label", "r-topup", "r-net", "cf-body", "cf-title", "cf-total-label",
    "cf-total-units", "cf-total-saving", "cf-total-net"
  ].forEach(function (id) {
    out[id] = document.getElementById(id);
  });

  var fields = {
    bill: document.getElementById("f-bill"),
    units: document.getElementById("f-units"),
    size: document.getElementById("f-size"),
    topup: document.getElementById("f-topup"),
    custom: document.getElementById("f-custom")
  };

  /* Modes held outside the form, flipped by the segmented buttons. */
  var mode = { basis: "bill", sizeMode: "auto", subsidy: "scheme" };

  /* Empty input -> 0, junk -> 0, never NaN. */
  function n(id) {
    var node = el[id];
    if (!node) return 0;
    var v = parseFloat(node.value);
    return isFinite(v) ? v : 0;
  }

  function set(node, text) {
    if (node) node.textContent = text;
  }

  function negClass(cell, value) {
    if (!cell) return;
    if (value < 0) cell.classList.add("neg");
    else cell.classList.remove("neg");
  }

  /* ---- rendering ---- */
  function render(r) {
    var horizon = r.inputsUsed.horizonYears;

    /* headline */
    if (r.status === "pays-back") {
      set(out["payback-main"], years(r.paybackYears));
      set(
        out["payback-sub"],
        money(r.netCostRs) + " to pay · " + money(r.annualSavingRs) +
          " saved in year 1 · simple payback " + years(r.simplePaybackYears)
      );
    } else if (r.status === "no-net-cost") {
      set(out["payback-main"], "Day one");
      set(out["payback-sub"], "The subsidy covers the whole installed cost at these inputs, so there is nothing to pay back.");
    } else if (r.status === "beyond-horizon") {
      set(out["payback-main"], "Not within " + yrLabel(horizon));
      set(
        out["payback-sub"],
        "Saves " + money(r.annualSavingRs) + " in year 1 — not enough to clear " +
          money(r.netCostRs) + " in " + yrLabel(horizon) +
          (r.simplePaybackYears === null ? "." : " (simple payback about " + years(r.simplePaybackYears) + ").")
      );
    } else if (r.status === "never") {
      set(out["payback-main"], "Never at these inputs");
      set(out["payback-sub"], "The system saves nothing each year, so it never pays back. Check the tariff, the share used at home and the export credit.");
    } else {
      set(out["payback-main"], "—");
      set(out["payback-sub"], "Enter a monthly bill, or switch to “I know the kW” and enter a system size.");
    }

    /* year 1 */
    set(out["r-size-label"], r.inputsUsed.sizeMode === "auto" ? "System size (sized for you)" : "System size (you entered)");
    set(out["r-size"], kw(r.systemSizeKw));
    set(out["r-gen"], units(r.annualGenerationKwh));
    set(out["r-self"], units(r.selfUsedKwh) + " (" + plain(r.offsetPercent) + "% of your use)");
    set(out["r-export"], units(r.exportedKwh));
    set(out["r-billsave"], money(r.billSavingRs));
    set(out["r-exportcredit"], money(r.exportCreditRs));
    set(out["r-om"], minus(r.oandmRs));
    negClass(out["r-om"], r.oandmRs > 0 ? -1 : 0);
    set(out["r-annual"], money(r.annualSavingRs));
    negClass(out["r-annual"], r.annualSavingRs);

    /* cost */
    set(out["r-gross"], money(r.grossCostRs));
    var subsidyLabel = r.subsidySource === "custom"
      ? "Subsidy you entered"
      : "Scheme assistance (indicative)";
    if (r.subsidyCappedByCost) subsidyLabel += " — limited to the cost";
    else if (r.subsidySource === "scheme" && (r.subsidyCapped || r.subsidyUnsubsidisedKw > 0)) {
      subsidyLabel += " — only the first " + kw(r.scheme.capKw) + " qualifies";
    }
    set(out["r-subsidy-label"], subsidyLabel);
    /* Split the (possibly cost-capped) total back into its two shown parts. */
    var topUpShown = Math.min(r.stateTopUpRs, r.subsidyRs);
    var schemePart = r.subsidySource === "custom" ? r.subsidyRs : Math.max(0, r.subsidyRs - topUpShown);
    set(out["r-subsidy"], minus(schemePart));
    set(out["r-topup"], r.subsidySource === "custom" ? "—" : minus(topUpShown));
    set(out["r-net"], money(r.netCostRs));

    /* cashflow */
    set(out["cf-title"], "Year-by-year cashflow, " + yrLabel(horizon));
    var body = out["cf-body"];
    if (body) {
      body.textContent = "";
      var totalUnits = 0;
      for (var i = 0; i < r.cashflow.length; i++) {
        var row = r.cashflow[i];
        totalUnits += row.generationKwh;
        var tr = document.createElement("tr");
        var c1 = document.createElement("td");
        c1.textContent = String(row.year);
        var c2 = document.createElement("td");
        c2.className = "num";
        c2.textContent = plain(row.generationKwh);
        var c3 = document.createElement("td");
        c3.className = "num";
        c3.textContent = plain(row.savingRs);
        if (row.savingRs < 0) c3.classList.add("neg");
        var c4 = document.createElement("td");
        c4.className = "num";
        c4.textContent = plain(row.netPositionRs);
        if (row.netPositionRs < 0) c4.classList.add("neg");
        tr.appendChild(c1);
        tr.appendChild(c2);
        tr.appendChild(c3);
        tr.appendChild(c4);
        body.appendChild(tr);
      }
      set(out["cf-total-label"], "Total over " + yrLabel(horizon));
      set(out["cf-total-units"], plain(totalUnits));
      set(out["cf-total-saving"], plain(r.lifetimeSavingRs));
      set(out["cf-total-net"], plain(r.lifetimeNetRs));
      negClass(out["cf-total-net"], r.lifetimeNetRs);
    }
  }

  function compute() {
    render(
      E.compute({
        consumptionBasis: mode.basis,
        monthlyBillRs: n("bill"),
        monthlyUnitsKwh: n("units"),
        tariffRsPerKwh: n("tariff"),
        sizeMode: mode.sizeMode,
        systemSizeKw: n("size"),
        specificYieldKwhPerKwpYear: n("yield"),
        costPerKwRs: n("cost"),
        selfConsumptionPercent: n("selfuse"),
        exportRateRsPerKwh: n("export"),
        subsidyMode: mode.subsidy,
        stateTopUpRs: n("topup"),
        customSubsidyRs: n("custom-subsidy"),
        annualDegradationPercent: n("degrade"),
        tariffEscalationPercent: n("escalate"),
        annualOandMRs: n("om"),
        horizonYears: n("years")
      })
    );
  }

  /* ---- segmented controls ---- */
  function press(nodes, attr, value) {
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute("aria-pressed", nodes[i].getAttribute(attr) === value ? "true" : "false");
    }
  }

  function show(node, visible) {
    if (!node) return;
    if (visible) node.removeAttribute("hidden");
    else node.setAttribute("hidden", "hidden");
  }

  function syncVisibility() {
    show(fields.bill, mode.basis === "bill");
    show(fields.units, mode.basis === "units");
    show(fields.size, mode.sizeMode === "manual");
    show(fields.topup, mode.subsidy === "scheme");
    show(fields.custom, mode.subsidy === "custom");
  }

  var basisBtns = document.querySelectorAll("[data-basis]");
  var sizeBtns = document.querySelectorAll("[data-sizemode]");
  var subsidyBtns = document.querySelectorAll("[data-subsidy]");
  var yieldBtns = document.querySelectorAll("[data-yield]");

  function wireMode(nodes, attr, key) {
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener("click", function (ev) {
        mode[key] = ev.currentTarget.getAttribute(attr);
        press(nodes, attr, mode[key]);
        syncVisibility();
        compute();
      });
    }
  }

  wireMode(basisBtns, "data-basis", "basis");
  wireMode(sizeBtns, "data-sizemode", "sizeMode");
  wireMode(subsidyBtns, "data-subsidy", "subsidy");

  function syncYieldPresets() {
    var current = el["yield"] ? el["yield"].value : "";
    for (var i = 0; i < yieldBtns.length; i++) {
      yieldBtns[i].setAttribute(
        "aria-pressed",
        yieldBtns[i].getAttribute("data-yield") === String(parseFloat(current)) ? "true" : "false"
      );
    }
  }

  for (var y = 0; y < yieldBtns.length; y++) {
    yieldBtns[y].addEventListener("click", function (ev) {
      if (el["yield"]) el["yield"].value = ev.currentTarget.getAttribute("data-yield");
      syncYieldPresets();
      compute();
    });
  }

  /* ---- recompute on every keystroke ---- */
  INPUT_IDS.forEach(function (id) {
    if (el[id]) {
      el[id].addEventListener("input", function () {
        if (id === "yield") syncYieldPresets();
        compute();
      });
    }
  });

  var printBtn = document.getElementById("print");
  if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

  var resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      INPUT_IDS.forEach(function (id) {
        if (el[id]) el[id].value = "";
      });
      mode.basis = "bill";
      mode.sizeMode = "auto";
      mode.subsidy = "scheme";
      press(basisBtns, "data-basis", mode.basis);
      press(sizeBtns, "data-sizemode", mode.sizeMode);
      press(subsidyBtns, "data-subsidy", mode.subsidy);
      syncYieldPresets();
      syncVisibility();
      compute();
    });
  }

  syncVisibility();
  syncYieldPresets();
  compute();
})();
