# Dark Store Analytics Dashboard

Vanilla JS dashboard for dark-store captain performance tracking. Google Sheets as data backend, Chart.js for charts, dark theme.

## Architecture

```
index.html          — Single-page app, tab-based navigation
config.js           — Spreadsheet IDs, column mappings, metric definitions
js/auth.js          — Google Identity Services OAuth (readonly scope)
js/sheets.js        — Sheets API v4 fetch + parse + in-memory cache
js/compute.js       — Pure data transforms: aggregation, flagging, incentives
js/charts.js        — Chart.js wrappers (destroy/recreate pattern)
js/ui.js            — DOM rendering (ui IIFE) + orchestrator (app IIFE)
js/icons.js         — SVG icon constants
css/styles.css      — Full dark theme, CSS variables
```

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

## Common Pitfalls

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
