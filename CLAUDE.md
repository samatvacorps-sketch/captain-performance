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
| Roster | A:F | employee_id(A), name(B), shift(C), start(D), end(E), assigned_off(F) |

**API options**: `valueRenderOption=UNFORMATTED_VALUE, dateTimeRenderOption=SERIAL_NUMBER`
- Dates arrive as serial numbers (days since 1899-12-30). Parsed via `(n - 25569) * 86400 * 1000` ms.
- Durations arrive as fractions of a day. Parsed via `n * 86400` to get seconds.
- The `_dur()` guard `n < 10` means values >= 10 days are dropped — fine for per-day durations.

## Tab IDs

`store-overview` | `captain-deep-dive` | `daily-flags` | `captain-profile` | `tier-analysis` | `inventory-health` | `complaints-deep-dive` | `incentives` | `config-panel`

## Key Patterns

**Adding a new tab:**
1. `index.html`: Add `<button data-tab="xxx">` in `.tab-nav` + `<section id="tab-xxx" class="tab-content hidden">`
2. `ui.js` (ui IIFE): Add `initXxx()`, `renderXxx()`, state vars, export in `return` block
3. `ui.js` (app IIFE): Call `ui.initXxx()` in `refresh()`, add `case 'xxx'` in `_renderCurrentTab()`

**Data flow per tab:** `sheets.getCached()` → `_supervisorFilter()` → date filter → `compute.*()` → render HTML → `_initTableSort()`

**Supervisor exclusion:** IDs `DLES282705`, `DLES280049`, `DLES280053`. Toggle stored in `localStorage('excludeSupervisors')`, default true.

**Flagging pipeline:** `computeStoreStats()` → `computePersonalAvgs()` → `flagSlackers(data, stats, avgs, threshold)` → enriched rows with `flows`, `fnv_audit_rate`, `flags`, `deviations`, `composite_slacker_score`. Note: `audit_hours_per_rack` is NOT pre-computed on enriched rows — it is derived on-demand in `_computePeriodStoreStats` and `_groupByCaptain` using the `auditRacksMap`. Access flagged data via `app.getFlaggedData()`.

**Flow detection:** `computeFlowFlags(row)` → `{ is_picking, is_putting, is_audit, is_fnv }` based on whether the corresponding `*_active_time > 0`.

**auditRacksMap pattern:** Wherever audit rack counts are needed (Tier Analysis, Captain Deep Dive, `_computePeriodStoreStats`), a `Map<"employeeId_YYYY-MM-DD", rackCount>` is built from `sheets.getAuditCached()` filtered to the current date window, and used in preference to `row.racks_audited` (Daily Metrics col H). Fallback to `row.racks_audited` only when no Audits-sheet entry exists for that captain+date.

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

**Incentives table:** TOTAL row lives in `<tfoot>` (not `<tbody>`) so `_initTableSort` never touches it.

## Captain Deep Dive

**Date mode scoring:** When `_deepDiveDateMode = true` (custom date pickers or T-1/T-2), `periodType` is always `'W'` — uses period-relative SD-based scoring, never `'D'`. This prevents the personal-avg gate from making flagging too conservative for single-day views.

**`avg_total_time_per_order`** in `_summarise()` uses a weighted average helper: `sum(time × orders) / sum(orders)` over picking-flow rows only. Matches `computePickingIncentives` exactly.

## Captain Deep Dive — Putting Flow Table

Columns: Captain | Score | Putaway Qty | **Putter Hours** | Items Put Away/Hr (actual | personal | store). `captain.total_putter_hours` is computed in `_groupByCaptain` by summing `putter_active_time` for putting-flow rows. Sortable via `put_hours` key in `_getSortValue`.

## Inventory Health — Captain Table

`captainPerf` (from `computeAuditAggregations`) now includes captains who had `auditor_active_time > 0` but **zero racks** in the Audits sheet for the period. These appear with `totalRacks: 0`, `hrPerRack: null` (shown as `—`), and are excluded from the efficiency leaderboard (`filter(c => c.totals.hrPerRack !== null)`) but visible in the main table.

## Tier Analysis

**Shift grouping (Time-Based mode):**
- Uses a **date-aware rosterMap**: for each captain, picks the most recent roster entry whose `start` (col D, stored as Google Sheets serial string) is on or before the period's reference date. Prevents stale/future assignments from being counted.
- Only rows with actual flow activity (`is_picking || is_putting || is_audit || is_fnv`) are included. Rows with no flow = captain was present but didn't work — excluded.
- `_rosterSerial(s)` helper: `parseFloat(s) > 1000 ? new Date(Math.round((n-25569)*86400000)) : null`

**Experience-Based mode:** Same flow-activity guard applies.

**Shift count popover:** Clicking a Morning/Evening/Night (or New/Experienced/Senior) count opens a dark popover listing all captain names + IDs for that group. Implementation:
- `_tierGroupRows` module var — snapshot of `groupRows` set each render
- `_showShiftPopover(anchor, captains, label)` — appends `#tier-shift-popover` to `<body>`, positions below anchor, dismisses on outside click
- Count span gets class `tier-count-clickable` + `data-group` / `data-label` attributes when `captainCount > 0`
- Captain name field: `r.employee_name` (not `r.name`)

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

## CSS Quick Reference

Tables: `.table-wrapper > .data-table` with `th` (uppercase, sortable) and `td`.
Cards: `.stat-cards-row > .stat-card` with `.stat-label` + `.stat-value`.
Sections: `.inv-section`, `.tiers-section-header` + `.tiers-section-pip` + `.tiers-section-title`.
Cell colors: `.cell-green`, `.cell-yellow`, `.cell-red`, `.cell-dark-red`.
Row states: `.row-flagged`, `.row-serial`, `.incentive-zero`.
Layout: `.flags-page-header` (title + controls), `.flags-date-strip` (filters).
Tier popover: `.tier-shift-popover`, `.tier-popover-header`, `.tier-popover-count`, `.tier-popover-list`, `.tier-popover-name`, `.tier-popover-id`, `.tier-count-clickable`.
