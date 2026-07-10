# Dashboard Redesign Blueprint

Decisions locked 2026-07-06 with Vansh:

- **Audience**: Vansh (analyst/owner) + store supervisors, who will mostly use phones.
- **Priorities** (all in scope, in lead order): 1) merchant SLA compliance, 2) captain coaching, 3) payroll/incentive accuracy, 4) early warning/forecasting.
- **Stack**: keep vanilla JS + Google Sheets + GIS OAuth. No build step, no backend. Restructure within it.
- **Config**: moves from localStorage to a `Config` tab in the main spreadsheet (dashboard reads it; edits happen in the sheet). localStorage becomes offline fallback only.

---

## Part 1 — Cross-cutting findings from the code review

### Architecture

1. **ui.js is a 6,386-line monolith** — ~200 functions, 10 tabs, all module-level state in two IIFEs. compute.js by contrast is clean and pure. Split ui.js into `js/tabs/*.js` + `js/shared/*.js` (plain IIFEs + script tags — no build step required).
2. **Sequential force-fetch of 6 sheets on every refresh** (`app.refresh()`, ui.js:6272–6277). The in-store book alone is huge. `Promise.all` alone should cut load time several-fold. No client-side persistence between sessions — every page open on a phone refetches everything.
3. **The period-picker pattern is duplicated 7 times** (overview, deep dive, tiers, inventory, KM, complaints, profile), each with its own preset init, T-1/T-2 handling (~20 call sites), `_xxxDateMode` flag, and cache-key discipline. This is the root cause of the "cache invalidation" pitfalls documented in CLAUDE.md. One shared PeriodPicker.
4. **Metric definitions diverge across tabs.** "Total Time/Order" on Store Overview is `avg_ready_to_assign (in-store sheet) + 3 stage averages (daily sheet)` — a composed estimate over two different populations — while Deep Dive and Incentives use the weighted average of column Q. Same label, different numbers. `_kmSnapshot` was built to prevent exactly this for SLAs; generalize it into a metric registry all tabs read from.
5. **Config in localStorage** (SLA targets, slabs, complaint categories, thresholds, attendance overrides) — per-browser, so phone and laptop disagree. Being fixed per decision above. Note: attendance overrides are *data*, not config — they need a write-back path (Apps Script) or an export, not just a sheet read.

### Math & statistics

6. **Overview stat cards average the bucket averages unweighted** (ui.js:430–433): a 200-order week counts the same as a 6,000-order week.
7. **Flagging is noisy z-scores on tiny samples**: per-day mean/SD across ~5–15 active captains, flags flip day to day. The personal-average gate uses an all-time mean that *includes the current row and all future rows* (admitted simplification in `computePersonalAvgs`). `composite_slacker_score` is a raw count of flags — a 1.1 SD miss counts the same as a 3 SD miss.
8. **No minimum-volume gates anywhere** — a picker with 3 orders can be flagged "Critical".
9. Incentive math itself is correct and consistent (weighted averages match Deep Dive). Open question: incentives run on calendar months while SLAs run on billing cycles — confirm that's policy, not accident.

### Data quality & trust

10. Parsers drop rows silently; `_dur()` silently zeroes values ≥ 10 days; no surface shows what was discarded.
11. **ID hygiene is inconsistent**: `_cleanEmployeeId` (strip non-ASCII, uppercase) exists only in the attendance path. All other joins (in-store `picker_id` ↔ daily `employee_id` ↔ roster) are exact-match — mismatches silently orphan rows.
12. No visibility into missing days, duplicate order_ids, or roster gaps. → **Data Health panel** (Phase 5).

---

## Part 2 — Per-tab review & redesign

### 1. Store Overview → "Morning Briefing"
**Today**: SLA band (good) + 4 stat cards + 10 bento charts + 18-column table. A chart wall with no hierarchy; cards have no deltas; charts answer "what happened", not "what needs attention".
**Redesign**: phone-first briefing page:
- Cycle SLA band (keep) extended with **room-to-breach** per SLA ("can afford 14 more complaints / 220 more slow orders this cycle and still hit SLA 1") — generalizing what `_kmPaceSection` already computes.
- KPI cards with delta chips vs preceding window + tiny sparklines (reuse `_kmDeltaChip` / `_kmSnapshot`).
- **Exceptions feed**: auto-generated list — SLA pace at risk, yesterday's worst hour, newly flagged captains, complaint spike vs control band, zero-output shifts.
- Charts demoted into a collapsible "Explore" section; 18-col table stays but below the fold.

### 2. Key Metrics (SLA Command Center)
Strongest tab — keep the skeleton (scorecards → yesterday → pace → trends → drill-downs). Improvements: targets read from sheet Config; add an IPO>6 monitor card (excluded population can degrade unseen); complaint drill by repeat products; move day-of-week/dropzone cards into a collapsible advanced block; feed its computed risks into the home exceptions feed.

### 3. Captain Deep Dive → Captain Scoring + Coaching List
**Today**: SD flags vs daily store stats + personal-avg gate; Group toggle cycles 3 modes; "slacker" framing.
**Redesign**:
- Volume-gated robust scoring: percentile-vs-store within the window (median/MAD, not mean/SD), minimum 20 orders / 2 hours per flow before scoring.
- Severity-weighted composite + week-over-week trend arrow per captain.
- **Coaching list output**: top 3–5 with plain-language reasons ("Billing time 2.1× store median, 3 days running; 480 orders affected") — this is what a supervisor acts on.
- Flow tables stay as drill-down, not the landing view.

### 4. Attendance
**Today**: register inferred from active hours with an undocumented `+1h/+0.5h` adjustment heuristic; overrides browser-local; roster shift-time columns parsed but unused.
**Redesign**: document/configure the hour-credit rule in sheet Config; **shift adherence** view (rostered start vs first in-store activity — late starts per captain); wire eligibility explainers to the bonus engine; overrides → Apps Script write-back or month-end export (decide in Phase 3).

### 5. Captain Profile → merged into "Captain 360"
**Today**: multi-captain sparkline comparison; overlaps Deep Dive; no store baseline on charts.
**Redesign**: one page per captain — hero, SLA contribution (in-store %, complaints, PNA involvement), flag timeline, incentive earnings + next-slab distance, attendance summary. Every captain name anywhere in the dashboard becomes a drill-through link to it. Multi-captain comparison survives as a compare mode.

### 6. Tier Analysis
Smart internals (row-level historical classification, weighted averages, locked baselines) — keep the engine. Fix: hardcoded excluded outlier months (Mar/Sep/Oct) → sheet Config; show n= per cohort; side-by-side shift/experience instead of a mode toggle; add an auto-insight line per section ("Night shift 18% slower on billing than Morning — 3.2k orders affected").

### 7. Inventory Health
**Today**: measures audit *activity*, not inventory *health* — "unique codes audited" has no denominator.
**Redesign**: needs a **master rack list** (open question) to compute true coverage % and staleness → "stale-rack queue: 47 racks not audited in 30+ days, worst aisles first". Longer term, Item Variance (already merged, on hold) is the real accuracy signal. Audit ROI: racks audited vs PNA reduction by aisle.

### 8. Complaints Deep Dive
**Today**: solid aggregations; but two overlapping category-exclusion mechanisms (QNG toggle vs Config checklist), free-text RCA, count-based trends.
**Redesign**: single qualifying-category source in sheet Config used by both KM and this tab; RCA normalization mapping table in the sheet; **product repeat-offender table** (unique orders per product); complaint-rate control band (flag only statistically unusual days, not every wiggle).

### 9. Incentives
Rules engine is correct and slab-configurable — keep. Add:
- **Near-miss nudges**: "Ravi is 6s avg away from the ₹400 slab with 2 days left in the week" — the single highest-leverage behavioral feature for supervisors.
- Payout register: month view with per-line slab audit trail + CSV export for payroll.
- Surface each captain's incentive state in Captain 360.

### 10. Config Panel
Becomes a read-mostly viewer of effective config loaded from the sheet `Config` tab, with an "edit in sheet" link. Analysis-only knobs (SD thresholds, productivity weights) may stay local. Show config provenance (sheet vs default).

---

## Part 3 — Phased build plan

- **Phase 0 — Foundations** ✅ *landed 2026-07-06*: parallel fetches + IndexedDB cache-first startup w/ freshness banner; `Config` sheet tab + `cfg` resolution (sheet > localStorage > defaults) + `config-setup.gs`; `compute.computeWindowKpis` pooled stat-card math; ui.js split into js/shared/* + js/tabs/* + ui-registry + app (verified byte-equivalent, `tools/smoke-load.js` guards load order); `periods` helper replacing the 7 duplicated T-1/T-2 blocks. Bonus fixes: `window.app` binding (dashboard now auto-loads after sign-in — previously required a manual Refresh) and shared in-flight token request in auth.js. Deferred to Phases 1–2: migrating the remaining per-tab preset-builder code onto `periods`, and unifying `avg_total_time_per_order` definitions.
- **Phase 1 — Morning Briefing** ✅ *landed 2026-07-06*: SLA band pace lines (shared `projectCyclePace`), pooled KPI cards w/ deltas + SVG sparklines, exceptions feed (pace risk, worst hour, complaint spikes, flagged captains, zero-output shifts), charts collapsed behind lazy toggle.
- **Phase 2 — Captain intelligence** ✅ *landed 2026-07-06*: `computeCaptainScores` (volume-gated median/MAD robust z), coaching list w/ reasons + trend, Captain 360 section, universal captain-name drill-through (`ui.openCaptain360`).
- **Phase 3 — Money** ✅ *landed 2026-07-06*: near-miss nudges (current week/month), payroll CSV export incl. attendance bonus, shift adherence (roster start vs first in-store pick), bonus-reason tooltips. Calendar-month incentive periods confirmed as policy.
- **Phase 4 — Quality** ✅ *landed 2026-07-06*: product repeat-offender table, Unusual Days control band; Racks-tab master list → coverage % + stale-rack queue.
- **Phase 5 — Trust** ✅ *landed 2026-07-06*: Data Health card (parse drops, unmatched cross-sheet IDs, missing days, duplicate in-store orders); `tools/test-compute.js` (17 tests over payroll/SLA math).

**User actions to unlock everything**: (1) run `setupConfigTab()` from google-apps-script/config-setup.gs in the main sheet; (2) add a `Racks` tab (col A = every rack code) to the main sheet.

## Open questions — ANSWERED 2026-07-06

1. **Master rack list**: exists; shared via a tab in the main spreadsheet (dashboard reads a `Racks` tab, header `rack_code` / fallback col A). Powers Phase 4 coverage % + staleness.
2. **Incentives on calendar months**: policy, not accident. Keep calendar-month incentive periods.
3. **Attendance overrides**: leave as localStorage (no write-back, no export workflow for now).
4. **Apps Script alerts**: not for now — early warning stays in-dashboard (exceptions feed).
5. **Hosting**: GitHub (Pages). Classic script tags remain the convention (already adopted in Phase 0).
