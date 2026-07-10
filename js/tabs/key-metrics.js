/**
 * key-metrics.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

  // ── Key Metrics (SLA Command Center) ──────────────────────────────

  let _kmCycleKey = null;          // merchant-cycle key "YYYY-MM" for target lookup
  let _kmDateMode = false;         // true once a custom date range is in play
  let _kmCycleRows = [];           // in-scope (IPO≤6) in-store rows for the period
  let _kmInstoreWin = [];          // ALL in-store rows for the period (any IPO)
  let _kmWinStart = -Infinity;     // selected window bounds (ms)
  let _kmWinEnd = Infinity;
  let _kmPickerNames = new Map();  // employee_id → name
  let _kmDetailPeriod = { start: '', end: '' };
  let _kmDetailEscHandler = null;

  // Tier grading colours for heatmap / picker cells:
  // below=red · baseline=orange · SLA 1=yellow · SLA 2=green.
  const _KM_GRADE_COLOR = { below: '#f87171', baseline: '#fb923c', sla1: '#facc15', sla2: '#34d399', na: '#39414f' };

  // Billing-cycle key ("YYYY-MM", cycle ends 25th) for a date — mirrors
  // compute._billingMonthKey so Config target lookups line up.
  function _billingCycleKeyOf(date) {
    let y = date.getFullYear(), m = date.getMonth() + 1;
    if (date.getDate() >= 26) { m++; if (m > 12) { m = 1; y++; } }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  // ── Roster manpower per hour ──────────────────────────────────────
  // Roster cols: eff_date (effective date, serial), shift_start/shift_end
  // (time-of-day), off_day (weekly off). Counts captains available in each
  // hour slot, averaged per calendar day across the selected window.

  const _KM_WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  function _rosterEffDay(val) {
    const n = parseFloat(val);
    if (isNaN(n) || n <= 1000) return null;
    const d = new Date(Math.round((n - 25569) * 86400000));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); // local midnight
  }
  function _rosterTimeToHour(val) {
    if (val === '' || val == null) return null;
    const n = Number(val);
    if (!isNaN(n)) return (n - Math.floor(n)) * 24; // fraction-of-day → 0..24
    const m = String(val).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    let hr = parseInt(m[1], 10); const min = parseInt(m[2], 10); const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && hr < 12) hr += 12;
    if (ap === 'AM' && hr === 12) hr = 0;
    return hr + min / 60;
  }
  function _coverHours(startH, endH) {
    if (startH == null || endH == null) return [];
    const out = [];
    if (endH > startH) {
      for (let h = Math.floor(startH); h < Math.ceil(endH); h++) out.push(h % 24);
    } else { // wraps past midnight
      for (let h = Math.floor(startH); h < 24; h++) out.push(h);
      for (let h = 0; h < Math.ceil(endH); h++) out.push(h);
    }
    return out;
  }
  function _parseOffDays(s) {
    const set = new Set();
    const low = (s || '').toLowerCase();
    if (!low || low.includes('no week off') || low.includes('no off')) return set;
    for (const part of low.split(/[,/]/)) {
      const d = _KM_WEEKDAYS[part.trim()];
      if (d !== undefined) set.add(d);
    }
    return set;
  }

  // Roster snapshots are weekly (effective date = the week's Monday). A snapshot
  // applies until the captain's NEXT snapshot supersedes it, capped at 14 days so
  // stale rows for departed captains don't count forever.
  const _ROSTER_STALE_CAP_MS = 14 * 86400000;

  function _kmRosterByCaptain() {
    const roster = _supervisorFilter(sheets.getRosterCached() || []);
    const byCap = new Map();
    for (const r of roster) {
      const eff = _rosterEffDay(r.eff_date);
      if (eff == null) continue;
      const hours = _coverHours(_rosterTimeToHour(r.shift_start), _rosterTimeToHour(r.shift_end));
      if (!hours.length) continue;
      if (!byCap.has(r.employee_id)) byCap.set(r.employee_id, { name: r.employee_name, entries: [] });
      byCap.get(r.employee_id).entries.push({ eff, hours: new Set(hours), offs: _parseOffDays(r.off_day), shift: r.shift });
    }
    for (const v of byCap.values()) v.entries.sort((a, b) => a.eff - b.eff);
    return byCap;
  }

  // The roster entry in effect on day `t`: latest snapshot ≤ t, valid until the
  // next snapshot supersedes it (or 14 days, whichever comes first).
  function _kmActiveEntry(entries, t) {
    let entry = null, nextEff = Infinity;
    for (const e of entries) {
      if (e.eff <= t) entry = e;
      else { nextEff = e.eff; break; }
    }
    if (!entry) return null;
    const validUntil = Math.min(nextEff, entry.eff + _ROSTER_STALE_CAP_MS);
    return t < validUntil ? entry : null;
  }

  function _eachDay(startMs, endMs, fn) {
    const DAY = 86400000;
    const sD = new Date(startMs); sD.setHours(0, 0, 0, 0);
    const eD = new Date(endMs);   eD.setHours(0, 0, 0, 0);
    let n = 0;
    for (let t = sD.getTime(); t <= eD.getTime(); t += DAY) { fn(t, new Date(t).getDay()); n++; }
    return n;
  }

  function _kmManpowerByHour(startMs, endMs) {
    if (!isFinite(startMs) || !isFinite(endMs)) return null;
    const byCap = _kmRosterByCaptain();
    if (!byCap.size) return null;
    const total = new Array(24).fill(0);
    const days = _eachDay(startMs, endMs, (t, weekday) => {
      for (const v of byCap.values()) {
        const e = _kmActiveEntry(v.entries, t);
        if (!e || e.offs.has(weekday)) continue;
        for (const h of e.hours) total[h]++;
      }
    });
    if (!days) return null;
    return total.map(v => v / days);
  }

  // Captains rostered to a given hour across the window (for the click-through).
  function _kmRosterDetailForHour(hour) {
    const byCap = _kmRosterByCaptain();
    const out = new Map();
    _eachDay(_kmWinStart, _kmWinEnd, (t, weekday) => {
      for (const [id, v] of byCap) {
        const e = _kmActiveEntry(v.entries, t);
        if (!e || e.offs.has(weekday) || !e.hours.has(hour)) continue;
        let o = out.get(id);
        if (!o) { o = { employee_id: id, name: v.name, shift: e.shift, days: 0 }; out.set(id, o); }
        o.days++;
      }
    });
    return [...out.values()].sort((a, b) => b.days - a.days);
  }

  // Pickers active in a given hour (>1 IPO≤6 order), for the click-through.
  // Operates on the SLA population (IPO≤6) so "orders" and "breached" align.
  function _kmPickerDetailForHour(hour) {
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const m = new Map();
    for (const r of _kmCycleRows) {
      if (r.hour !== hour) continue;
      let e = m.get(r.employee_id);
      if (!e) { e = { employee_id: r.employee_id, orders: 0, breached: 0 }; m.set(r.employee_id, e); }
      e.orders++;
      if ((r.instore_seconds || 0) > THRESH) e.breached++;
    }
    return [...m.values()].filter(p => p.orders > 1).sort((a, b) => b.orders - a.orders);
  }

  // SLA targets are three-tiered per merchant cycle (Baseline / SLA 1 / SLA 2),
  // edited in the Config panel. In-store & fill-rate are "higher is better";
  // complaints is "lower is better".
  const _KM_TARGET_DEFAULTS = {
    instore:    { baseline: 75,    sla1: 80,    sla2: 86    },
    complaints: { baseline: 1.33,  sla1: 1.1,   sla2: 0.9   },
    fillrate:   { baseline: 99.32, sla1: 99.56, sla2: 99.66 },
  };
  const _KM_METRICS = ['instore', 'complaints', 'fillrate'];
  const _KM_TIERS = ['baseline', 'sla1', 'sla2'];
  // Complaint categories excluded from the SLA by default.
  const _KM_EXCLUDE_RE = /mdnd|poor.*qual|qng/i;

  // Effective targets per cycle: sheet Config tab > localStorage > defaults.
  function _getSlaTargets(cycleKey) {
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const local = all[cycleKey] || {};
    const sheet = cfg.get(`slaTargets.${cycleKey}`, null) || {};
    const out = {};
    for (const m of _KM_METRICS) {
      const sm = sheet[m] || {};
      const lm = local[m] || {};
      out[m] = {};
      for (const tier of _KM_TIERS) {
        out[m][tier] = sm[tier] != null ? sm[tier]
                     : lm[tier] != null ? lm[tier]
                     : _KM_TARGET_DEFAULTS[m][tier];
      }
    }
    return out;
  }

  // Highest SLA tier reached by a value. direction 'high' = bigger is better.
  function _kmTierReached(value, tiers, direction) {
    if (value === null || value === undefined || isNaN(value)) {
      return { tier: 'na', label: 'No data', cls: 'km-tier-na' };
    }
    const ok = direction === 'high'
      ? (t) => value >= t
      : (t) => value <= t;
    if (ok(tiers.sla2))     return { tier: 'sla2',     label: 'SLA 2',         cls: 'km-tier-sla2' };
    if (ok(tiers.sla1))     return { tier: 'sla1',     label: 'SLA 1',         cls: 'km-tier-sla1' };
    if (ok(tiers.baseline)) return { tier: 'baseline', label: 'Baseline',      cls: 'km-tier-baseline' };
    return { tier: 'below', label: 'Below baseline', cls: 'km-tier-below' };
  }

  // Qualifying complaint categories for the SLA. Returns an explicit lowercased
  // Set when the sheet Config tab or the user has saved a selection, else null
  // (apply default rule). Sheet wins over localStorage.
  function _getComplaintSlaCategorySet() {
    const sheetCats = cfg.get('complaintSlaCategories', null);
    if (Array.isArray(sheetCats) && sheetCats.length > 0) {
      return new Set(sheetCats.map(s => String(s).toLowerCase()));
    }
    const stored = localStorage.getItem('complaintSlaCategories');
    if (stored) {
      try {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) return new Set(arr.map(s => String(s).toLowerCase()));
      } catch { /* ignore */ }
    }
    return null;
  }
  function _isQualifyingComplaint(cat) {
    const c = (cat || '').toLowerCase();
    const set = _getComplaintSlaCategorySet();
    if (set) return set.has(c);
    // Default: include everything except MDND, Poor-Quality, and QNG.
    return c !== '' && !_KM_EXCLUDE_RE.test(c);
  }

  function initKeyMetrics() {
    const sel = document.getElementById('km-preset');
    if (!sel) return;
    const daily = sheets.getCached();
    if (!daily || daily.length === 0) { sel.innerHTML = ''; return; }

    const mapped = daily.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id }));
    const weekly  = compute.aggregateWeekly(mapped);
    const monthly = compute.aggregateBillingMonthly(mapped);

    sel.innerHTML = [
      '<option value="all">All Time</option>',
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${_billingMonthLabel(d.month_key)}</option>`),
      '</optgroup>',
    ].join('');

    // Default: latest billing cycle window.
    if (monthly.length) {
      const latest = monthly[monthly.length - 1].month_key;
      _applyBillingMonthDates('km-start', 'km-end', latest);
      sel.value = `M:${latest}`;
    }
    _kmDateMode = false;
  }

  function onKmPresetChange() {
    const daily = sheets.getCached();
    if (!daily) return;
    const periodVal = document.getElementById('km-preset')?.value;
    if (!periodVal) return;
    _kmDateMode = false;

    if (periodVal === 't1' || periodVal === 't2') {
      periods.setDayPair('km-start', 'km-end', periodVal === 't1' ? 1 : 2);
      _kmDateMode = true;
    } else if (periodVal === 'all') {
      const dates = daily.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      if (dates.length) {
        document.getElementById('km-start').value = _isoDateStr(dates[0]);
        document.getElementById('km-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    } else {
      const colonIdx   = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      if (periodType === 'W') {
        const start = compute.weekStartFromKey(periodKey);
        const end   = new Date(start); end.setDate(end.getDate() + 6);
        document.getElementById('km-start').value = _isoDateStr(start);
        document.getElementById('km-end').value   = _isoDateStr(end);
      } else {
        _applyBillingMonthDates('km-start', 'km-end', periodKey);
      }
    }
    renderKeyMetrics();
  }

  function onKmDateChange() {
    _kmDateMode = true;
    renderKeyMetrics();
  }

  function renderKeyMetrics() {
    const container = document.getElementById('key-metrics-content');
    if (!container) return;

    _closeKmDetail();

    const dailyData   = _supervisorFilter(sheets.getCached());
    const instoreAll  = _supervisorFilter(sheets.getInstoreCached() || []);
    const complAll    = _supervisorFilter(sheets.getComplaintsCached() || []);

    // Date window from the pickers (same pattern as other tabs).
    const startVal = document.getElementById('km-start')?.value;
    const endVal   = document.getElementById('km-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0, 0, 0, 0)   : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23, 59, 59, 999) : Infinity;
    const inWindow = r => r.date && r.date >= startMs && r.date <= endMs;
    _kmDetailPeriod = { start: startVal || '', end: endVal || '' };

    // Targets are keyed by the billing cycle the period ends in.
    _kmCycleKey = endVal ? _billingCycleKeyOf(new Date(endVal)) : new Date().toISOString().slice(0, 7);
    const targets = _getSlaTargets(_kmCycleKey);

    // Picker id → name map (from Daily Metrics)
    const names = new Map();
    dailyData.forEach(r => {
      if (r.employee_id && r.employee_name && !names.has(r.employee_id)) names.set(r.employee_id, r.employee_name);
    });
    const nameOf = id => names.get(id) || id || 'Unknown';
    _kmPickerNames = names;

    // ── In-store SLA (over the selected window) ──
    const instoreWin = instoreAll.filter(inWindow);
    const instoreSLA = instoreWin.length ? compute.computeInstoreSLA(instoreWin, null) : null;
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP;
    _kmCycleRows = instoreWin.filter(r => r.ipo > 0 && r.ipo <= CAP); // SLA population, for breach drill-down
    _kmInstoreWin = instoreWin;
    _kmWinStart = isFinite(startMs) ? startMs : (instoreWin.length ? Math.min(...instoreWin.map(r => +r.date)) : Date.now());
    _kmWinEnd   = isFinite(endMs)   ? endMs   : (instoreWin.length ? Math.max(...instoreWin.map(r => +r.date)) : Date.now());
    const instorePct = (instoreSLA && instoreSLA.totals.denom)
      ? +(instoreSLA.totals.met / instoreSLA.totals.denom * 100).toFixed(2) : null;
    const manpowerByHour = _kmManpowerByHour(startMs, endMs);

    // ── Complaints SLA (over the selected window) ──
    const dailyWin  = dailyData.filter(inWindow);
    const qualCompl = complAll.filter(r => inWindow(r) && _isQualifyingComplaint(r.complaint_category));
    const complAgg  = qualCompl.length ? compute.computeComplaintAggregations(qualCompl, dailyWin) : null;
    const cTot      = complAgg ? complAgg.storeSummary.totals : null;
    const complOrders = cTot ? cTot.totalOrdersPicked : dailyWin.reduce((s, r) => s + (r.checkout_orders || 0), 0);
    const complItems  = cTot ? cTot.totalComplaints : 0;
    const complPct    = complOrders > 0 ? +(complItems / complOrders * 100).toFixed(2) : null;
    const complInStore  = cTot ? cTot.inStoreYes : 0;
    const complOutStore = cTot ? cTot.inStoreNo  : 0;
    const complByCategory = cTot ? cTot.byCategory : {};

    // ── Fill Rate SLA (over the selected window) ──
    // Affected orders = union of distinct order_ids with >=1 PNA OR >=1
    // item_missing complaint; fill = (orders - affected) / orders.
    const missCat = (CONFIG.FILL_RATE?.MISSING_CATEGORY || 'item_missing').toLowerCase();
    const pnaWin     = _supervisorFilter(sheets.getPnaCached() || []).filter(inWindow);
    const missingWin = complAll.filter(r => inWindow(r) && (r.complaint_category || '').toLowerCase() === missCat);
    const fill = compute.computeFillRate(pnaWin, missingWin, complOrders);
    const fillPct = fill.pct;

    // ── Deltas vs the preceding window of equal length ──
    let instDelta = '', complDelta = '', fillDelta = '';
    if (isFinite(startMs) && isFinite(endMs)) {
      const len = endMs - startMs + 1;
      const prev = _kmSnapshot(startMs - len, startMs - 1);
      instDelta  = _kmDeltaChip(instorePct, prev.instore.pct, 'high');
      complDelta = _kmDeltaChip(complPct, prev.compl.pct, 'low');
      fillDelta  = _kmDeltaChip(fillPct, prev.fill ? prev.fill.pct : null, 'high');
    }

    // ── Scorecards ──
    const scorecards = `
      <div class="km-score-row">
        ${_kmScoreCard('In-Store Time', 'Orders ≤ 2.5 min · IPO ≤ 6',
          instorePct, '%', targets.instore, 'high',
          instoreSLA ? `${_fmt(instoreSLA.totals.met)} / ${_fmt(instoreSLA.totals.denom)} orders met` : 'No in-store data',
          instDelta)}
        ${_kmScoreCard('Complaints', 'Qualifying items ÷ orders',
          complPct, '%', targets.complaints, 'low',
          `${_fmt(complItems)} items · ${_fmt(complOrders)} orders`,
          complDelta)}
        ${_kmFillRateCard(fillPct, targets.fillrate, fill, fillDelta)}
      </div>`;

    // ── Yesterday strip + cycle pace ──
    const ydayHtml = _kmYdayStrip(targets);
    const paceHtml = _kmPaceSection(startVal, endVal,
      { met: instoreSLA ? instoreSLA.totals.met : 0, denom: instoreSLA ? instoreSLA.totals.denom : 0 },
      { items: complItems, orders: complOrders },
      fill,
      targets);

    // ── Daily trend section (rendered as charts after innerHTML) ──
    const instoreTrend = instoreSLA ? instoreSLA.daily : [];
    const complaintsByDay = new Map();
    for (const r of qualCompl) {
      if (!r.dateStr) continue;
      complaintsByDay.set(r.dateStr, (complaintsByDay.get(r.dateStr) || 0) + 1);
    }
    const ordersByDay = new Map();
    for (const r of dailyWin) {
      if (!r.dateIsoStr) continue;
      ordersByDay.set(r.dateIsoStr, (ordersByDay.get(r.dateIsoStr) || 0) + (r.checkout_orders || 0));
    }
    const complTrendDays = [...ordersByDay.keys()].filter(k => ordersByDay.get(k) > 0).sort();
    const showInstoreTrend = instoreTrend.length >= 2;
    const showComplTrend = complTrendDays.length >= 2;
    const trendHtml = (showInstoreTrend || showComplTrend) ? `
      <div class="km-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#34d399;"></span>
          <h3 class="tiers-section-title">Daily Trend vs Targets</h3></div>
        <div class="km-grid-2">
          ${showInstoreTrend ? '<div class="km-card"><h4 class="km-block-title">In-Store SLA % by day</h4><div class="km-chart-wrap"><canvas id="km-trend-instore"></canvas></div></div>' : ''}
          ${showComplTrend ? '<div class="km-card"><h4 class="km-block-title">Complaint % by day</h4><div class="km-chart-wrap"><canvas id="km-trend-compl"></canvas></div></div>' : ''}
        </div>
      </div>` : '';

    // ── In-store drill-down sections ──
    const instoreHtml = instoreSLA ? `
      <div class="km-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#60a5fa;"></span>
          <h3 class="tiers-section-title">In-Store Time — What's Dragging It Down</h3></div>
        ${_kmHourHeatmap(instoreSLA.byHour, targets.instore, manpowerByHour)}
        <div class="km-grid-2">
          ${_kmStageBars(instoreSLA.byStage)}
          ${_kmIpoBands(instoreSLA.byIpoBand, targets.instore)}
        </div>
        <div class="km-grid-2">
          ${_kmWeekdayCard(_kmCycleRows, targets.instore)}
          ${_kmDropzoneCard(_kmCycleRows, targets.instore)}
        </div>
        <div class="km-table-block">
          <h4 class="km-block-title">Slowest Pickers (worst SLA first) <span class="km-target-line">click a Breached count to list those orders</span></h4>
          <div id="km-picker-table"></div>
        </div>
      </div>` : `
      <div class="km-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#60a5fa;"></span>
          <h3 class="tiers-section-title">In-Store Time</h3></div>
        <p class="placeholder-text">No in-store data for this period. Ensure the in-store spreadsheet (INSTORE_SPREADSHEET_ID) is accessible and hit Refresh.</p>
      </div>`;

    // ── Complaints drill-down section ──
    const complHtml = `
      <div class="km-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#ff6b6b;"></span>
          <h3 class="tiers-section-title">Complaints — Where They Come From</h3></div>
        <div class="km-grid-2">
          ${_kmComplaintSplit(complInStore, complOutStore, complItems)}
          ${_kmComplaintCategories(complByCategory, complItems)}
        </div>
        <div class="km-table-block">
          <h4 class="km-block-title">Per-Picker Complaints (selected period)</h4>
          <div id="km-compl-picker-table"></div>
        </div>
      </div>`;

    container.innerHTML = scorecards + ydayHtml + paceHtml + trendHtml + instoreHtml + complHtml;

    // Daily trend charts (canvases exist only after innerHTML lands).
    if (showInstoreTrend) {
      charts.renderKmTrendChart('km-trend-instore',
        instoreTrend.map(d => d.label.slice(5)),
        [{ label: 'In-store SLA %', data: instoreTrend.map(d => d.slaPct), color: '#60a5fa' }],
        targets.instore, { yTitle: 'SLA %' });
    }
    if (showComplTrend) {
      charts.renderKmTrendChart('km-trend-compl',
        complTrendDays.map(k => k.slice(5)),
        [{ label: 'Complaint %', data: complTrendDays.map(k => +((complaintsByDay.get(k) || 0) / ordersByDay.get(k) * 100).toFixed(2)), color: '#ff6b6b' }],
        targets.complaints, { yTitle: 'Complaint %', beginAtZero: true });
    }

    // Hourly cell click-throughs (pickers / rostered)
    container.querySelectorAll('.km-hour-click').forEach(btn => {
      btn.addEventListener('click', () => {
        const hour = parseInt(btn.dataset.kmHour, 10);
        if (btn.dataset.kmKind === 'pickers') _showHourPickersDetail(hour);
        else _showHourRosterDetail(hour);
      });
    });

    // Picker tables (built after innerHTML so sort can attach)
    if (instoreSLA) {
      const el = document.getElementById('km-picker-table');
      if (el) {
        el.innerHTML = _kmPickerTable(instoreSLA.byPicker, nameOf, targets.instore);
        _initTableSort(el.querySelector('.data-table'));
        el.querySelectorAll('.km-breach-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            _showInstoreBreachDetail(btn.dataset.emp || '');
          });
        });
      }
    }
    const cEl = document.getElementById('km-compl-picker-table');
    if (cEl) {
      const capRows = complAgg ? [...complAgg.captainPerf.values()] : [];
      cEl.innerHTML = _kmComplaintPickerTable(capRows, nameOf);
      _initTableSort(cEl.querySelector('.data-table'));
    }
  }

  // ── Key Metrics render helpers ────────────────────────────────────

  // Renders the Baseline / SLA 1 / SLA 2 ladder, marking the highest reached.
  function _kmTierLadder(tiers, unit, reachedTier) {
    const order = { below: -1, na: -1, baseline: 0, sla1: 1, sla2: 2 };
    const reachedIdx = order[reachedTier] ?? -1;
    const items = [
      { key: 'baseline', label: 'Base', idx: 0 },
      { key: 'sla1',     label: 'SLA 1', idx: 1 },
      { key: 'sla2',     label: 'SLA 2', idx: 2 },
    ];
    return `<div class="km-ladder">${items.map(it => `
      <span class="km-ladder-step${it.idx <= reachedIdx ? ' km-ladder-hit' : ''}">
        <span class="km-ladder-lbl">${it.label}</span>
        <span class="km-ladder-val">${_fmt(tiers[it.key], 2)}${unit}</span>
      </span>`).join('')}</div>`;
  }

  function _kmScoreCard(title, sub, value, unit, tiers, direction, footnote, deltaHtml = '') {
    const has = value !== null && value !== undefined && !isNaN(value);
    const r = _kmTierReached(value, tiers, direction);
    const valStr = has ? `${_fmt(value, unit === '%' ? 2 : 0)}${unit}` : '—';
    const arrow = direction === 'high' ? '↑ higher is better' : '↓ lower is better';
    return `
      <div class="km-score-card ${r.cls}">
        <div class="km-score-head">
          <span class="km-score-title">${title}</span>
          <span class="km-score-badge">${r.label}</span>
        </div>
        <div class="km-score-value">${valStr}${deltaHtml}</div>
        <div class="km-score-sub">${sub} · ${arrow}</div>
        ${_kmTierLadder(tiers, unit, r.tier)}
        <div class="km-score-foot">${_esc(footnote)}</div>
      </div>`;
  }

  // ── Shared SLA snapshot ───────────────────────────────────────────
  // Point-in-time in-store SLA + complaint rate over an arbitrary window.
  // Used by scorecard deltas, the Yesterday strip, and the Store Overview
  // SLA band. Reads straight from the sheet caches (supervisor-filtered).
  function _kmSnapshot(startMs, endMs) {
    const inWin = r => r.date && r.date >= startMs && r.date <= endMs;
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP;
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    let met = 0, denom = 0;
    for (const r of _supervisorFilter(sheets.getInstoreCached() || [])) {
      if (!inWin(r) || !(r.ipo > 0 && r.ipo <= CAP)) continue;
      denom++;
      if (r.instore_seconds > 0 && r.instore_seconds <= THRESH) met++;
    }
    let orders = 0;
    for (const r of _supervisorFilter(sheets.getCached() || [])) {
      if (inWin(r)) orders += r.checkout_orders || 0;
    }
    let items = 0;
    const missingRows = [];
    const missCat = (CONFIG.FILL_RATE?.MISSING_CATEGORY || 'item_missing').toLowerCase();
    for (const r of _supervisorFilter(sheets.getComplaintsCached() || [])) {
      if (!inWin(r)) continue;
      if (_isQualifyingComplaint(r.complaint_category)) items++;
      if ((r.complaint_category || '').toLowerCase() === missCat) missingRows.push(r);
    }
    const pnaRows = _supervisorFilter(sheets.getPnaCached() || []).filter(inWin);
    const fill = compute.computeFillRate(pnaRows, missingRows, orders);
    return {
      instore: { met, denom, pct: denom ? +(met / denom * 100).toFixed(2) : null },
      compl:   { items, orders, pct: orders > 0 ? +(items / orders * 100).toFixed(2) : null },
      fill,
    };
  }

  // ▲/▼ chip showing change vs a comparison value, colored by whether the
  // move is an improvement for the metric's direction.
  function _kmDeltaChip(cur, prev, direction, label = 'vs preceding period') {
    if (cur == null || prev == null || isNaN(cur) || isNaN(prev)) return '';
    const d = +(cur - prev).toFixed(2);
    const improved = direction === 'high' ? d > 0 : d < 0;
    const cls = d === 0 ? 'km-delta-flat' : improved ? 'km-delta-good' : 'km-delta-bad';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '•';
    return `<span class="km-delta-chip ${cls}" title="${_esc(label)}: ${prev}%">${arrow} ${Math.abs(d).toFixed(2)}</span>`;
  }

  // Jump straight to yesterday's view (used by the Yesterday strip).
  function kmJumpT1() {
    const sel = document.getElementById('km-preset');
    if (sel) sel.value = 't1';
    onKmPresetChange();
  }

  // Fill Rate scorecard. When there is no PNA + missing-item data for the
  // window, falls back to the original "SOON" placeholder.
  function _kmFillRateCard(value, tiers, fill, deltaHtml = '') {
    const hasData = fill && (fill.pnaOrders > 0 || fill.missOrders > 0) && fill.checkoutOrders > 0;
    if (!hasData) {
      return `
        <div class="km-score-card km-tier-na km-soon">
          <div class="km-score-head">
            <span class="km-score-title">Fill Rate</span>
            <span class="km-score-badge">NO DATA</span>
          </div>
          <div class="km-score-value">—</div>
          <div class="km-score-sub">Delivered in full ÷ checkout orders · ↑ higher is better</div>
          ${_kmTierLadder(tiers, '%', 'na')}
          <div class="km-score-foot">No PNA / missing-item rows for this period</div>
        </div>`;
    }
    const foot = `${_fmt(fill.inFull)} / ${_fmt(fill.checkoutOrders)} in full · `
      + `${_fmt(fill.affected)} short (${_fmt(fill.pnaOrders)} PNA · ${_fmt(fill.missOrders)} missing)`;
    return _kmScoreCard('Fill Rate', 'Delivered in full ÷ checkout orders',
      value, '%', tiers, 'high', foot, deltaHtml);
  }

  // ── Cycle pace & projection ───────────────────────────────────────
  // Answers "will we land above each tier by the end of the window, and what
  // does that require per remaining day?". Rendered only while the selected
  // window is still open (end date is today or later) and has elapsed days.
  // Remaining-day volume is assumed equal to the window's daily average.
  function _kmPaceSection(startVal, endVal, inst, comp, fill, targets) {
    if (!startVal || !endVal) return '';
    const DAY = 86400000;
    const start = new Date(startVal); start.setHours(0, 0, 0, 0);
    const end   = new Date(endVal);   end.setHours(0, 0, 0, 0);
    const today = new Date();         today.setHours(0, 0, 0, 0);
    if (end < today) return '';
    const totalDays = Math.round((end - start) / DAY) + 1;
    const elapsed = Math.min(totalDays, Math.max(0, Math.round((today - start) / DAY)));
    const left = totalDays - elapsed;
    if (elapsed < 1 || left < 1) return '';

    // Recent form: last 7 elapsed days (clamped to the window start).
    const recentStart = Math.max(start.getTime(), today.getTime() - 7 * DAY);
    const recent = _kmSnapshot(recentStart, today.getTime() - 1);

    const tierRow = (tierKey, statusCls, statusTxt, targetTxt) => `
      <div class="km-pace-tier ${statusCls}">
        <span class="km-pace-tier-lbl"><i style="background:${_KM_GRADE_COLOR[tierKey]}"></i>${targetTxt}</span>
        <span class="km-pace-tier-req">${statusTxt}</span>
      </div>`;

    // ── In-store column ──
    let instCol = '';
    if (inst.denom > 0) {
      const dailyDenom = inst.denom / elapsed;
      const future = dailyDenom * left;
      const recentPct = recent.instore.pct != null ? recent.instore.pct : +(inst.met / inst.denom * 100).toFixed(2);
      const projected = +(((inst.met + recentPct / 100 * future) / (inst.denom + future)) * 100).toFixed(2);
      const projTier = _kmTierReached(projected, targets.instore, 'high');
      const rows = _KM_TIERS.map(tk => {
        const t = targets.instore[tk];
        const reqPct = ((t / 100) * (inst.denom + future) - inst.met) / future * 100;
        const targetTxt = `${tk === 'baseline' ? 'Base' : tk === 'sla1' ? 'SLA 1' : 'SLA 2'} · ${t}%`;
        if (reqPct <= 0)  return tierRow(tk, 'km-pace-locked', 'Locked in ✓', targetTxt);
        if (reqPct > 100) return tierRow(tk, 'km-pace-lost',   'Out of reach', targetTxt);
        return tierRow(tk, '', `needs ≥ ${reqPct.toFixed(1)}% / day`, targetTxt);
      }).join('');
      instCol = `
        <div class="km-pace-col">
          <div class="km-pace-head">In-Store Time</div>
          <div class="km-pace-proj">Projected finish:
            <strong style="color:${_KM_GRADE_COLOR[projTier.tier] || 'var(--text)'}">${projected}%</strong>
            <span class="km-target-line">at last-7-day form (${recentPct}%)</span>
          </div>
          ${rows}
        </div>`;
    }

    // ── Complaints column ──
    let complCol = '';
    if (comp.orders > 0) {
      const dailyOrders = comp.orders / elapsed;
      const future = dailyOrders * left;
      const recentPct = recent.compl.pct != null ? recent.compl.pct : +(comp.items / comp.orders * 100).toFixed(2);
      const projected = +(((comp.items + recentPct / 100 * future) / (comp.orders + future)) * 100).toFixed(2);
      const projTier = _kmTierReached(projected, targets.complaints, 'low');
      const rows = _KM_TIERS.map(tk => {
        const t = targets.complaints[tk];
        const allowed = Math.floor((t / 100) * (comp.orders + future) - comp.items);
        const targetTxt = `${tk === 'baseline' ? 'Base' : tk === 'sla1' ? 'SLA 1' : 'SLA 2'} · ${t}%`;
        if (allowed < 0) return tierRow(tk, 'km-pace-lost', 'Out of reach', targetTxt);
        return tierRow(tk, '', `room for ${_fmt(allowed)} more (≈${(allowed / left).toFixed(1)}/day)`, targetTxt);
      }).join('');
      complCol = `
        <div class="km-pace-col">
          <div class="km-pace-head">Complaints</div>
          <div class="km-pace-proj">Projected finish:
            <strong style="color:${_KM_GRADE_COLOR[projTier.tier] || 'var(--text)'}">${projected}%</strong>
            <span class="km-target-line">at last-7-day form (${recentPct}%)</span>
          </div>
          ${rows}
        </div>`;
    }

    // ── Fill Rate column ──
    // Higher-is-better % like in-store, but the actionable lever is the number
    // of "short" orders (>=1 PNA or missing item) still affordable — so the
    // tier rows use the complaints-style "room for N more" framing.
    let fillCol = '';
    if (fill && fill.checkoutOrders > 0) {
      const dailyOrders = fill.checkoutOrders / elapsed;
      const future = dailyOrders * left;
      const recentPct = (recent.fill && recent.fill.pct != null)
        ? recent.fill.pct
        : (fill.pct != null ? fill.pct : +(fill.inFull / fill.checkoutOrders * 100).toFixed(2));
      const projected = +(((fill.inFull + recentPct / 100 * future) / (fill.checkoutOrders + future)) * 100).toFixed(2);
      const projTier = _kmTierReached(projected, targets.fillrate, 'high');
      const rows = _KM_TIERS.map(tk => {
        const t = targets.fillrate[tk];
        const allowed = Math.floor((1 - t / 100) * (fill.checkoutOrders + future) - fill.affected);
        const targetTxt = `${tk === 'baseline' ? 'Base' : tk === 'sla1' ? 'SLA 1' : 'SLA 2'} · ${t}%`;
        if (allowed < 0) return tierRow(tk, 'km-pace-lost', 'Out of reach', targetTxt);
        return tierRow(tk, '', `room for ${_fmt(allowed)} more short${allowed === 1 ? '' : 's'} (≈${(allowed / left).toFixed(1)}/day)`, targetTxt);
      }).join('');
      fillCol = `
        <div class="km-pace-col">
          <div class="km-pace-head">Fill Rate</div>
          <div class="km-pace-proj">Projected finish:
            <strong style="color:${_KM_GRADE_COLOR[projTier.tier] || 'var(--text)'}">${projected}%</strong>
            <span class="km-target-line">at last-7-day form (${recentPct}%)</span>
          </div>
          ${rows}
        </div>`;
    }

    if (!instCol && !complCol && !fillCol) return '';
    return `
      <div class="km-card km-pace-card">
        <h4 class="km-block-title">Cycle Pace — day ${elapsed} of ${totalDays} · ${left} day${left === 1 ? '' : 's'} left
          <span class="km-target-line">assumes remaining days carry the window's average volume</span></h4>
        <div class="km-pace-grid">${instCol}${complCol}${fillCol}</div>
      </div>`;
  }

  // ── Yesterday strip ───────────────────────────────────────────────
  // One-line T-1 readout under the scorecards, independent of the selected
  // window, with deltas vs T-2 and yesterday's weakest hour.
  function _kmYdayStrip(targets) {
    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yS = today.getTime() - DAY, yE = today.getTime() - 1;
    const y  = _kmSnapshot(yS, yE);
    const t2 = _kmSnapshot(yS - DAY, yE - DAY);
    if (y.instore.denom === 0 && y.compl.orders === 0) return '';

    // Weakest hour yesterday (min SLA% among hours with ≥5 in-scope orders).
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP;
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const hours = new Map();
    for (const r of _supervisorFilter(sheets.getInstoreCached() || [])) {
      if (!r.date || r.date < yS || r.date > yE) continue;
      if (!(r.ipo > 0 && r.ipo <= CAP) || r.hour == null) continue;
      let h = hours.get(r.hour);
      if (!h) { h = { denom: 0, met: 0 }; hours.set(r.hour, h); }
      h.denom++;
      if (r.instore_seconds > 0 && r.instore_seconds <= THRESH) h.met++;
    }
    let worstHour = null, worstPct = Infinity;
    for (const [h, v] of hours) {
      if (v.denom < 5) continue;
      const p = v.met / v.denom * 100;
      if (p < worstPct) { worstPct = p; worstHour = h; }
    }

    const ydate = new Date(yS);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const instTier = _kmTierReached(y.instore.pct, targets.instore, 'high');
    const complTier = _kmTierReached(y.compl.pct, targets.complaints, 'low');
    const stat = (v, l, color) => `
      <div class="km-yday-stat">
        <span class="v"${color ? ` style="color:${color}"` : ''}>${v}</span><span class="l">${l}</span>
      </div>`;

    return `
      <div class="km-yday-strip">
        <div class="km-yday-label">
          <span class="km-yday-kicker">Yesterday</span>
          <span class="km-yday-date">${MONTHS[ydate.getMonth()]} ${ydate.getDate()}</span>
        </div>
        <div class="km-yday-stats">
          ${stat(
            y.instore.pct != null ? `${y.instore.pct}% ${_kmDeltaChip(y.instore.pct, t2.instore.pct, 'high', 'vs T-2')}` : '—',
            'In-store SLA', _KM_GRADE_COLOR[instTier.tier])}
          ${stat(y.instore.denom ? `${_fmt(y.instore.met)}/${_fmt(y.instore.denom)}` : '—', 'orders met (IPO≤6)')}
          ${stat(
            y.compl.pct != null ? `${y.compl.pct}% ${_kmDeltaChip(y.compl.pct, t2.compl.pct, 'low', 'vs T-2')}` : '—',
            'complaint rate', _KM_GRADE_COLOR[complTier.tier])}
          ${stat(`${_fmt(y.compl.items)}`, 'qualifying complaints')}
          ${stat(worstHour != null ? `${String(worstHour).padStart(2, '0')}:00 · ${worstPct.toFixed(0)}%` : '—', 'weakest hour')}
        </div>
        <button type="button" class="btn btn-secondary km-yday-btn" onclick="ui.kmJumpT1()">Open T-1 →</button>
      </div>`;
  }

  // ── Day-of-week SLA pattern ───────────────────────────────────────
  function _kmWeekdayCard(rows, tiers) {
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const acc = Array.from({ length: 7 }, () => ({ denom: 0, met: 0 }));
    for (const r of rows) {
      if (!r.date) continue;
      const a = acc[new Date(r.date).getDay()];
      a.denom++;
      if (r.instore_seconds > 0 && r.instore_seconds <= THRESH) a.met++;
    }
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
    const bars = order.map(d => {
      const a = acc[d];
      const pct = a.denom ? +(a.met / a.denom * 100).toFixed(1) : null;
      const tier = pct != null ? _kmTierReached(pct, tiers, 'high').tier : 'na';
      return `
        <div class="km-stage-row">
          <span class="km-stage-lbl">${NAMES[d]} <span class="km-target-line">${a.denom ? _fmt(a.denom) : ''}</span></span>
          <div class="km-stage-track"><div class="km-stage-fill" style="width:${pct ?? 0}%;background:${_KM_GRADE_COLOR[tier]};"></div></div>
          <span class="km-stage-val">${pct != null ? pct + '%' : '—'}</span>
        </div>`;
    }).join('');
    return `
      <div class="km-card">
        <h4 class="km-block-title">SLA % by Day of Week <span class="km-target-line">order counts in grey</span></h4>
        ${bars}
      </div>`;
  }

  // ── Dropzone availability impact ──────────────────────────────────
  function _kmDropzoneCard(rows, tiers) {
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const acc = { yes: { denom: 0, met: 0 }, no: { denom: 0, met: 0 } };
    for (const r of rows) {
      const a = r.is_dropzone_available ? acc.yes : acc.no;
      a.denom++;
      if (r.instore_seconds > 0 && r.instore_seconds <= THRESH) a.met++;
    }
    const pctOf = a => a.denom ? +(a.met / a.denom * 100).toFixed(1) : null;
    const yesPct = pctOf(acc.yes), noPct = pctOf(acc.no);
    if (yesPct === null || noPct === null) {
      return `
        <div class="km-card">
          <h4 class="km-block-title">Dropzone Impact</h4>
          <p class="placeholder-text" style="padding:10px 0">Not enough data to compare dropzone availability for this period.</p>
        </div>`;
    }
    const row = (lbl, pct, a) => {
      const tier = _kmTierReached(pct, tiers, 'high').tier;
      return `
        <div class="km-stage-row">
          <span class="km-stage-lbl">${lbl} <span class="km-target-line">${_fmt(a.denom)}</span></span>
          <div class="km-stage-track"><div class="km-stage-fill" style="width:${pct}%;background:${_KM_GRADE_COLOR[tier]};"></div></div>
          <span class="km-stage-val">${pct}%</span>
        </div>`;
    };
    const gap = +(yesPct - noPct).toFixed(1);
    return `
      <div class="km-card">
        <h4 class="km-block-title">Dropzone Impact <span class="km-target-line">order counts in grey</span></h4>
        ${row('Dropzone free', yesPct, acc.yes)}
        ${row('Dropzone blocked', noPct, acc.no)}
        <p class="km-help">${gap > 0
          ? `Orders land ${gap} pts more often within SLA when a dropzone is free — keep dropzones clear during peak hours.`
          : 'No meaningful SLA gap between dropzone states in this period.'}</p>
      </div>`;
  }

  function _kmHourStat(value, label, hour, kind) {
    const v = _fmt(value);
    if (kind) {
      const disabled = !value;
      return `<button type="button" class="km-hour-stat km-hour-click${disabled ? ' km-hour-disabled' : ''}"${disabled ? ' disabled' : ''} data-km-hour="${hour}" data-km-kind="${kind}">
        <span class="v">${v}</span><span class="l">${label}</span></button>`;
    }
    return `<div class="km-hour-stat"><span class="v">${v}</span><span class="l">${label}</span></div>`;
  }

  function _kmHourHeatmap(byHour, tiers, manpower) {
    const cells = byHour.map(h => {
      const has = h.denom > 0;
      const breached = h.denom - h.met;
      const ros = manpower ? Math.round(manpower[h.hour]) : null;
      const tier = has ? _kmTierReached(h.pct, tiers, 'high').tier : 'na';
      const color = _KM_GRADE_COLOR[tier];
      const lbl = `${String(h.hour).padStart(2, '0')}:00`;
      if (!has) {
        return `<div class="km-hour-card km-hour-empty" style="--km-accent:${color}">
          <div class="km-hour-top"><span class="km-hour-time">${lbl}</span></div>
          <div class="km-hour-pct">—</div>
          <div class="km-hour-empty-note">no orders</div>
        </div>`;
      }
      return `<div class="km-hour-card" style="--km-accent:${color}" title="${lbl} · ${h.pct}% SLA (${h.met}/${h.denom} IPO≤6)">
        <div class="km-hour-top"><span class="km-hour-time">${lbl}</span><span class="km-hour-dot"></span></div>
        <div class="km-hour-pct">${h.pct}<span class="km-hour-pct-unit">%</span></div>
        <div class="km-hour-stats">
          ${_kmHourStat(h.denom, 'orders')}
          ${_kmHourStat(breached, 'breached')}
          ${_kmHourStat(h.activePickers, 'pickers', h.hour, 'pickers')}
          ${ros != null ? _kmHourStat(ros, 'rostered', h.hour, 'roster') : _kmHourStat(0, 'rostered')}
        </div>
      </div>`;
    }).join('');
    return `
      <div class="km-card">
        <div class="km-hour-head">
          <h4 class="km-block-title" style="margin:0">Hourly Breakdown</h4>
          <div class="km-hour-legend">
            <span><i style="background:${_KM_GRADE_COLOR.below}"></i>below base</span>
            <span><i style="background:${_KM_GRADE_COLOR.baseline}"></i>baseline</span>
            <span><i style="background:${_KM_GRADE_COLOR.sla1}"></i>SLA 1</span>
            <span><i style="background:${_KM_GRADE_COLOR.sla2}"></i>SLA 2</span>
          </div>
        </div>
        <div class="km-hour-grid">${cells}</div>
      </div>`;
  }

  function _kmStageBars(byStage) {
    const max = Math.max(1, ...byStage.map(s => s.avgSec));
    const rows = byStage.map(s => `
      <div class="km-stage-row">
        <span class="km-stage-lbl">${s.label}</span>
        <div class="km-stage-track"><div class="km-stage-fill" style="width:${(s.avgSec / max * 100).toFixed(0)}%;"></div></div>
        <span class="km-stage-val">${compute.formatDuration(s.avgSec)}</span>
      </div>`).join('');
    return `
      <div class="km-card">
        <h4 class="km-block-title">Bottleneck Stage <span class="km-target-line">avg on breached orders</span></h4>
        ${rows}
      </div>`;
  }

  function _kmIpoBands(bands, tiers) {
    const rows = bands.map(b => `
      <div class="km-stage-row">
        <span class="km-stage-lbl">${b.label}</span>
        <div class="km-stage-track"><div class="km-stage-fill" style="width:${b.pct}%;background:${b.pct >= tiers.sla1 ? '#34d399' : b.pct >= tiers.baseline ? '#fbbf24' : '#f87171'};"></div></div>
        <span class="km-stage-val">${b.denom ? b.pct + '%' : '—'}</span>
      </div>`).join('');
    return `
      <div class="km-card">
        <h4 class="km-block-title">SLA % by Order Size</h4>
        ${rows}
      </div>`;
  }

  function _kmPickerTable(byPicker, nameOf, tiers) {
    if (!byPicker.length) return '<p class="placeholder-text">No picker data for this period.</p>';
    const rows = byPicker.map(p => {
      const tier = _kmTierReached(p.pct, tiers, 'high').tier;
      const color = _KM_GRADE_COLOR[tier];
      const breachCell = p.breached > 0
        ? `<button type="button" class="km-breach-btn" data-emp="${_esc(p.employee_id || '')}" aria-label="List breached orders for ${_esc(nameOf(p.employee_id))}">${_fmt(p.breached)}</button>`
        : _fmt(p.breached);
      return `<tr>
        <td>${_esc(nameOf(p.employee_id))}</td>
        <td data-sort="${p.orders}">${_fmt(p.orders)}</td>
        <td data-sort="${p.breached}">${breachCell}</td>
        <td data-sort="${p.pct}" class="km-grade-cell" style="color:${color};font-weight:700;">${p.pct}%</td>
        <td data-sort="${p.median || 0}">${p.median != null ? compute.formatDuration(p.median) : '—'}</td>
        <td data-sort="${p.p90 || 0}">${p.p90 != null ? compute.formatDuration(p.p90) : '—'}</td>
      </tr>`;
    }).join('');
    return `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Picker</th><th>Orders (IPO≤6)</th><th>Breached</th><th>SLA %</th><th>Median Time</th><th>P90 Time</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _kmComplaintSplit(inStore, outStore, total) {
    const inPct  = total > 0 ? +(inStore / total * 100).toFixed(1) : 0;
    const outPct = total > 0 ? +(outStore / total * 100).toFixed(1) : 0;
    return `
      <div class="km-card">
        <h4 class="km-block-title">In-Store (Picker Fault) vs Out-Store</h4>
        <div class="km-split-bar">
          <div class="km-split-seg" style="width:${inPct}%;background:#f87171;" title="In-store ${inPct}%"></div>
          <div class="km-split-seg" style="width:${outPct}%;background:#60a5fa;" title="Out-store ${outPct}%"></div>
        </div>
        <div class="km-split-legend">
          <span><i style="background:#f87171"></i> In-store ${_fmt(inStore)} (${inPct}%)</span>
          <span><i style="background:#60a5fa"></i> Out-store ${_fmt(outStore)} (${outPct}%)</span>
        </div>
        <p class="km-help">In-store complaints are picker-controllable. A high in-store share points coaching at the floor; a high out-store share points at upstream/quality.</p>
      </div>`;
  }

  function _kmComplaintCategories(byCategory, total) {
    const entries = Object.entries(byCategory || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<div class="km-card"><h4 class="km-block-title">Qualifying Categories</h4><p class="placeholder-text">No qualifying complaints this cycle.</p></div>`;
    const max = Math.max(1, ...entries.map(e => e[1]));
    const rows = entries.map(([cat, n]) => `
      <div class="km-stage-row">
        <span class="km-stage-lbl">${_esc(cat)}</span>
        <div class="km-stage-track"><div class="km-stage-fill" style="width:${(n / max * 100).toFixed(0)}%;background:#fbbf24;"></div></div>
        <span class="km-stage-val">${_fmt(n)} · ${total ? (n / total * 100).toFixed(1) : 0}%</span>
      </div>`).join('');
    return `
      <div class="km-card">
        <h4 class="km-block-title">Qualifying Categories</h4>
        ${rows}
      </div>`;
  }

  function _kmComplaintPickerTable(capRows, nameOf) {
    const rows = capRows
      .filter(c => c.totalComplaints > 0)
      .sort((a, b) => b.totalComplaints - a.totalComplaints)
      .map(c => `<tr>
        <td>${_esc(nameOf(c.employee_id))}</td>
        <td data-sort="${c.totalComplaints}">${_fmt(c.totalComplaints)}</td>
        <td data-sort="${c.inStoreYes}">${_fmt(c.inStoreYes)}</td>
        <td data-sort="${c.totalOrdersPicked}">${_fmt(c.totalOrdersPicked)}</td>
        <td data-sort="${c.complaintRate}">${c.complaintRate}%</td>
        <td>${_esc(c.topCategory)}</td>
      </tr>`).join('');
    if (!rows) return '<p class="placeholder-text">No qualifying complaints for this period.</p>';
    return `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Picker</th><th>Qualifying Items</th><th>In-Store</th><th>Orders</th><th>In-Store Rate</th><th>Top Category</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // Breached-orders drill-down for a picker (reuses the complaint-detail modal shell).
  function _showInstoreBreachDetail(empId) {
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const rows = _kmCycleRows
      .filter(r => (r.employee_id || '') === empId && (r.instore_seconds || 0) > THRESH)
      .sort((a, b) => (b.instore_seconds || 0) - (a.instore_seconds || 0));
    _closeKmDetail();
    if (!rows.length) return;

    const name = _kmPickerNames.get(empId) || empId || 'Unknown';
    const periodText = _kmDetailPeriod.start && _kmDetailPeriod.end
      ? `${_kmDetailPeriod.start} to ${_kmDetailPeriod.end}` : 'Selected period';

    const body = rows.map(r => `
      <tr>
        <td style="white-space:nowrap;">${_esc(r.dateIsoStr || '')}</td>
        <td>${_esc(r.order_id || '—')}</td>
        <td data-sort="${r.ipo || 0}">${_fmt(r.ipo)}</td>
        <td data-sort="${r.instore_seconds || 0}" style="font-weight:700;color:${_KM_GRADE_COLOR.below};">${compute.formatDuration(r.instore_seconds)}</td>
        <td data-sort="${r.hour ?? -1}">${r.hour != null ? String(r.hour).padStart(2, '0') + ':00' : '—'}</td>
        <td data-sort="${r.wait_sec || 0}">${r.wait_sec != null ? compute.formatDuration(r.wait_sec) : '—'}</td>
        <td data-sort="${r.pick_sec || 0}">${r.pick_sec != null ? compute.formatDuration(r.pick_sec) : '—'}</td>
        <td data-sort="${r.billing_sec || 0}">${r.billing_sec != null ? compute.formatDuration(r.billing_sec) : '—'}</td>
      </tr>`).join('');

    const modal = document.createElement('div');
    modal.id = 'km-detail-modal';
    modal.className = 'compl-detail-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="compl-detail-modal">
        <div class="compl-detail-header">
          <div>
            <p class="compl-detail-kicker">Breached Orders · in-store &gt; ${compute.formatDuration(THRESH)}</p>
            <h3>${_esc(name)}</h3>
            <p class="compl-detail-subtitle">${_esc(periodText)}</p>
          </div>
          <button type="button" class="compl-detail-close" aria-label="Close">&times;</button>
        </div>
        <div class="compl-detail-summary">
          <span>${_fmt(rows.length)} breached order${rows.length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-wrapper compl-detail-table-wrapper">
          <table class="data-table compl-detail-table">
            <thead><tr>
              <th>Date</th><th>Order ID</th><th>IPO</th><th>In-Store Time</th><th>Hour</th>
              <th>Assign Wait</th><th>Picking</th><th>Billing</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.compl-detail-close')?.addEventListener('click', _closeKmDetail);
    modal.addEventListener('click', (e) => { if (e.target === modal) _closeKmDetail(); });
    _kmDetailEscHandler = (e) => { if (e.key === 'Escape') _closeKmDetail(); };
    document.addEventListener('keydown', _kmDetailEscHandler);
    _initTableSort(modal.querySelector('.data-table'));
    modal.querySelector('.compl-detail-close')?.focus();
  }

  // Shared modal shell for Key Metrics drill-downs.
  function _kmOpenModal(kicker, heading, sub, summary, theadHtml, bodyHtml) {
    _closeKmDetail();
    const modal = document.createElement('div');
    modal.id = 'km-detail-modal';
    modal.className = 'compl-detail-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="compl-detail-modal">
        <div class="compl-detail-header">
          <div>
            <p class="compl-detail-kicker">${_esc(kicker)}</p>
            <h3>${_esc(heading)}</h3>
            <p class="compl-detail-subtitle">${_esc(sub)}</p>
          </div>
          <button type="button" class="compl-detail-close" aria-label="Close">&times;</button>
        </div>
        <div class="compl-detail-summary"><span>${summary}</span></div>
        <div class="table-wrapper compl-detail-table-wrapper">
          <table class="data-table compl-detail-table">
            <thead><tr>${theadHtml}</tr></thead>
            <tbody>${bodyHtml}</tbody>
          </table>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.compl-detail-close')?.addEventListener('click', _closeKmDetail);
    modal.addEventListener('click', (e) => { if (e.target === modal) _closeKmDetail(); });
    _kmDetailEscHandler = (e) => { if (e.key === 'Escape') _closeKmDetail(); };
    document.addEventListener('keydown', _kmDetailEscHandler);
    _initTableSort(modal.querySelector('.data-table'));
    modal.querySelector('.compl-detail-close')?.focus();
  }

  function _kmPeriodText() {
    return _kmDetailPeriod.start && _kmDetailPeriod.end
      ? `${_kmDetailPeriod.start} to ${_kmDetailPeriod.end}` : 'Selected period';
  }

  function _showHourPickersDetail(hour) {
    const rows = _kmPickerDetailForHour(hour);
    if (!rows.length) return;
    const lbl = `${String(hour).padStart(2, '0')}:00`;
    const body = rows.map(p => `<tr>
      <td>${_esc(_kmPickerNames.get(p.employee_id) || p.employee_id || 'Unknown')}</td>
      <td>${_esc(p.employee_id || '—')}</td>
      <td data-sort="${p.orders}">${_fmt(p.orders)}</td>
      <td data-sort="${p.breached}" style="color:${p.breached ? _KM_GRADE_COLOR.below : 'inherit'};font-weight:${p.breached ? '700' : '400'};">${_fmt(p.breached)}</td>
    </tr>`).join('');
    _kmOpenModal(`Active Pickers · ${lbl} slot · orders count IPO ≤ 6 only`, `${rows.length} picker${rows.length === 1 ? '' : 's'} (>1 order)`, _kmPeriodText(),
      `${_fmt(rows.length)} picker${rows.length === 1 ? '' : 's'}`,
      `<th>Picker</th><th>Captain ID</th><th>Orders in slot (IPO ≤ 6)</th><th>Breached</th>`, body);
  }

  function _showHourRosterDetail(hour) {
    const rows = _kmRosterDetailForHour(hour);
    if (!rows.length) return;
    const lbl = `${String(hour).padStart(2, '0')}:00`;
    const body = rows.map(c => `<tr>
      <td>${_esc(c.name || _kmPickerNames.get(c.employee_id) || c.employee_id || 'Unknown')}</td>
      <td>${_esc(c.employee_id || '—')}</td>
      <td>${_esc(c.shift || '—')}</td>
      <td data-sort="${c.days}">${_fmt(c.days)}</td>
    </tr>`).join('');
    _kmOpenModal(`Rostered · ${lbl} slot`, `${rows.length} captain${rows.length === 1 ? '' : 's'} rostered`, _kmPeriodText(),
      `${_fmt(rows.length)} captain${rows.length === 1 ? '' : 's'}`,
      `<th>Captain</th><th>Captain ID</th><th>Shift</th><th>Days rostered</th>`, body);
  }

  function _closeKmDetail() {
    document.getElementById('km-detail-modal')?.remove();
    if (_kmDetailEscHandler) {
      document.removeEventListener('keydown', _kmDetailEscHandler);
      _kmDetailEscHandler = null;
    }
  }

