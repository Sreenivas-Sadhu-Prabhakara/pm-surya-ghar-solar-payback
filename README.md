# Rooftop solar payback calculator (PM Surya Ghar)

A single-page, dependency-free calculator that turns an electricity bill into a rooftop solar
decision: system size, annual generation, the split between units used at home and units exported,
the saving at your own tariff slab, the indicative central subsidy, what you actually pay, the
payback period, and a year-by-year cashflow.

The page is both the working tool and its own explainer. Nothing is sent anywhere — there is no
backend, no analytics, no network call of any kind. Everything is computed in the browser and
nothing you type leaves your device.

## What it computes

1. **Units, not rupees** — `monthly bill ÷ tariff × 12` gives annual consumption, or enter units
   from your meter directly.
2. **Size** — `annual units ÷ specific yield`, rounded to the nearest half kilowatt, or enter the
   kW yourself.
3. **Generation and split** — `size × specific yield` units a year; the daytime share offsets units
   you would have bought at your own tariff, the rest is exported at whatever your DISCOM credits.
   Units used at home are capped at what the home actually consumes, so an oversized system simply
   exports more.
4. **Cost after subsidy** — `size × cost per kW`, minus the indicative scheme assistance for that
   size (plus any state top-up you enter), never more than the system costs.
5. **Payback** — `net cost ÷ year-1 net saving` for the simple figure, plus a cashflow that ages the
   panels, escalates your retail tariff, charges upkeep every year, and reports the year the
   cumulative saving overtakes what you paid. If that never happens, it says so rather than
   printing a number.

## Who it's for

- **Homeowners** in India working out whether rooftop solar is worth it, and what the subsidy
  actually leaves them to pay.
- **Rooftop solar installers** who need to answer "how long until it pays for itself?" on the first
  call, with the working shown, and who can host this page themselves as a lead magnet.

## The named scheme

**PM Surya Ghar Muft Bijli Yojana** — central financial assistance for residential rooftop solar
(Ministry of New and Renewable Energy, Government of India), together with your DISCOM's
**net-metering / net-billing** rules, which decide what an exported unit is worth.

The slabs are held as named constants in one place, `SUBSIDY_SCHEME` at the top of
`assets/engine.js`, as: **₹30,000 per kW for the first 2 kW, ₹18,000 per kW for the third kW, with a
cumulative ceiling of ₹78,000** — so 1 kW → ₹30,000, 2 kW → ₹60,000, 3 kW → ₹78,000, and anything
above 3 kW still → ₹78,000. They are published rates as understood in November 2026, labelled
indicative in the code and on the page, and every one of them is overridable from the form
("Enter my own") or by passing your own slab table to the engine.

**Verify the current position on the official portal, <https://pmsuryaghar.gov.in>, before relying
on any figure here.** Subsidy schemes are revised, are subject to eligibility and a registered-vendor
process, and are state-dependent.

Figures deliberately **not** shipped, because they could not be sourced confidently enough to put on
a homeowner's screen:

- State and DISCOM top-up subsidies — state-specific and revised often. There is a field for you to
  enter yours; no state table is built in.
- Any additional assistance for special-category states and union territories.
- The separate group-housing-society / resident-welfare-association stream for common facilities,
  which has its own per-kW rate and ceiling.
- Net-metering, net-billing and banking rates — set by your DISCOM, not by the central scheme.

## Honesty note on scope and accuracy

This is an **indicative estimate, not a quotation and not a subsidy sanction.** Actual generation
depends on your site — irradiance, shading, roof orientation and tilt, dust, temperature and
inverter losses — which is why specific yield (kWh per kWp per year) is an input you set rather than
a number baked in. What you are actually paid for exported units depends on your DISCOM's
net-metering, net-billing or banking rules, which differ by state and by connection type.

The cashflow holds consumption flat, holds the export rate flat (feed-in rates are not indexed to
retail tariffs), discounts nothing to present value, and models no loan, no interest and no inverter
replacement — a real inverter will likely need replacing inside 25 years. The installed cost
default is a placeholder for the small-system market, not a price anyone is offering; replace it
with a real quote. Get a written quotation from a registered vendor before committing money.

## How to run

No build step, no dependencies. Serve the folder over HTTP (the page sets a strict
Content-Security-Policy, so serve it rather than opening the file directly):

```sh
python3 -m http.server 8137
```

Then open <http://localhost:8137/>.

## Tests

The payback maths is a pure module — `assets/engine.js` touches no DOM, no storage and no network —
so it can be exercised on its own. From the repo root:

```sh
node --test
```

The table-driven suite in `tests/engine.test.js` covers the subsidy slabs and their ceiling,
auto-sizing, the self-consumption cap, cashflow consistency, and the awkward cases: zero
consumption, a zero tariff, export-only, a fully subsidised system, and a system that never pays
back — none of which may divide by zero or surface as `NaN` or `Infinity`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The tool and its explainer. No inline styles or scripts. |
| `assets/engine.js` | Pure payback maths and the subsidy constants. No DOM, no network. |
| `assets/calc.js` | Form wiring and rendering. |
| `assets/style.css` | Shared Open MSME stylesheet (light + dark). |
| `assets/accent.css` | One line: this tool's accent colour. |
| `tests/engine.test.js` | Table-driven tests for the engine. |

Part of **Open MSME** — free, open-source tools for micro and small businesses in India and the
Philippines. MIT licensed.
