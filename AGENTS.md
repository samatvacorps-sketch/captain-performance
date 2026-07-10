# Dark Store Analytics Dashboard

Vanilla JS dashboard for dark-store captain performance tracking. Google Sheets as data backend, Chart.js for charts, dark theme. A phased redesign is underway — see `REDESIGN.md` for locked decisions and the build plan (Phase 0 foundations landed 2026-07).

## Architecture

```
index.html            — Single-page app, tab-based navigation; script order matters
config.js             — Spreadsheet IDs, column mappings, metric definitions
js/config-store.js    — `cfg` global: sheet Config tab > localStorage > defaults
js/auth.js            — Google Identity Services OAuth (readonly scope)
js/sheets.js          — Sheets API v4 fetch + parse + in-memory cache + IndexedDB session cache
js/compute.js         — Pure data transforms: aggregation, flagging, incentives, pooled KPIs
js/charts.js          — Chart.js wrappers (destroy/recreate pattern)
js/shared/core.js     — cross-tab state: thresholds, weights, supervisor filter, theme, tab switching
js/shared/periods.js  — `periods` global: T-1/T-2, full-span, preset parsing helpers
js/shared/tables.js   — table sort/filter machinery, badges, captain cells
js/shared/format.js   — _fmt, _esc, _isoDateStr, billing-month helpers
js/tabs/*.js          — one file per tab (store-overview, deep-dive, attendance, tier-analysis,
                        captain-profile, config-panel, inventory-health, key-metrics,
                        complaints, incentives)
js/ui-registry.js     — assembles the public `ui` object from the modules; sets window.ui
js/app.js             — orchestrator (`app` IIFE): cache-first init, parallel refresh; sets window.app
js/icons.js           — SVG icon constants
css/styles.css        — Full dark theme, CSS variables
```

**Split-module convention (Phase 0):** the former 6,400-line `ui.js` was split verbatim. Top-level declarations in `js/shared/*` and `js/tabs/*` are intentionally **global** (classic scripts, no build step) so tab modules cross-call each other and the shared helpers at runtime. Keep new top-level names unique across these files and never name one after a `window` built-in. `ui` and `app` are also bound onto `window` explicitly (inline `onclick` handlers and `auth.js`'s `if (window.app) app.init()` bootstrap need real window properties — a bare top-level `const` is only a global lexical binding).

**Startup flow:** `auth.js` → `app.init()` → `sheets.loadFromCache()` (IndexedDB, previous session's parsed rows — Dates survive structured clone) → instant render + `.stale-banner` ("Showing data from …") → `app.refresh({ background: true })`. `app.refresh()` fetches all seven ranges (6 data sheets + Config) in a single `Promise.all`; `auth.getToken()` shares one in-flight token request across concurrent callers. Foreground refresh (the header button) still shows the blocking loader; background refresh never does.

## Data Sources (Google Sheets)

| Sheet | Range | Key columns |
|-------|-------|-------------|
| Daily Metrics | A:V | date(A), employee_id(B), name(C), checkout_orders(D), putaway_qty(F), racks_audited(H), total_active_time(I), picker/putter/auditor_active_time(J-L), total_time_per_order(Q), ppi(R), iph(S), complaints(T-V) |
| Audits | A:E | employee_id(A), name(B), date(C), month(D), audit_codes(E, comma-separated rack codes) |
| Complaints | A:O | cycle, dates, order/employee IDs, product info, complaint_category, rca, in_store |
| Roster | A:G | employee_id(A), name(B), shift(C), start(D), end(E), assigned_off(F), employment_type(G: FT/PT) |
| PNAs | A:Z | resolved by header: `ScheduledDate`, `order_id`, `picker_id`, `pna_qty` (`PNA_HEADERS`). Powers Fill Rate. Merged by `pna-merge.gs`. |
| Item Variance | A:Z | merged by `item-variance-merge.gs`; loaded but **not yet used** (on hold) |
| In-store Time | 'In-store'!A:Q | **separate spreadsheet** `INSTORE_SPREADSHEET_ID`; resolved by header (`INSTORE_HEADERS`). Powers In-store SLA. |
| Config | A:C | **business config** (key \| value \| notes). Dotted keys (`slaTargets.2026-07.instore.baseline`) or JSON blobs (`complaintSlaCategories`). Rows starting `#` are ignored. Created by `google-apps-script/config-setup.gs`. Missing tab is fine — falls back to localStorage/defaults. |
| Racks | A:A | **master rack list** (every rack code in the store; header row + `#` rows ignored, deduped, uppercased). Powers Inventory Health coverage % + stale-rack queue. Missing tab degrades gracefully. |

**Config resolution (`cfg` global, js/config-store.js):** sheet Config tab > localStorage > code defaults. Wired consumers: `_getSlaTargets` (`slaTargets.<cycle>.<metric>.<tier>`), `_getComplaintSlaCategorySet` (`complaintSlaCategories`), `_getSlabOverride` (`incentiveSlabs.<YYYY-MM>`), `_supervisorFilter` (`supervisorIds` replaces `CONFIG.SUPERVISOR_IDS` when set). Analysis knobs (flow thresholds, productivity weights, staff divisor) intentionally stay localStorage-only. The Config panel shows which source is active; sheet values win and the panel says so.

**API options**: `valueRenderOption=UNFORMATTED_VALUE, dateTimeRenderOption=SERIAL_NUMBER`
- Dates arrive as serial numbers (days since 1899-12-30). Parsed via `(n - 25569) * 86400 * 1000` ms.
- Durations arrive as fractions of a day. Parsed via `n * 86400` to get seconds.
- The `_dur()` guard `n < 10` means values >= 10 days are dropped — fine for per-day durations.

**`dateStr` vs `dateIsoStr`:** Each parsed Daily Metrics row includes both:
- `dateStr` — raw serial number as string (used by period `'D'` filter, active-day tracking, aggregation inputs)
- `dateIsoStr` — YYYY-MM-DD formatted string (used as key in `auditRacksMap` and any lookup against Audits sheet rows, which store dates as YYYY-MM-DD)

Never use `dateStr` for `auditRacksMap` lookups — it will always miss because Audits rows use YYYY-MM-DD.

## Tab IDs

`store-overview` | `key-metrics` | `captain-deep-dive` | `attendance` | `captain-profile` | `tier-analysis` | `inventory-health` | `complaints-deep-dive` | `incentives` | `config-panel`

## Key Metrics (SLA Command Center)

Tracks the merchant SLA targets per billing cycle (26th → 25th). Three-tier targets (Baseline / SLA 1 / SLA 2) per metric, editable in Config, stored in `localStorage('slaTargets')` keyed by cycle `"YYYY-MM"`.

- **In-store time SLA**: `% of orders with instore_seconds <= 150 AND ipo <= 6`, denominator = IPO≤6 orders only. Computed by `compute.computeInstoreSLA(instoreWin, null)` from the order-level in-store sheet. **The in-store feed lives in its own spreadsheet** (`CONFIG.INSTORE_SPREADSHEET_ID`, tab `'In-store'!A:Q`) because it is too large for the main book; `sheets.fetchInstoreData` reads from that book, falling back to the main `SPREADSHEET_ID` if the id is unset. Columns resolved by header name (`INSTORE_HEADERS`). Source tabs merged by `google-apps-script/instore-time-merge.gs`.
- **Complaints SLA**: qualifying complaint rows ÷ checkout orders (picked orders are the agreed proxy for delivered orders). Qualifying = all categories except MDND / Poor Quality / QNG (`_KM_EXCLUDE_RE`), overridable via Config checklist (`localStorage('complaintSlaCategories')`).
- **Fill rate**: `compute.computeFillRate(pnaRows, missingRows, checkoutOrders)`. Order-level: an order is "not in full" if it had ≥1 PNA OR ≥1 `item_missing` complaint. Affected = the **union** of distinct `order_id`s across both sources (an order counts once regardless of how many PNAs/missing items). `pct = (checkoutOrders - affected) / checkoutOrders`. PNAs come from `sheets.getPnaCached()` (the `PNAs` tab in the main book, merged by `google-apps-script/pna-merge.gs`, columns resolved by header via `PNA_HEADERS`). Rendered by `_kmFillRateCard` (KM scorecards) and `_ovFillRateCard` (overview band); both fall back to a "NO DATA" placeholder when the window has no PNA/missing rows. Targets default `{baseline:99.32, sla1:99.56, sla2:99.66}`.

Page layout in `renderKeyMetrics` (top → bottom): scorecards (with **delta chips** vs the preceding window of equal length) → **Yesterday strip** (`_kmYdayStrip`, T-1 readout with deltas vs T-2, weakest hour, "Open T-1" button via `ui.kmJumpT1()`) → **Cycle Pace** (`_kmPaceSection`, projection at last-7-day form + per-tier "needs ≥ X%/day" / "room for N more complaints"; only rendered while the window's end date is today or later) → **Daily Trend charts** (`charts.renderKmTrendChart`, line + dashed target lines; skipped when <2 days) → in-store drill-down (hour heatmap, stage bars, IPO bands, **day-of-week** `_kmWeekdayCard`, **dropzone impact** `_kmDropzoneCard`, slowest-pickers table) → complaints drill-down.

**`_kmSnapshot(startMs, endMs)`** — shared helper returning `{ instore: {met, denom, pct}, compl: {items, orders, pct}, fill: {pct, affected, pnaOrders, missOrders, inFull, checkoutOrders} }` over any window, reading straight from the sheet caches (supervisor-filtered, qualifying complaints only). Used by scorecard deltas, the Yesterday strip, cycle-pace recent form, and the Store Overview SLA band. Keep all SLA math flowing through it (or `computeInstoreSLA` / `computeFillRate`) so numbers agree across tabs.

**Item Variance** (`PNAs` sibling tab, merged by `google-apps-script/item-variance-merge.gs`) is loaded into the book but **not yet wired into the dashboard** — intentionally on hold.

## Store Overview — SLA band

`_renderOverviewSlaBand()` fills `#overview-sla-band` (index.html, above the stat cards) with cycle-to-date SLA cards pinned to the **current** billing cycle — it deliberately ignores the overview date filter. Cards are `<button class="ov-sla-card">`s that call `app.switchTab('key-metrics')`. Errors during `app.refresh()` surface via the `_showError` toast (`.error-toast`), not `alert()`.

## Key Patterns

**Adding a new tab:**
1. `index.html`: Add `<button data-tab="xxx">` in `.tab-nav` + `<section id="tab-xxx" class="tab-content hidden">`
2. `ui.js` (ui IIFE): Add `initXxx()`, `renderXxx()`, state vars, export in `return` block
3. `ui.js` (app IIFE): Call `ui.initXxx()` in `refresh()`, add `case 'xxx'` in `_renderCurrentTab()`

**Data flow per tab:** `sheets.getCached()` → `_supervisorFilter()` → date filter → `compute.*()` → render HTML → `_initTableSort()`

**Supervisor exclusion:** IDs `DLES282705`, `DLES280049`, `DLES280053`. Toggle stored in `localStorage('excludeSupervisors')`, default true.

**Flagging pipeline:** `computeStoreStats()` → `computePersonalAvgs()` → `flagSlackers(data, stats, avgs, threshold)` → enriched rows with `flows`, `fnv_audit_rate`, `flags`, `deviations`, `composite_slacker_score`. Note: `audit_hours_per_rack` is NOT pre-computed on enriched rows — it is derived on-demand in `_computePeriodStoreStats` and `_groupByCaptain` using the `auditRacksMap`. Access flagged data via `app.getFlaggedData()`.

**Flow detection:** `computeFlowFlags(row)` → `{ is_picking, is_putting, is_audit, is_fnv }` based on whether the corresponding `*_active_time > 0`.

**auditRacksMap pattern:** Wherever audit rack counts are needed (Tier Analysis, Captain Deep Dive, `_computePeriodStoreStats`), a `Map<"employeeId_YYYY-MM-DD", rackCount>` is built from `sheets.getAuditCached()` filtered to the current date window, and used in preference to `row.racks_audited` (Daily Metrics col H). Fallback to `row.racks_audited` only when no Audits-sheet entry exists for that captain+date. Keys are always built with `r.dateIsoStr` (never `r.dateStr`).

## Quick Select — T-1 / T-2

All 5 tabs with a Quick Select dropdown (Store Overview, Captain Deep Dive, Tier Analysis, Inventory Health, Complaints) include:
- **T-1 (Yesterday)** — sets both date pickers to `today - 1`
- **T-2 (Day before yesterday)** — sets both date pickers to `today - 2`

These options set `_xxxDateMode = true` and call the tab's render function directly (bypassing the normal preset path). The Deep Dive handler also resets `_ddFilter = 'all'`.

## Incentive Business Rules

**Incentive periods are calendar months / ISO weeks by policy** (confirmed 2026-07) — do NOT "fix" them to billing cycles; billing cycles apply to merchant SLAs only. The payroll CSV export (`ui.exportIncentivesCsv`) is the register of record: weekly picking + audit + attendance bonus + grand total per captain.

**Picking (weekly):** Uses `app.getFlaggedData()` filtered by `flows.is_picking`. **Weighted avg** `total_time_per_order` (seconds) — `sum(time × orders) / sum(orders)`. Threshold on weekly `checkout_orders` sum.
- 400+ orders/week: <70s=₹500, <75s=₹400, <80s=₹300, <90s=₹250, <110s=₹125
- 800+ orders/week: <75s=₹500, <80s=₹400, <85s=₹300, <95s=₹250, <120s=₹125

**Audit (monthly):** Uses `sheets.getAuditCached()` with `audit_codes.length` for rack counts. Cumulative tiers:
- First 40 racks: ₹30/rack, next 40 (41-80): ₹40/rack, beyond 80: ₹50/rack

**Attendance bonus (monthly):** Uses Daily Metrics active hours + effective-dated Roster rows. Roster col G `employment_type` must be `FT` or `PT`; missing type pays ₹0 with reason `Needs roster type`.
- Base amounts: FT=₹1000/month, PT=₹500/month.
- Prorated by roster-active days: `sum(baseForType / daysInMonth)` over active days, rounded after summing.
- Minimum tenure: 7 roster-active days.
- Allowed offs: `round(4 * activeDays / daysInMonth)`. Actual `Off` days must be <= allowed offs.
- `Unplanned Leave` disqualifies the month. FT working days require full-day credit; PT working days require half-day-or-better credit.
- Mixed FT/PT months are split by effective-dated roster segments, e.g. 15 PT days + 15 FT days in a 30-day month = ₹750 if eligible.

**Incentives table:** TOTAL row lives in `<tfoot>` (not `<tbody>`) so `_initTableSort` never touches it.

## Captain Deep Dive

**Date mode scoring:** When `_deepDiveDateMode = true` (custom date pickers or T-1/T-2), `periodType` is always `'W'` — uses period-relative SD-based scoring, never `'D'`. This prevents the personal-avg gate from making flagging too conservative for single-day views.

**`avg_total_time_per_order`** in `_summarise()` uses a weighted average helper: `sum(time × orders) / sum(orders)` over picking-flow rows only. Matches `computePickingIncentives` exactly.

## Captain Deep Dive — Tier Grouping Toggle

A **Group** button in the Deep Dive header cycles through three modes via `_ddTierMode`:
- `'off'` → `'shift'` → `'experience'` → `'off'`
- Button labels: `Group: Off` / `Group: Shift-Based` / `Group: Experience-Based`
- Button style: `.tier-mode-btn.dd-tier-off` (grey/muted) when off; active style otherwise

When a mode is active, each flow table (Picking, Putting, Audit, FNV) inserts colored **divider rows** between tier groups using `_groupAndBuildRows(rows, tierMap, buildRow, colCount)`:
- Shift mode groups: Morning / Evening / Night (pip colors: `#f59e0b` / `#818cf8` / `#34d399`)
- Experience mode groups: New / Experienced / Senior (pip colors: `#60a5fa` / `#f59e0b` / `#a78bfa`)
- Divider row HTML: `.dd-tier-divider td` with `.dd-tier-pip` colored bar + label
- Column spans: Picking=9, Putting=6, Audit=6, FNV=3

**`captainTierMap`** — built in `renderDeepDive`, a `Map<employee_id, tierLabel>` using the same row-level classification as Tier Analysis:
- Shift mode: `getShiftOnDate(empId, refDate)` from date-aware roster history
- Experience mode: `getExpTierOnDate(empId, refDate)` binary search on sorted active-day lists

**`captainAuditRacks`** — `Map<employee_id, totalRacks>` summed directly from `sheets.getAuditCached()` filtered to the period's date range. Used in `_groupByCaptain` for `total_racks_audited` (direct Audits sheet aggregation, not per-row auditRacksMap). Matches Inventory Health behavior. Fallback: `0` if captain not in map.

## Captain Deep Dive — Putting Flow Table

Columns: Captain | Score | Putaway Qty | **Putter Hours** | Items Put Away/Hr (actual | personal | store). `captain.total_putter_hours` is computed in `_groupByCaptain` by summing `putter_active_time` for putting-flow rows. Sortable via `put_hours` key in `_getSortValue`.

## Captain Deep Dive — Audit Flow Table

`captain.total_racks_audited` is sourced from `captainAuditRacks` (direct Audits sheet sum) — NOT from per-row auditRacksMap. After computing `total_racks_audited` and `total_auditor_hours`, `avgValues['audit_hours_per_rack']` is overridden: `total_auditor_hours / total_racks_audited` (null if either is 0). This ensures the actual/store HPR columns populate correctly instead of showing `—`.

## Inventory Health — Captain Table

`captainPerf` (from `computeAuditAggregations`) now includes captains who had `auditor_active_time > 0` but **zero racks** in the Audits sheet for the period. These appear with `totalRacks: 0`, `hrPerRack: null` (shown as `—`), and are excluded from the efficiency leaderboard (`filter(c => c.totals.hrPerRack !== null)`) but visible in the main table.

## Tier Analysis

**Shift grouping (Shift-Based mode):**
- Uses a **date-aware rosterMap**: for each captain, picks the most recent roster entry whose `start` (col D, stored as Google Sheets serial string) is on or before the period's reference date. Prevents stale/future assignments from being counted.
- Only rows with actual flow activity (`is_picking || is_putting || is_audit || is_fnv`) are included. Rows with no flow = captain was present but didn't work — excluded.
- `_rosterSerial(s)` helper: `parseFloat(s) > 1000 ? new Date(Math.round((n-25569)*86400000)) : null`

**Experience-Based mode:** Same flow-activity guard applies.

**Audit Flow Analysis section:** `_buildTiersHTML` renders a 4-column table (Tier, Total Racks, Audit Hours, Avg Hr/Rack) after the Putting Flow section. `_tierMetrics(rows, auditRacksMap)` computes `totalRacks` via `auditRacksMap` (fallback to `row.racks_audited`), `totalAuditHours` from `auditor_active_time`, and `avgHPR = totalAuditHours / totalRacks`. `renderTiersView` builds `auditRacksMap` from `sheets.getAuditCached()` filtered to the period's date strings, then passes it to each `_tierMetrics` call.

**Putting Qty percentages:** Total Qty Put shows each tier's share of the store total (same pattern as Total Orders Picked).

**Weighted averages in `_tierMetrics`:** Avg Delay/Pick/Bill Time use `wAvg(rows, valueKey, weightKey)` helper (weighted by `checkout_orders`), not simple mean. Matches `computePickingIncentives` logic.

**Historical averages:** Each metric cell shows an all-time baseline sub-label (`.tiers-hist-avg`) for comparison. Computed in `renderTiersView` via `histGroupStats`:
- Uses **all data** (not just the selected period) from `sheets.getCached()`, filtered to exclude March (month 2), September (month 8), and October (month 9) as outlier months.
- Classification is **row-level**: each historical row is classified into a tier at the time of that row using `getExpTierOnDate()` (binary search) or `getShiftOnDate()` (roster lookup). Prevents now-Senior captains' early-career rows from inflating the Senior all-time average.
- `fullAuditRacksMap` built from all Audits rows (not filtered to period) for historical HPR.
- Historical stats are locked — they do not change when the period date pickers change.
- All-time order-share % is also shown under Total Orders Picked for each tier.

**Shift count popover:** Clicking a Morning/Evening/Night (or New/Experienced/Senior) count opens a dark popover listing all captain names + IDs for that group. Implementation:
- `_tierGroupRows` module var — snapshot of `groupRows` set each render
- `_showShiftPopover(anchor, captains, label)` — appends `#tier-shift-popover` to `<body>`, positions below anchor, dismisses on outside click
- Count span gets class `tier-count-clickable` + `data-group` / `data-label` attributes when `captainCount > 0`
- Captain name field: `r.employee_name` (not `r.name`)

## Complaints Deep Dive — Period Summary Table

`_renderComplaintSummaryTable(periodData)` renders a sortable 11-column table injected into `#compl-summary-table` (placed between the stat cards and Zone 1 Trends). Columns:

| # | Column | Formula |
|---|--------|---------|
| 1 | Period | `d.label` |
| 2 | Total Orders | `d.totalOrdersPicked` |
| 3 | Total Complaints | `d.totalComplaints` |
| 4 | Out-Store Complaints | `d.inStoreNo` |
| 5 | In-Store Complaints | `d.inStoreYes` |
| 6 | Complaint % | `totalComplaints / totalOrders` |
| 7 | Out-Store Complaint % | `inStoreNo / totalOrders` |
| 8 | In-Store Complaint % | `inStoreYes / totalOrders` |
| 9 | Out-Store Missing (order level) | `d.missingOutStore` |
| 10 | In-Store Missing (order level) | `d.missingInStore` |
| 11 | In-Store Missing % | `missingInStore / totalOrders` |

`missingInStore` / `missingOutStore` — unique order-ID counts for `complaint_category = 'item_missing'` rows split by `in_store`. Pre-computed in `computeComplaintAggregations` using Sets per ISO week / calendar month, then stored on each weekly/monthly bucket and on `storeSummary.totals`.

## compute.js — Week / Month helpers

**`getWeekKeysForMonth(data, monthKey)`:** Uses `_weekStart(row.date)` (Monday of the row's ISO week) to determine month membership — not `row.date` itself. Ensures weeks straddling month boundaries are assigned to the month their Monday falls in.

## Verification

- `node tools/smoke-load.js .` — simulates the browser loading every `<script src>` from index.html in order (shared context, stub DOM/storage) and probes the public API. Catches load-order breaks, TDZ errors, and global-name collisions after any module change.
- `node tools/test-compute.js` — 17 unit tests over the payroll/SLA-grade logic (fill rate union, in-store SLA thresholds, picking slabs + weighted averages, audit tiers + cap, all attendance-bonus rules, pooled KPIs, pace projection, robust scoring gates, billing-cycle boundaries, Monday week rule). **Run after any compute.js change — this is money math.**
- Plus `node --check` on touched files.

## Redesign features (Phases 1–5, landed 2026-07)

- **Morning Briefing** (js/tabs/store-overview.js): SLA band cards carry pace lines (`compute.projectCyclePace` — same math as KM Cycle Pace); KPI cards are pooled with delta chips + inline SVG sparklines; **exceptions feed** (`_renderOverviewExceptions`) is always T-1/cycle-based regardless of the date filter; the 10 bento charts are visible by default with a "Hide charts" toggle (`localStorage('overviewChartsOpen')`; charts only render while visible — hidden canvases misbehave).
- **Robust captain scoring** (`compute.computeCaptainScores`): window-level, volume-gated (20 orders / 50 put qty / 5 racks / 50 FNV qty, min cohort 4 — overridable via sheet Config `scoring.*`), median/MAD z capped at ±4, positive = worse; composite = Σ max(0, z). The old per-day mean/SD `flagSlackers` pipeline still powers legacy views; new features use the robust scorer.
- **Coaching list** (deep-dive.js `_buildCoachingCard`): top 5 by composite ≥ 1.5 with plain-language reasons and trend vs the preceding window of equal length.
- **Captain 360** (captain-profile.js `openCaptain360` / `_build360Section`): every `_captainCell` in the dashboard drills through to it. Shows window SLA contribution, PNA involvement, month-to-date incentives, coaching signals.
- **Incentive nudges** (incentives.js `_buildIncentiveNudges`): current week/month near-misses only (next slab within 15s, order thresholds within reach, audit tier boundaries within 12 racks). **CSV export** `ui.exportIncentivesCsv()` = payroll register incl. attendance bonus.
- **Shift adherence** (attendance.js `_renderShiftAdherence`): rostered start (Roster col E, day-fraction or "HH:MM") vs first in-store activity (`act_ms` on parsed in-store rows). Pickers only; ±6h outliers excluded; grace via Config `adherence.graceMin` (default 30).
- **Inventory coverage** (inventory-health.js `_renderRackCoverage`): needs the `Racks` tab (col A = master rack codes) in the main book; window coverage % + stale-rack queue (Config `inventory.staleDays`, default 30). Staleness uses ALL audit history, coverage uses the window.
- **Complaints**: product repeat-offender table (2+ items, unique orders) and an "Unusual Days" Poisson control band (mean + 2·√mean over the window; needs ≥7 days).
- **Data Health** (config-panel.js `_buildDataHealthCard`): fetched-vs-parsed counts per sheet (`sheets.getParseStats()` — live only after a network refresh, not from IndexedDB cache), cross-sheet unmatched-ID counts, missing days in the daily span, duplicate in-store order rows.

## Common Pitfalls

- **Overview stat cards** use `compute.computeWindowKpis(filteredRows)` — pooled, volume-weighted KPIs over raw daily rows. Do NOT average period-bucket averages (a 200-order week would weigh the same as a 6,000-order week). Note `avgTotalTimePerOrder` here is the weighted col-Q average (same definition as incentives/Deep Dive), while `_summarise().avg_total_time_per_order` is a composed stage-sum including in-store ready-to-assign — different populations, different numbers; unify remaining call sites in Phase 1.
- **T-1/T-2 quick-selects** go through `periods.setDayPair(startId, endId, daysAgo)` (js/shared/periods.js). Don't re-inline the date math in tab handlers.

- **Rack counts**: Daily Metrics `racks_audited` (col H) can differ from Audits sheet `audit_codes.length`. All rack-dependent metrics (Tier Analysis, Captain Deep Dive actual/store HPR, `_tierMetrics`) now use the `auditRacksMap` pattern — see above.
- **`audit_hours_per_rack` on rows**: Not pre-computed in `flagSlackers` anymore. Compute it on-demand: `(auditor_active_time / 3600) / racksFromAuditMap`.
- **`aggregateWeekly`/`aggregateMonthly`** take only `data` (daily rows). Complaint and audit aggregations are handled separately by `computeAuditAggregations` / `computeComplaintAggregations`.
- **Date filtering**: Audit tab "All Time" range merges dates from both Audits sheet AND Daily Metrics `auditor_active_time > 0` rows (fix for under-counting hours).
- **Duration parsing**: `_dur()` returns seconds. `formatDuration(seconds)` renders as `m:ss` or `h:mm:ss`.
- **Week keys**: `_isoWeekKey(date)` returns `"YYYY-Wnn"` (ISO 8601). Weeks can span month boundaries.
- **Cache invalidation**: Render functions use cache keys like `${startVal}_${endVal}_${dataLength}`. Add all varying inputs to avoid stale renders.
- **Captain name field**: Daily Metrics rows use `employee_name` (not `name`). Always reference `r.employee_name`.
- **auditRacksMap keys**: Always use `r.dateIsoStr` (YYYY-MM-DD) when building map keys from Daily Metrics rows. `r.dateStr` is a raw serial number and will never match Audits-sheet date strings.
- **Historical classification**: Always classify rows at the time of the row (row-level binary search / roster lookup), not at the current period's reference date. Otherwise, now-Senior captains' early rows get mis-bucketed into Senior all-time stats.

## CSS Quick Reference

Tables: `.table-wrapper > .data-table` with `th` (uppercase, sortable) and `td`.
Cards: `.stat-cards-row > .stat-card` with `.stat-label` + `.stat-value`.
Sections: `.inv-section`, `.tiers-section-header` + `.tiers-section-pip` + `.tiers-section-title`.
Cell colors: `.cell-green`, `.cell-yellow`, `.cell-red`, `.cell-dark-red`.
Row states: `.row-flagged`, `.row-serial`, `.incentive-zero`.
Layout: `.flags-page-header` (title + controls), `.flags-date-strip` (filters).
Tier popover: `.tier-shift-popover`, `.tier-popover-header`, `.tier-popover-count`, `.tier-popover-list`, `.tier-popover-name`, `.tier-popover-id`, `.tier-count-clickable`.
Key Metrics: `.km-score-card` (+ `.km-tier-sla2/sla1/baseline/below/na`), `.km-delta-chip` (+ `.km-delta-good/bad/flat`), `.km-yday-strip`, `.km-pace-card` (+ `.km-pace-locked/lost`), `.km-chart-wrap` (fixed-height chart parent — required because trend charts use `maintainAspectRatio:false`), `.km-hour-card`, `.km-stage-row`.
Overview SLA band: `.ov-sla-band`, `.ov-sla-grid`, `.ov-sla-card` (button, tier classes shared with km).
Error toast: `.error-toast`.
Historical sub-labels: `.tiers-hist-avg` (font-size 0.68rem, muted color, opacity 0.65).
Deep Dive tier dividers: `.dd-tier-divider td` (uppercase label row), `.dd-tier-pip` (4×14px colored vertical bar).
Deep Dive tier toggle: `.tier-mode-btn.dd-tier-off` (grey/muted style when grouping is off).
