/**
 * ui.js — DOM rendering: tabs, tables, dropdowns, summary cards
 *
 * Depends on: compute, charts, CONFIG
 * Called by: app (main orchestrator defined at bottom of this file)
 */

const ui = (() => {

  // ── Sort State (persists across re-renders) ───────────────────────────
  let _sortState = { col: null, dir: 'desc' };

  // ── Captain Profile State ─────────────────────────────────────────────
  let _cpDateMode = false; // false = preset active, true = custom date range
  let _cpView = 'daily';   // 'daily' | 'weekly' | 'monthly'
  const _CAPTAIN_COLORS = ['#adc6ff', '#ffca28', '#4edea3', '#c084fc', '#f9a8d4', '#c6c6ca'];
  let _selectedCaptains = []; // [{ id, name, color }]

  function _colorAlpha(hex, a) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── Deep Dive Captain Filter ───────────────────────────────────────────
  // 'all' | 'flagged' | 'ok'
  let _ddFilter = 'all';
  let _ddTierMode = 'off'; // 'off' | 'shift' | 'experience'
  let _ddShowPickingBreakdown = false; // show/hide Delay/Pick/Bill time columns

  function setDDFilter(val) {
    _ddFilter = (_ddFilter === val) ? 'all' : val;   // toggle off if already active
    renderDeepDive();
  }

  function toggleDDTier() {
    _ddTierMode = _ddTierMode === 'off' ? 'shift'
      : _ddTierMode === 'shift' ? 'experience' : 'off';
    _updateDDTierBtn();
    renderDeepDive();
  }

  function togglePickingBreakdown() {
    _ddShowPickingBreakdown = !_ddShowPickingBreakdown;
    renderDeepDive();
  }
  function _updateDDTierBtn() {
    const btn = document.getElementById('dd-tier-toggle');
    if (!btn) return;
    if (_ddTierMode === 'off') {
      btn.textContent = 'Group: Off';
      btn.className = 'btn tier-mode-btn dd-tier-off';
    } else if (_ddTierMode === 'shift') {
      btn.textContent = 'Shift-Based';
      btn.className = 'btn tier-mode-btn';
    } else {
      btn.textContent = 'Experience-Based';
      btn.className = 'btn tier-mode-btn experience';
    }
  }

  // ── Flow SD Thresholds ───────────────────────────────────────────────
  const _FT_DEFAULTS = { critical: 2, flagged: 1, borderline: 0.5 };
  const _FT_FLOWS    = ['picking', 'putting', 'audit', 'fnv'];

  function _getFlowThresholds(flow) {
    const stored = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
    return { ..._FT_DEFAULTS, ...(stored[flow] || {}) };
  }

  function _readFlowThresholdInputs() {
    const out = {};
    for (const flow of _FT_FLOWS) {
      out[flow] = {
        critical:   parseFloat(document.getElementById(`ft-${flow}-critical`)?.value)   || _FT_DEFAULTS.critical,
        flagged:    parseFloat(document.getElementById(`ft-${flow}-flagged`)?.value)    || _FT_DEFAULTS.flagged,
        borderline: parseFloat(document.getElementById(`ft-${flow}-borderline`)?.value) || _FT_DEFAULTS.borderline,
      };
    }
    return out;
  }

  function saveFlowThresholds() {
    const out = _readFlowThresholdInputs();
    localStorage.setItem('flowThresholds', JSON.stringify(out));
    const raw = sheets.getCached();
    if (raw.length > 0) {
      app.updateFlowThresholds(out, ui.filterSupervisors(raw));
    }
    const msg = document.getElementById('flow-thresholds-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
  }

  function resetFlowThresholds() {
    localStorage.removeItem('flowThresholds');
    renderConfigPanel();
    const raw = sheets.getCached();
    if (raw.length > 0) {
      app.updateFlowThresholds({}, ui.filterSupervisors(raw));
    }
  }

  // ── Supervisor Exclusion ─────────────────────────────────────────────
  let _excludeSupervisors = localStorage.getItem('excludeSupervisors') !== 'false'; // default true
  let _customExcludedIds  = new Set(JSON.parse(localStorage.getItem('customExcludedIds') || '[]'));

  function _supervisorFilter(rows) {
    if (!_excludeSupervisors) return rows;
    const s = new Set([...(CONFIG.SUPERVISOR_IDS || []), ..._customExcludedIds]);
    return rows.filter(r => !s.has(r.employee_id));
  }

  function _updateSupervisorBtn() {
    const btn = document.getElementById('supervisor-toggle');
    if (!btn) return;
    btn.classList.toggle('active', _excludeSupervisors);
    btn.textContent = _excludeSupervisors ? 'Excl. Captains' : 'Incl. Captains';
  }

  function toggleSupervisors() {
    _excludeSupervisors = !_excludeSupervisors;
    localStorage.setItem('excludeSupervisors', String(_excludeSupervisors));
    _updateSupervisorBtn();
    app.refresh();
  }

  function addExcludedId() {
    const input = document.getElementById('excl-id-input');
    if (!input) return;
    const val = input.value.trim().toUpperCase();
    if (!val) return;
    _customExcludedIds.add(val);
    localStorage.setItem('customExcludedIds', JSON.stringify([..._customExcludedIds]));
    input.value = '';
    renderConfigPanel();
    if (_excludeSupervisors) app.refresh();
  }

  function removeExcludedId(id) {
    _customExcludedIds.delete(id);
    localStorage.setItem('customExcludedIds', JSON.stringify([..._customExcludedIds]));
    renderConfigPanel();
    if (_excludeSupervisors) app.refresh();
  }

  // ── Theme Toggle ─────────────────────────────────────────────────────
  function _initTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }
  _initTheme();

  function toggleTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    }
    // Re-render current tab so charts pick up new theme colors
    // Re-render current tab so charts pick up new theme colors
    try { app.renderCurrentTab?.(); } catch (_) {}
  }

  function filterSupervisors(rows) { return _supervisorFilter(rows); }

  // ── Tab Switching ─────────────────────────────────────────────────────

  function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    const content = document.getElementById(`tab-${tabId}`);
    if (content) content.classList.remove('hidden');

    const btn = document.querySelector(`[data-tab="${tabId}"]`);
    if (btn) btn.classList.add('active');
  }

  // ── Store Overview ─────────────────────────────────────────────────────

  let _overviewDateMode = false;

  function initOverviewPeriods() {
    const data = app.getFlaggedData();
    const sel  = document.getElementById('overview-preset');
    if (!sel || !data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateMonthly(data);

    sel.innerHTML = [
      '<option value="all">All Time</option>',
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    // Default: full span
    const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      document.getElementById('overview-start').value = _isoDateStr(sortedDates[0]);
      document.getElementById('overview-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
    }
    _overviewDateMode = false;
  }

  function onOverviewPresetChange() {
    _overviewDateMode = false;
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal = document.getElementById('overview-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('overview-start').value = ds;
      document.getElementById('overview-end').value   = ds;
      _overviewDateMode = true;
      renderStoreOverview();
      return;
    }

    if (periodVal === 'all') {
      const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      if (sortedDates.length > 0) {
        document.getElementById('overview-start').value = _isoDateStr(sortedDates[0]);
        document.getElementById('overview-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
      }
    } else {
      const colonIdx   = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      const rows = data.filter(row => {
        if (!row.date) return false;
        if (periodType === 'W') return compute.aggregateWeekly([row]).some(w => w.week_key === periodKey);
        const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
        return ym === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('overview-start').value = _isoDateStr(dates[0]);
        document.getElementById('overview-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    }
    renderStoreOverview();
  }

  function onOverviewDateChange() {
    _overviewDateMode = true;
    renderStoreOverview();
  }

  function renderStoreOverview() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const auditData      = _supervisorFilter(sheets.getAuditCached() || []);
    const complaintsData = _supervisorFilter(sheets.getComplaintsCached() || []);

    // Filter by date range
    const startVal = document.getElementById('overview-start')?.value;
    const endVal   = document.getElementById('overview-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0)   : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999) : Infinity;
    const filtered      = data.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    const filteredAudit = auditData ? auditData.filter(r => r.date && r.date >= startMs && r.date <= endMs) : [];
    const filteredCompl = complaintsData ? complaintsData.filter(r => r.date && r.date >= startMs && r.date <= endMs) : [];

    const period = document.getElementById('overview-period')?.value || 'weekly';
    const aggregated = period === 'daily'
      ? compute.aggregateDaily(filtered, filteredAudit, filteredCompl)
      : period === 'weekly'
        ? compute.aggregateWeekly(filtered, filteredAudit, filteredCompl)
        : compute.aggregateMonthly(filtered, filteredAudit, filteredCompl);

    // Charts
    charts.renderOrdersHoursChart('chart-orders-hours', aggregated);
    charts.renderTimeMetricsChart('chart-time-metrics', aggregated);
    charts.renderPutawayChart('chart-putaway-hours', aggregated);
    charts.renderIPHChart('chart-iph', aggregated);
    charts.renderComplaintsChart('chart-complaints', aggregated);

    // Stat cards
    const totalOrders = aggregated.reduce((s,d) => s + (d.total_orders_picked||0), 0);
    const totalComplaints = aggregated.reduce((s,d) => s + (d.total_complaints||0), 0);
    const validPick = aggregated.filter(d => d.avg_total_time_per_order > 0);
    const avgPick = validPick.length ? validPick.reduce((s,d) => s + d.avg_total_time_per_order, 0) / validPick.length : 0;
    const validIPH = aggregated.filter(d => d.avg_iph > 0);
    const avgIPH = validIPH.length ? validIPH.reduce((s,d) => s + d.avg_iph, 0) / validIPH.length : 0;
    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    _set('stat-total-orders', totalOrders.toLocaleString());
    _set('stat-avg-pick-time', compute.formatDuration(avgPick));
    _set('stat-avg-iph', avgIPH.toFixed(1));
    _set('stat-total-complaints', totalComplaints.toLocaleString());

    // Table
    const title = document.getElementById('overview-table-title');
    if (title) title.textContent = period === 'daily' ? 'Daily Summary' : period === 'weekly' ? 'Weekly Summary' : 'Monthly Summary';

    _renderOverviewTable(aggregated, period);
  }

  function _renderOverviewTable(aggregated, period) {
    const head = document.getElementById('overview-table-head');
    const body = document.getElementById('overview-table-body');
    if (!head || !body) return;

    head.innerHTML = `<tr>
      <th>${period === 'daily' ? 'Date' : period === 'weekly' ? 'Week' : 'Month'}</th>
      <th>Captains</th>
      <th>Orders Picked</th>
      <th>PPI</th>
      <th>Picking Hours</th>
      <th>Avg Delay to Start</th>
      <th>Avg Pick Time</th>
      <th>Avg Billing Time</th>
      <th>Total Time / Order</th>
      <th>Putting Hours</th>
      <th>Putaway Qty</th>
      <th>Avg IPH</th>
      <th>Audit Hours</th>
      <th>Racks Audited</th>
      <th>Complaints</th>
      <th>In-Store</th>
      <th>In-Store %</th>
    </tr>`;

    body.innerHTML = aggregated.map(d => `<tr>
      <td>${d.label || d.week_key || d.month_key}</td>
      <td>${d.active_captains || 0}</td>
      <td>${_fmt(d.total_orders_picked)}</td>
      <td>${compute.formatDuration(d.avg_ppi)}</td>
      <td>${_fmt(d.total_picking_hours, 1)} h</td>
      <td>${compute.formatDuration(d.avg_assigned_to_started)}</td>
      <td>${compute.formatDuration(d.avg_picking_time_per_order)}</td>
      <td>${compute.formatDuration(d.avg_billing_time)}</td>
      <td>${compute.formatDuration(d.avg_total_time_per_order)}</td>
      <td>${_fmt(d.total_putting_hours, 1)} h</td>
      <td>${_fmt(d.total_putaway_qty)}</td>
      <td>${_fmt(d.avg_iph, 1)}</td>
      <td>${_fmt(d.total_audit_hours, 1)} h</td>
      <td>${_fmt(d.total_racks_audited)}</td>
      <td>${_fmt(d.total_complaints)}</td>
      <td>${_fmt(d.complaints_instore_yes)}</td>
      <td>${d.complaints_instore_rate ?? 0}%</td>
    </tr>`).join('');

    _initTableSort(document.getElementById('overview-table'));
  }

  function setOverviewPeriod(val) {
    const sel = document.getElementById('overview-period');
    if (sel) sel.value = val;
    renderStoreOverview();
  }

  // ── Captain Deep Dive ──────────────────────────────────────────────────

  // Tracks whether the user last interacted with the date pickers or the preset dropdown
  let _deepDiveDateMode = false; // false = preset, true = custom date range

  function initDeepDivePeriods() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateMonthly(data);

    const sel = document.getElementById('deep-dive-period');
    if (!sel) return;

    sel.innerHTML = [
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    // Set default date range to most recent 7 days in dataset
    const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      const lastDate  = sortedDates[sortedDates.length - 1];
      const firstDate = sortedDates[0];
      document.getElementById('deep-dive-end').value   = _isoDateStr(lastDate);
      document.getElementById('deep-dive-start').value = _isoDateStr(firstDate);
    }

    _deepDiveDateMode = false;
    renderDeepDive();
  }

  function onDeepDivePresetChange() {
    _deepDiveDateMode = false;
    // Sync the date pickers to match the selected preset range
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal = document.getElementById('deep-dive-period')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('deep-dive-start').value = ds;
      document.getElementById('deep-dive-end').value   = ds;
      _deepDiveDateMode = true;
      _ddFilter = 'all';
      renderDeepDive();
      return;
    }

    const colonIdx  = periodVal.indexOf(':');
    const periodType = periodVal.slice(0, colonIdx);
    const periodKey  = periodVal.slice(colonIdx + 1);
    const rows = data.filter(row => {
      if (!row.date) return false;
      if (periodType === 'D') return row.dateStr === periodKey;
      if (periodType === 'W') {
        const wk = compute.aggregateWeekly([row]);
        return wk.length > 0 && wk[0].week_key === periodKey;
      }
      const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
      return ym === periodKey;
    });
    if (rows.length > 0) {
      const dates = rows.map(r => r.date).sort((a,b) => a - b);
      document.getElementById('deep-dive-start').value = _isoDateStr(dates[0]);
      document.getElementById('deep-dive-end').value   = _isoDateStr(dates[dates.length - 1]);
    }
    _ddFilter = 'all';   // reset captain filter on preset change
    renderDeepDive();
  }

  function onDeepDiveDateChange() {
    _deepDiveDateMode = true;
    _ddFilter = 'all';   // reset captain filter on period change
    renderDeepDive();
  }

  function renderDeepDive() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const periodVal = document.getElementById('deep-dive-period')?.value;
    const flowFilter = document.getElementById('deep-dive-flow')?.value || 'all';
    const container  = document.getElementById('deep-dive-content');
    if (!container || !periodVal) return;

    // Filter rows to the selected period
    let filtered, periodType;

    if (_deepDiveDateMode) {
      // Custom date range from the calendar pickers
      const startVal = document.getElementById('deep-dive-start')?.value;
      const endVal   = document.getElementById('deep-dive-end')?.value;
      const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0) : -Infinity;
      const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999) : Infinity;
      filtered   = data.filter(row => row.date && row.date >= startMs && row.date <= endMs);
      // Use 'W' scoring logic for multi-day ranges (period avg vs store avg)
      const diffDays = startVal && endVal
        ? (new Date(endVal) - new Date(startVal)) / 86400000 : 30;
      periodType = 'W'; // always use period-relative scoring in date mode
    } else {
      const colonIdx  = periodVal.indexOf(':');
      periodType = periodVal.slice(0, colonIdx);
      const periodKey = periodVal.slice(colonIdx + 1);
      filtered = data.filter(row => {
        if (!row.date) return false;
        if (periodType === 'D') {
          return row.dateStr === periodKey;
        } else if (periodType === 'W') {
          const wk = compute.aggregateWeekly([row]);
          return wk.length > 0 && wk[0].week_key === periodKey;
        } else {
          const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
          return ym === periodKey;
        }
      });
    }

    // Build auditRacksMap for accurate rack counts (Audits sheet over Daily Metrics col H)
    const _auditRaw = sheets.getAuditCached() || [];
    const _filteredDateStrs = new Set(filtered.map(r => r.dateIsoStr).filter(Boolean));
    const auditRacksMap = new Map();
    for (const ar of _auditRaw) {
      if (ar.dateStr && _filteredDateStrs.has(ar.dateStr))
        auditRacksMap.set(`${ar.employee_id}_${ar.dateStr}`, ar.audit_codes.length);
    }

    // Captain-level rack totals directly from Audits sheet (same source as Inventory Health)
    const captainAuditRacks = new Map();
    for (const ar of _auditRaw) {
      if (ar.employee_id && ar.dateStr && _filteredDateStrs.has(ar.dateStr))
        captainAuditRacks.set(ar.employee_id, (captainAuditRacks.get(ar.employee_id) || 0) + ar.audit_codes.length);
    }

    // Compute period store stats (avg + SD) from the filtered rows
    const periodStoreStats = _computePeriodStoreStats(filtered, auditRacksMap);

    // Aggregate per captain for this period
    const byCaptain = _groupByCaptain(filtered, periodType, periodStoreStats, auditRacksMap, captainAuditRacks);

    // Apply captain filter (set by clicking summary cards)
    const visibleCaptains = _ddFilter === 'flagged'
      ? byCaptain.filter(c => c.composite_slacker_score >= 0.5)
      : _ddFilter === 'ok'
        ? byCaptain.filter(c => c.composite_slacker_score < 0.5)
        : byCaptain;

    // Populate DD summary cards
    const ddCards = document.getElementById('dd-summary-cards');
    if (ddCards) {
      const total = byCaptain.length;
      const flagged = byCaptain.filter(c => c.composite_slacker_score >= 0.5).length;
      const ok = total - flagged;
      const totalOrders = byCaptain.reduce((s,c) => s + (c.total_orders_picked||0), 0);
      const ddCardDefs = [
        { filter:'all',     icon: ICONS.person, label:'Active Captains', val: total.toLocaleString(),       cls:'stat-icon-blue',  valCss: '' },
        { filter:'flagged', icon: ICONS.flag,   label:'Flagged',         val: flagged,                      cls:'stat-icon-red',   valCss: flagged > 0 ? 'color:#ff5c5c' : '' },
        { filter:'ok',      icon: ICONS.check,  label:'At / Above Avg',  val: ok,                           cls:'stat-icon-green', valCss: 'color:#4edea3' },
        { filter:null,      icon: ICONS.box,    label:'Total Orders',    val: totalOrders.toLocaleString(), cls:'stat-icon-teal',  valCss: '' },
      ];
      ddCards.innerHTML = ddCardDefs.map(c => {
        const clickable = c.filter !== null;
        const isActive  = clickable && _ddFilter === c.filter;
        const onclick   = clickable ? `onclick="ui.setDDFilter('${c.filter}')"` : '';
        const activeCls = isActive  ? ' filter-active' : '';
        const cursorStl = clickable ? 'cursor:pointer;' : '';
        return `<div class="stat-card${activeCls}" ${onclick} style="${cursorStl}">
          <div class="stat-icon ${c.cls}">${c.icon}</div>
          <div>
            <p class="stat-label">${c.label}${isActive ? ' <span class="dd-filter-badge">filtered</span>' : ''}</p>
            <p class="stat-value" ${c.valCss ? `style="${c.valCss}"` : ''}>${c.val}</p>
          </div>
        </div>`;
      }).join('');
    }

    // Build tier map for captain grouping (if tier mode is active)
    let tierMap = null;
    if (_ddTierMode === 'shift') {
      const startVal = document.getElementById('deep-dive-start')?.value;
      const refDate = startVal ? new Date(startVal) : new Date();
      const _rosterSerial = s => { const n = parseFloat(s); return (!isNaN(n) && n > 1000) ? new Date(Math.round((n - 25569) * 86400000)) : null; };
      const bestEntry = new Map();
      for (const r of sheets.getRosterCached()) {
        if (!r.employee_id || !r.shift) continue;
        const shiftDate = _rosterSerial(r.start);
        if (!shiftDate || shiftDate > refDate) continue;
        const prev = bestEntry.get(r.employee_id);
        const prevDate = prev ? _rosterSerial(prev.start) : null;
        if (!prev || !prevDate || shiftDate > prevDate) bestEntry.set(r.employee_id, r);
      }
      tierMap = new Map([...bestEntry.values()].map(r => [r.employee_id, r.shift.toLowerCase()]));
    } else if (_ddTierMode === 'experience') {
      const startVal = document.getElementById('deep-dive-start')?.value;
      const periodStartMs = startVal ? new Date(startVal).setHours(0,0,0,0) : Infinity;
      const activeDayMap = {};
      for (const row of data) {
        if (!row.employee_id || !row.date || row.date >= periodStartMs) continue;
        (activeDayMap[row.employee_id] = activeDayMap[row.employee_id] || new Set()).add(row.dateStr);
      }
      const activeDayCounts = Object.fromEntries(
        Object.entries(activeDayMap).map(([id, s]) => [id, s.size])
      );
      tierMap = new Map(byCaptain.map(c => [c.employee_id, _classifyExpTier(activeDayCounts, c.employee_id)]));
    }

    container.innerHTML = '';

    const flows = flowFilter === 'all'
      ? ['picking', 'putting', 'audit', 'fnv']
      : [flowFilter];

    const flowMeta = {
      picking: { label: 'Picking Flow',   icon: ICONS.flowPicking, metrics: CONFIG.METRICS.filter(m => m.flow === 'picking') },
      putting: { label: 'Putting Flow',   icon: ICONS.flowPutting, metrics: CONFIG.METRICS.filter(m => m.flow === 'putting') },
      audit:   { label: 'Audit Flow',     icon: ICONS.flowAudit,   metrics: CONFIG.METRICS.filter(m => m.flow === 'audit') },
      fnv:     { label: 'FNV Audit Flow', icon: ICONS.flowFNV,     metrics: CONFIG.METRICS.filter(m => m.flow === 'fnv') },
    };

    for (const flow of flows) {
      const meta = flowMeta[flow];
      const captains = visibleCaptains.filter(c => c[`has_${flow}`]);
      if (captains.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'flow-section';
      const sectionHeader = flow === 'picking'
        ? `<div class="flow-section-header" style="display:flex;align-items:center;justify-content:space-between">
            <span>${meta.icon} ${meta.label} — ${captains.length} active captains</span>
            <button class="btn tier-mode-btn ${_ddShowPickingBreakdown ? '' : 'dd-tier-off'}"
                    onclick="ui.togglePickingBreakdown()">
              Breakdown: ${_ddShowPickingBreakdown ? 'On' : 'Off'}
            </button>
          </div>`
        : `<div class="flow-section-header">${meta.icon} ${meta.label} — ${captains.length} active captains</div>`;
      section.innerHTML = `
        ${sectionHeader}
        ${_buildDeepDiveTable(captains, meta.metrics, flow, periodStoreStats, tierMap)}
      `;
      container.appendChild(section);
    }

    if (container.innerHTML === '') {
      const msg = _ddFilter !== 'all'
        ? `No captains match the <strong>${_ddFilter === 'flagged' ? 'Flagged' : 'At / Above Avg'}</strong> filter for this period. <a href="#" onclick="ui.setDDFilter('all');return false;" style="color:#adc6ff">Clear filter</a>`
        : 'No active captains in the selected period/flow.';
      container.innerHTML = `<p class="placeholder-text">${msg}</p>`;
    }

    // Attach sort listeners — touchend for mobile (fires reliably inside scroll containers),
    // click for desktop. Guard prevents double-fire on touch devices.
    container.querySelectorAll('th[data-sort]').forEach(th => {
      function _doDeepDiveSort() {
        const col = th.dataset.sort;
        if (_sortState.col === col) {
          _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _sortState.col = col;
          _sortState.dir = 'desc';
        }
        renderDeepDive();
      }
      let _ddTouchMoved = false;
      th.addEventListener('touchstart', () => { _ddTouchMoved = false; }, { passive: true });
      th.addEventListener('touchmove',  () => { _ddTouchMoved = true;  }, { passive: true });
      th.addEventListener('touchend', (e) => {
        if (_ddTouchMoved) return;
        e.preventDefault();
        _doDeepDiveSort();
      }, { passive: false });
      let _ddLastTouch = 0;
      th.addEventListener('touchend', () => { _ddLastTouch = Date.now(); }, { passive: true });
      th.addEventListener('click', () => {
        if (Date.now() - _ddLastTouch < 500) return;
        _doDeepDiveSort();
      });
    });
  }

  function _groupByCaptain(rows, periodType, periodStoreStats, auditRacksMap, captainAuditRacks) {
    const map = {};
    for (const row of rows) {
      const id = row.employee_id;
      if (!map[id]) {
        map[id] = {
          employee_id: id,
          employee_name: row.employee_name,
          rows: [],
          has_picking: false,
          has_putting: false,
          has_audit: false,
          has_fnv: false,
          composite_slacker_score: 0,
          flags: new Map(),
          deviations: new Map(),
        };
      }
      map[id].rows.push(row);
      if (row.flows?.is_picking) map[id].has_picking = true;
      if (row.flows?.is_putting) map[id].has_putting = true;
      if (row.flows?.is_audit)   map[id].has_audit   = true;
      if (row.flows?.is_fnv)     map[id].has_fnv     = true;
      map[id]._scoreSum   = (map[id]._scoreSum   || 0) + (row.composite_slacker_score || 0);
      map[id]._scoreDays  = (map[id]._scoreDays  || 0) + 1;
    }

    // Compute per-captain period averages and scores
    return Object.values(map).map(captain => {

      // ── Step 1: Avg metric values for the period ──────────────────────
      captain.avgValues = {};
      for (const metric of CONFIG.METRICS) {
        const vals = captain.rows
          .map(r => metric.key === 'fnv_audit_rate' ? r.fnv_audit_rate : r[metric.key])
          .filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
        captain.avgValues[metric.key] = vals.length > 0
          ? vals.reduce((a, b) => a + b, 0) / vals.length
          : null;
      }

      // ── Step 2: Scores, flags, deviations ────────────────────────────
      if (periodType === 'D') {
        // Daily view: use the per-row flags/deviations already computed by flagSlackers.
        // Score = the single day's composite score (avg of 1 day = the day itself).
        captain.composite_slacker_score = captain._scoreDays > 0
          ? Math.round((captain._scoreSum / captain._scoreDays) * 10) / 10
          : 0;
        for (const metric of CONFIG.METRICS) {
          const devs = captain.rows.map(r => r.deviations?.get(metric.key))
            .filter(d => d !== null && d !== undefined);
          captain.deviations.set(metric.key, devs.length > 0 ? Math.max(...devs) : null);
          captain.flags.set(metric.key, captain.rows.some(r => r.flags?.get(metric.key)));
        }
      } else {
        // Weekly / Monthly view: compare captain's PERIOD average against
        // the period store average. No personal-avg gate — if their overall
        // week/month average is worse than the store by >threshold SDs, flag it.
        let periodScore = 0;
        for (const metric of CONFIG.METRICS) {
          const captainAvg = captain.avgValues[metric.key];
          const stats      = periodStoreStats?.get(metric.key);
          if (captainAvg === null || !stats || stats.avg === null ||
              stats.sd === null || stats.sd === 0) {
            captain.deviations.set(metric.key, null);
            captain.flags.set(metric.key, false);
            continue;
          }
          const devSD = metric.direction === 'HIGH'
            ? (captainAvg - stats.avg) / stats.sd   // positive = slower = worse
            : (stats.avg  - captainAvg) / stats.sd; // positive = lower  = worse
          captain.deviations.set(metric.key, devSD);
          // Floor check: flag if >FLOOR_DEVIATION worse than store mean, regardless of SD
          const floor = CONFIG.FLOOR_DEVIATION ?? 0.30;
          const floorFlagged = stats.avg > 0 && (
            metric.direction === 'LOW'
              ? captainAvg < stats.avg * (1 - floor)   // e.g. IPH < 70% of store avg
              : captainAvg > stats.avg * (1 + floor)   // e.g. HPR > 130% of store avg
          );
          const flagged = devSD > _getFlowThresholds(metric.flow).borderline || floorFlagged;
          captain.flags.set(metric.key, flagged);
          if (flagged) periodScore++;
        }
        captain.composite_slacker_score = periodScore;
      }

      // Flow-specific scores (each flow uses only its own metrics)
      captain.picking_score = CONFIG.METRICS.filter(m => m.flow === 'picking' && captain.flags.get(m.key)).length;
      captain.putting_score = CONFIG.METRICS.filter(m => m.flow === 'putting' && captain.flags.get(m.key)).length;
      captain.audit_score   = CONFIG.METRICS.filter(m => m.flow === 'audit'   && captain.flags.get(m.key)).length;
      captain.fnv_score     = CONFIG.METRICS.filter(m => m.flow === 'fnv'     && captain.flags.get(m.key)).length;

      // Picking extras
      captain.total_orders_picked = captain.rows
        .filter(r => r.flows?.is_picking)
        .reduce((s, r) => s + (r.checkout_orders || 0), 0);
      const ppiVals = captain.rows.filter(r => r.flows?.is_picking)
        .map(r => r.ppi).filter(v => v !== null && v > 0);
      captain.avg_ppi = ppiVals.length > 0
        ? ppiVals.reduce((a, b) => a + b, 0) / ppiVals.length : null;

      // Picking extras — picker hours
      captain.total_picker_hours = captain.rows
        .filter(r => r.flows?.is_picking)
        .reduce((s, r) => s + (r.picker_active_time || 0), 0) / 3600;

      // Putting extras
      captain.total_putaway_qty = captain.rows
        .filter(r => r.flows?.is_putting)
        .reduce((s, r) => s + (r.putaway_qty || 0), 0);
      captain.total_putter_hours = captain.rows
        .filter(r => r.flows?.is_putting)
        .reduce((s, r) => s + (r.putter_active_time || 0), 0) / 3600;

      // Audit extras — racks from Audits sheet directly (same source as Inventory Health)
      captain.total_racks_audited = captainAuditRacks?.get(captain.employee_id) || 0;
      captain.total_auditor_hours = captain.rows
        .filter(r => r.flows?.is_audit)
        .reduce((s, r) => s + (r.auditor_active_time || 0), 0) / 3600;
      // Override audit_hours_per_rack using accurate rack count from auditRacksMap
      captain.avgValues['audit_hours_per_rack'] = captain.total_racks_audited > 0 && captain.total_auditor_hours > 0
        ? captain.total_auditor_hours / captain.total_racks_audited : null;

      // ── Zero-output flags (time logged but no output) ────────────────────
      const _isPutter  = captain.rows.some(r => r.flows?.is_putting);
      const _isAuditor = captain.rows.some(r => r.flows?.is_audit);
      captain.zero_put   = _isPutter  && captain.total_putaway_qty === 0;
      captain.zero_audit = _isAuditor && captain.total_racks_audited === 0;
      if (captain.zero_put)   captain.putting_score++;
      if (captain.zero_audit) captain.audit_score++;

      // FNV extras
      const fnvVals = captain.rows.filter(r => r.flows?.is_fnv)
        .map(r => r.fnv_audit_rate).filter(v => v !== null && v > 0);
      captain.avg_fnv_rate = fnvVals.length > 0
        ? fnvVals.reduce((a, b) => a + b, 0) / fnvVals.length : null;
      captain.total_fnv_hours = captain.rows
        .filter(r => r.flows?.is_fnv)
        .reduce((s, r) => s + (r.fnv_active_time || 0), 0) / 3600;

      return captain;
    }).sort((a, b) => b.composite_slacker_score - a.composite_slacker_score);
  }

  // ── Period Store Stats ────────────────────────────────────────────────

  /**
   * Computes store-wide { avg, sd } for each metric using only
   * rows from the currently selected period.
   * Used for both period-level flagging and display of store avg.
   */
  function _computePeriodStoreStats(rows, auditRacksMap) {
    const result = new Map();
    for (const metric of CONFIG.METRICS) {
      const activeRows = rows.filter(r => {
        switch (metric.flow) {
          case 'picking': return r.flows?.is_picking;
          case 'putting': return r.flows?.is_putting;
          case 'audit':   return r.flows?.is_audit;
          case 'fnv':     return r.flows?.is_fnv;
          default:        return false;
        }
      });
      const vals = activeRows
        .map(r => {
          if (metric.key === 'fnv_audit_rate') return r.fnv_audit_rate;
          if (metric.key === 'audit_hours_per_rack') {
            const mapKey = `${r.employee_id}_${r.dateIsoStr}`;
            const racks = auditRacksMap?.get(mapKey) ?? (r.racks_audited || 0);
            return (r.auditor_active_time > 0 && racks > 0)
              ? (r.auditor_active_time / 3600) / racks : null;
          }
          return r[metric.key];
        })
        .filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
      if (vals.length === 0) { result.set(metric.key, { avg: null, sd: null }); continue; }
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd  = vals.length < 2 ? null
        : Math.sqrt(vals.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (vals.length - 1));
      result.set(metric.key, { avg, sd });
    }
    return result;
  }

  // ── Sort helpers ──────────────────────────────────────────────────────

  function _getSortValue(captain, col) {
    switch (col) {
      case 'name':         return (captain.employee_name || '').toLowerCase();
      case 'id':           return (captain.employee_id || '').toLowerCase();
      case 'score':        return captain.composite_slacker_score ?? 0;
      case 'pick_hours':   return captain.total_picker_hours ?? 0;
      case 'total_orders': return captain.total_orders_picked ?? 0;
      case 'avg_ppi':               return captain.avg_ppi ?? -Infinity;
      case 'total_time_per_order':  return captain.avgValues?.total_time_per_order ?? -Infinity;
      case 'putaway_qty':  return captain.total_putaway_qty ?? 0;
      case 'put_hours':    return captain.total_putter_hours ?? 0;
      case 'racks':        return captain.total_racks_audited ?? 0;
      case 'audit_hours':  return captain.total_auditor_hours ?? 0;
      case 'fnv_rate':     return captain.avg_fnv_rate ?? -Infinity;
      case 'fnv_hours':    return captain.total_fnv_hours ?? 0;
      default:             return captain.avgValues?.[col] ?? -Infinity;
    }
  }

  /**
   * Generic DOM table sorter.
   * Attaches asc/desc click sorting to every <th> in the table's <thead>.
   * Compares cell text numerically when both values parse as numbers,
   * otherwise lexicographically. "—" and empty cells sort last.
   */
  function _initTableSort(tableEl) {
    if (!tableEl) return;
    const ths = [...tableEl.querySelectorAll('thead th')];
    ths.forEach((th, colIdx) => {
      // Store original inner HTML once (guard against double-init)
      if (th.dataset.origHtml === undefined) th.dataset.origHtml = th.innerHTML;
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';

      // Core sort handler — shared by both click and touchend
      function _doSort() {
        const tbody = tableEl.querySelector('tbody');
        if (!tbody) return;
        const prevDir = th.dataset.sortDir || '';
        const dir = prevDir === 'asc' ? 'desc' : 'asc';
        // Reset all headers
        ths.forEach(t => {
          t.dataset.sortDir = '';
          t.innerHTML = t.dataset.origHtml;
        });
        th.dataset.sortDir = dir;
        th.innerHTML = th.dataset.origHtml + (dir === 'asc' ? ' <span style="opacity:0.7">▲</span>' : ' <span style="opacity:0.7">▼</span>');
        // Sort rows
        const rows = [...tbody.querySelectorAll('tr')];
        rows.sort((rowA, rowB) => {
          const aRaw = rowA.cells[colIdx]?.textContent?.trim() || '';
          const bRaw = rowB.cells[colIdx]?.textContent?.trim() || '';
          // Empty / dash → always last
          const aEmpty = aRaw === '' || aRaw === '—';
          const bEmpty = bRaw === '' || bRaw === '—';
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return 1;
          if (bEmpty) return -1;
          // Strip non-numeric chars (commas, units like "h", "%") and try numeric compare
          const aNum = parseFloat(aRaw.replace(/[^0-9.-]/g, ''));
          const bNum = parseFloat(bRaw.replace(/[^0-9.-]/g, ''));
          const numeric = !isNaN(aNum) && !isNaN(bNum);
          if (numeric) return dir === 'asc' ? aNum - bNum : bNum - aNum;
          return dir === 'asc' ? aRaw.localeCompare(bRaw) : bRaw.localeCompare(aRaw);
        });
        rows.forEach(r => tbody.appendChild(r));
      }

      // touchend fires immediately and reliably on mobile, even inside scrollable
      // containers where the browser might swallow the synthetic click event.
      // preventDefault() stops the browser from also firing a click afterward.
      let _touchMoved = false;
      th.addEventListener('touchstart', () => { _touchMoved = false; }, { passive: true });
      th.addEventListener('touchmove',  () => { _touchMoved = true;  }, { passive: true });
      th.addEventListener('touchend', (e) => {
        if (_touchMoved) return;   // was a scroll gesture, not a tap
        e.preventDefault();        // block the subsequent synthetic click
        _doSort();
      }, { passive: false });

      // click handles desktop mice and keyboard Enter/Space on focused th
      let _lastTouchEnd = 0;
      th.addEventListener('touchend', () => { _lastTouchEnd = Date.now(); }, { passive: true });
      th.addEventListener('click', () => {
        if (Date.now() - _lastTouchEnd < 500) return; // already handled by touchend
        _doSort();
      });
    });
  }

  function _applySortIndicator(col, activeCol, dir) {
    if (col !== activeCol) return '';
    return dir === 'asc' ? ' ▲' : ' ▼';
  }

  function _sortedCaptains(captains, col) {
    if (!col) return captains;
    return [...captains].sort((a, b) => {
      const va = _getSortValue(a, col);
      const vb = _getSortValue(b, col);
      if (typeof va === 'string') {
        return _sortState.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return _sortState.dir === 'asc' ? va - vb : vb - va;
    });
  }

  function _thSort(label, col, flow) {
    const indicator = _applySortIndicator(col, _sortState.col, _sortState.dir);
    const active = col === _sortState.col ? 'style="color:#adc6ff"' : '';
    return `<th data-sort="${col}" data-flow="${flow}" ${active}>${label}${indicator}</th>`;
  }

  function _initials(name) {
    return (name || '?').split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase();
  }

  function _captainCell(name, id) {
    return `<td>
      <div class="captain-cell">
        <div class="captain-avatar">${_initials(name)}</div>
        <div>
          <div class="captain-name">${_esc(name)}</div>
          <div class="captain-id">${_esc(id)}</div>
        </div>
      </div>
    </td>`;
  }

  function _scoreBadge(score) {
    if (score >= 1.5) return `<span class="score-badge score-badge-critical">${score}</span>`;
    if (score >= 0.5) return `<span class="score-badge score-badge-warn">${score}</span>`;
    return `<span class="score-badge score-badge-ok">${score}</span>`;
  }

  function _statusBadge(score) {
    if (score >= 1.5) return `<span class="status-badge status-critical">Critical</span>`;
    if (score >= 0.5) return `<span class="status-badge status-flagged">Flagged</span>`;
    return `<span class="status-badge status-ok">Stable</span>`;
  }

  // SD-aware badge used in flow tables: maps devSD directly against per-flow thresholds
  function _statusBadgeByDev(devSD, flow, isZero = false) {
    if (isZero) return `<span class="status-badge status-flagged">Flagged</span>`;
    if (devSD === null || devSD === undefined) return `<span class="status-badge status-ok">Stable</span>`;
    const ft = _getFlowThresholds(flow);
    if (devSD > ft.critical)   return `<span class="status-badge status-critical">Critical</span>`;
    if (devSD > ft.flagged)    return `<span class="status-badge status-flagged">Flagged</span>`;
    if (devSD > ft.borderline) return `<span class="status-badge status-borderline">Borderline</span>`;
    return `<span class="status-badge status-ok">Stable</span>`;
  }

  function _groupAndBuildRows(sorted, tierMap, colCount, buildRowFn) {
    if (!tierMap) return sorted.map(buildRowFn).join('');
    const tierOrder = _ddTierMode === 'shift'
      ? ['morning', 'evening', 'night']
      : ['new', 'experienced', 'senior'];
    const tierLabels = _ddTierMode === 'shift'
      ? { morning: 'Morning', evening: 'Evening', night: 'Night' }
      : { new: 'New', experienced: 'Experienced', senior: 'Senior' };
    const tierColors = _ddTierMode === 'shift'
      ? { morning: '#fb923c', evening: '#adc6ff', night: '#c084fc' }
      : { new: '#4edea3', experienced: '#adc6ff', senior: '#c084fc' };
    let html = '';
    for (const tier of tierOrder) {
      const group = sorted.filter(c => tierMap.get(c.employee_id) === tier);
      if (group.length === 0) continue;
      html += `<tr class="dd-tier-divider"><td colspan="${colCount}">
        <span class="dd-tier-pip" style="background:${tierColors[tier]}"></span>
        ${tierLabels[tier]} — ${group.length} captains
      </td></tr>`;
      html += group.map(buildRowFn).join('');
    }
    return html;
  }

  function _buildDeepDiveTable(captains, metrics, flow, periodStoreStats, tierMap) {
    if (flow === 'picking') return _buildPickingTable(captains, periodStoreStats, tierMap);
    if (flow === 'putting') return _buildPuttingTable(captains, periodStoreStats, tierMap);
    if (flow === 'audit')   return _buildAuditTable(captains, periodStoreStats, tierMap);
    if (flow === 'fnv')     return _buildFNVTable(captains, tierMap);
    return '';
  }

  function _buildPickingTable(captains, periodStoreStats, tierMap) {
    const allPickingMetrics = [
      CONFIG.METRICS.find(m => m.key === 'assigned_to_started_per_order'),
      CONFIG.METRICS.find(m => m.key === 'picking_time_per_order'),
      CONFIG.METRICS.find(m => m.key === 'billing_time_per_order'),
      CONFIG.METRICS.find(m => m.key === 'total_time_per_order'),
    ].filter(Boolean);
    const _breakdownKeys = new Set([
      'assigned_to_started_per_order',
      'picking_time_per_order',
      'billing_time_per_order',
    ]);
    const orderedMetrics = _ddShowPickingBreakdown
      ? allPickingMetrics
      : allPickingMetrics.filter(m => !_breakdownKeys.has(m.key));

    const metricSortKeys = {
      'assigned_to_started_per_order': 'assigned_to_started_per_order',
      'picking_time_per_order': 'picking_time_per_order',
      'billing_time_per_order': 'billing_time_per_order',
      'total_time_per_order': 'total_time_per_order',
    };

    const headers = `
      ${_thSort('Captain', 'name', 'picking')}
      ${_thSort('Picker Hours', 'pick_hours', 'picking')}
      ${_thSort('Total Orders', 'total_orders', 'picking')}
      ${_thSort('PPI<br/><small style="font-weight:400;opacity:0.8">sec/item</small>', 'avg_ppi', 'picking')}
      ${orderedMetrics.map(m =>
        _thSort(`${m.label}<br/><small style="font-weight:400;opacity:0.8">actual | personal | store</small>`, metricSortKeys[m.key], 'picking')
      ).join('')}
    `;
    // colCount: Captain + Picker Hours + Orders + PPI + 4 metrics + Status = 9
    const colCount = 4 + orderedMetrics.length + 1;

    const sorted = _sortedCaptains(captains, _sortState.col);
    const buildRow = captain => {
      const metricCells = orderedMetrics.map(metric => {
        const dev     = captain.deviations.get(metric.key);
        const cls     = compute.deviationClass(dev, _getFlowThresholds(metric.flow));
        const actual  = captain.avgValues[metric.key];
        const flagged = captain.flags.get(metric.key);
        const personalAvg = app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key);
        const storeAvg    = periodStoreStats?.get(metric.key)?.avg ?? null;
        const fmt = v => (v === null || v === undefined) ? '—'
          : metric.isDuration ? compute.formatDuration(v) : _fmt(v, 1);
        return `<td class="${cls}" title="${flagged ? 'Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ` <span style="opacity:0.7;vertical-align:middle">${ICONS.flagSm}</span>` : ''}
        </td>`;
      }).join('');

      return `<tr>
        ${_captainCell(captain.employee_name, captain.employee_id)}
        <td>${_fmt(captain.total_picker_hours, 1)} h</td>
        <td>${_fmt(captain.total_orders_picked)}</td>
        <td>${captain.avg_ppi !== null ? _fmt(captain.avg_ppi, 2) : '—'}</td>
        ${metricCells}
        <td>${_statusBadgeByDev(
          orderedMetrics.reduce((max, m) => {
            const d = captain.deviations.get(m.key);
            return (d !== null && d !== undefined && d > (max ?? -Infinity)) ? d : max;
          }, null),
          'picking'
        )}</td>
      </tr>`;
    };
    const rows = _groupAndBuildRows(sorted, tierMap, colCount, buildRow);

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>${headers}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildPuttingTable(captains, periodStoreStats, tierMap) {
    const metric = CONFIG.METRICS.find(m => m.key === 'iph');
    const sorted = _sortedCaptains(captains, _sortState.col);
    const buildRow = captain => {
      const dev     = metric ? captain.deviations.get(metric.key) : null;
      const cls     = compute.deviationClass(dev, _getFlowThresholds('putting'));
      const actual  = metric ? captain.avgValues[metric.key] : null;
      const flagged = metric ? captain.flags.get(metric.key) : false;
      const personalAvg = metric ? app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key) : null;
      const storeAvg    = metric ? (periodStoreStats?.get(metric.key)?.avg ?? null) : null;
      const fmt = v => (v === null || v === undefined) ? '—' : _fmt(v, 1);

      return `<tr>
        ${_captainCell(captain.employee_name, captain.employee_id)}
        <td class="${captain.zero_put ? 'cell-red' : ''}">${_fmt(captain.total_putaway_qty)}</td>
        <td>${_fmt(captain.total_putter_hours, 1)} h</td>
        <td class="${cls}" title="${flagged ? '🚩 Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ` <span style="opacity:0.7;vertical-align:middle">${ICONS.flagSm}</span>` : ''}
        </td>
        <td>${_statusBadgeByDev(captain.deviations.get('iph'), 'putting', captain.zero_put)}</td>
      </tr>`;
    };
    const rows = _groupAndBuildRows(sorted, tierMap, 5, buildRow);

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'putting')}
        ${_thSort('Putaway Qty', 'putaway_qty', 'putting')}
        ${_thSort('Putter Hours', 'put_hours', 'putting')}
        ${_thSort('Items Put Away/Hr<br/><small style="font-weight:400;opacity:0.7">actual | personal | store</small>', 'iph', 'putting')}
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildAuditTable(captains, periodStoreStats, tierMap) {
    const metric = CONFIG.METRICS.find(m => m.key === 'audit_hours_per_rack');
    const sorted = _sortedCaptains(captains, _sortState.col);
    const buildRow = captain => {
      const dev     = metric ? captain.deviations.get(metric.key) : null;
      const cls     = compute.deviationClass(dev, _getFlowThresholds('audit'));
      const actual  = metric ? captain.avgValues[metric.key] : null;
      const flagged = metric ? captain.flags.get(metric.key) : false;
      const personalAvg = metric ? app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key) : null;
      const storeAvg    = metric ? (periodStoreStats?.get(metric.key)?.avg ?? null) : null;
      const fmt = v => (v === null || v === undefined) ? '—' : _fmt(v, 2);

      return `<tr>
        ${_captainCell(captain.employee_name, captain.employee_id)}
        <td class="${captain.zero_audit ? 'cell-red' : ''}">${_fmt(captain.total_racks_audited)}</td>
        <td>${_fmt(captain.total_auditor_hours, 1)} h</td>
        <td class="${cls}" title="${flagged ? 'Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ` <span style="opacity:0.7;vertical-align:middle">${ICONS.flagSm}</span>` : ''}
        </td>
        <td>${_statusBadgeByDev(captain.deviations.get('audit_hours_per_rack'), 'audit', captain.zero_audit)}</td>
      </tr>`;
    };
    const rows = _groupAndBuildRows(sorted, tierMap, 5, buildRow);

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'audit')}
        ${_thSort('Racks Audited', 'racks', 'audit')}
        ${_thSort('Auditor Hours', 'audit_hours', 'audit')}
        ${_thSort('Audit Efficiency<br/><small style="font-weight:400;opacity:0.7">actual | personal | store (hr/rack)</small>', 'audit_hours_per_rack', 'audit')}
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildFNVTable(captains, tierMap) {
    const sorted = _sortedCaptains(captains, _sortState.col);
    const buildRow = captain => `<tr>
      ${_captainCell(captain.employee_name, captain.employee_id)}
      <td>${captain.avg_fnv_rate !== null ? _fmt(captain.avg_fnv_rate, 1) : '—'}</td>
      <td>${_fmt(captain.total_fnv_hours, 1)} h</td>
    </tr>`;
    const rows = _groupAndBuildRows(sorted, tierMap, 3, buildRow);

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'fnv')}
        ${_thSort('FNV Audit Rate (avg)', 'fnv_rate', 'fnv')}
        ${_thSort('FNV Hours', 'fnv_hours', 'fnv')}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  // ── Daily Flags ────────────────────────────────────────────────────────

  function initFlagsDate() {
    const input = document.getElementById('flags-date');
    if (!input) return;
    // Default to the most recent date available in the dataset
    const data = app.getFlaggedData();
    if (data && data.length > 0) {
      const dates = data.map(r => r.date).filter(Boolean).sort((a, b) => b - a);
      if (dates.length > 0) {
        input.value = _isoDateStr(dates[0]);
        renderDailyFlags();
        return;
      }
    }
    // Fallback to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    input.value = _isoDateStr(yesterday);
    renderDailyFlags();
  }

  function renderDailyFlags() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const dateInput = document.getElementById('flags-date');
    const selectedDate = dateInput?.value;
    if (!selectedDate) return;

    const dayRows = data.filter(r => r.date && _isoDateStr(r.date) === selectedDate);

    // ── Bento metric counts ────────────────────────────────────────────
    const totalActive  = new Set(dayRows.map(r => r.employee_id)).size;
    const flaggedCount = new Set(dayRows.filter(r => r.composite_slacker_score > 0).map(r => r.employee_id)).size;
    const serialCount  = new Set(dayRows.filter(r => r.composite_slacker_score >= 2).map(r => r.employee_id)).size;
    const pickSlackers = new Set(dayRows.filter(r =>
      r.flags?.get('picking_time_per_order') || r.flags?.get('assigned_to_started_per_order') ||
      r.flags?.get('billing_time_per_order') || r.flags?.get('ppi')
    ).map(r => r.employee_id)).size;
    const putSlackers  = new Set(dayRows.filter(r => r.flags?.get('iph')).map(r => r.employee_id)).size;
    const okCount      = totalActive - flaggedCount;

    const cardsEl = document.getElementById('flags-summary-cards');
    if (cardsEl) {
      cardsEl.innerHTML = `
        <div class="flags-metric-card accent-blue">
          <div class="flags-metric-label">Active Captains</div>
          <div class="flags-metric-row">
            <span class="flags-metric-value small color-blue">${totalActive}</span>
            <span class="flags-metric-sub" style="color:#4edea3">▲ ${okCount} Stable</span>
          </div>
        </div>
        <div class="flags-metric-card accent-amber">
          <div class="flags-metric-label">Flagged</div>
          <div class="flags-metric-row">
            <span class="flags-metric-value small color-amber">${flaggedCount}</span>
          </div>
          <div class="flags-metric-sub">${pickSlackers} picking · ${putSlackers} putting</div>
        </div>
        <div class="flags-metric-card accent-red">
          <div class="flags-metric-label">Serial Slackers</div>
          <div class="flags-metric-row">
            <span class="flags-metric-value small color-red">${String(serialCount).padStart(2,'0')}</span>
          </div>
          <div class="flags-metric-sub">2+ flags today</div>
        </div>
      `;
    }

    // ── Flagged captain cards ──────────────────────────────────────────
    const byCaptain = {};
    for (const row of dayRows) {
      if (row.composite_slacker_score === 0) continue;
      const id = row.employee_id;
      if (!byCaptain[id] || row.composite_slacker_score > byCaptain[id].composite_slacker_score) {
        byCaptain[id] = row;
      }
    }

    const sortedFlagged = Object.values(byCaptain)
      .sort((a, b) => b.composite_slacker_score - a.composite_slacker_score);

    const listEl = document.getElementById('flags-table-body');
    if (!listEl) return;

    if (sortedFlagged.length === 0) {
      listEl.innerHTML = `<p class="placeholder-text">No flagged captains on ${selectedDate}.</p>`;
      return;
    }

    listEl.innerHTML = sortedFlagged.map(row => {
      const score    = row.composite_slacker_score;
      const isCrit   = score >= 2;
      const severity = isCrit ? 'severity-critical' : 'severity-flagged';
      const avCls    = isCrit ? 'critical' : '';
      const worstDev = row.worst_deviation !== null ? row.worst_deviation.toFixed(1) + ' SD' : '—';

      // Active flows as small tags
      const flows = (row.active_flows || '').split(',').map(f => f.trim()).filter(Boolean);
      const flowTags = flows.map(f => `<span class="flags-tag flow">${_esc(f)}</span>`).join('');

      // Flagged metrics as alert tags
      const flaggedMetrics = (row.flagged_metrics_list || '').split(',').map(m => m.trim()).filter(Boolean);
      const metricTags = flaggedMetrics.map(m =>
        `<span class="flags-tag ${isCrit ? 'alert' : 'warn'}">${_esc(m)}</span>`
      ).join('');

      return `
        <div class="flags-captain-card ${severity}">
          <div class="flags-captain-avatar ${avCls}">${_initials(row.employee_name)}</div>
          <div class="flags-captain-body">
            <div class="flags-captain-top">
              <div>
                <div class="flags-captain-name">${_esc(row.employee_name)}</div>
                <div class="flags-captain-meta">${_esc(row.employee_id)} · ${flows.length || 0} flow${flows.length !== 1 ? 's' : ''}</div>
              </div>
              ${_statusBadge(score)}
            </div>
            <div class="flags-tag-row">
              ${flowTags}
              ${metricTags || `<span class="flags-tag warn">No metric detail</span>`}
            </div>
          </div>
          <div class="flags-score-col">
            ${_scoreBadge(score)}
            <div class="flags-dev-label">${worstDev}</div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Tier Analysis ──────────────────────────────────────────────────────

  let _tierDateMode = false;
  let _tierMode = 'time'; // 'time' | 'experience'
  let _tierGroupRows = {}; // snapshot for popover access

  function initTiersView() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateMonthly(data);
    const sel = document.getElementById('tiers-period');
    if (!sel) return;

    sel.innerHTML = [
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      document.getElementById('tiers-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
      document.getElementById('tiers-start').value = _isoDateStr(sortedDates[0]);
    }
    _tierDateMode = false;
    _updateTierModeBtn();
    renderTiersView();
  }

  function onTierPresetChange() {
    _tierDateMode = false;
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal  = document.getElementById('tiers-period')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('tiers-start').value = ds;
      document.getElementById('tiers-end').value   = ds;
      _tierDateMode = true;
      renderTiersView();
      return;
    }

    const colonIdx   = periodVal.indexOf(':');
    const periodType = periodVal.slice(0, colonIdx);
    const periodKey  = periodVal.slice(colonIdx + 1);
    const rows = data.filter(row => {
      if (!row.date) return false;
      if (periodType === 'D') return row.dateStr === periodKey;
      if (periodType === 'W') {
        const wk = compute.aggregateWeekly([row]);
        return wk.length > 0 && wk[0].week_key === periodKey;
      }
      const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
      return ym === periodKey;
    });
    if (rows.length > 0) {
      const dates = rows.map(r => r.date).sort((a, b) => a - b);
      document.getElementById('tiers-start').value = _isoDateStr(dates[0]);
      document.getElementById('tiers-end').value   = _isoDateStr(dates[dates.length - 1]);
    }
    renderTiersView();
  }

  function onTierDateChange() {
    _tierDateMode = true;
    renderTiersView();
  }

  function toggleTierMode() {
    _tierMode = _tierMode === 'time' ? 'experience' : 'time';
    _updateTierModeBtn();
    renderTiersView();
  }

  function _updateTierModeBtn() {
    const btn = document.getElementById('tier-mode-toggle');
    if (!btn) return;
    btn.textContent = _tierMode === 'time' ? 'Shift-Based Tiers' : 'Experience-Based Tiers';
    btn.classList.toggle('experience', _tierMode === 'experience');
  }

  function _filterTierRows(data) {
    if (_tierDateMode) {
      const startVal = document.getElementById('tiers-start')?.value;
      const endVal   = document.getElementById('tiers-end')?.value;
      const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0) : -Infinity;
      const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999) :  Infinity;
      return data.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    }
    const periodVal = document.getElementById('tiers-period')?.value;
    if (!periodVal) return data;
    const colonIdx  = periodVal.indexOf(':');
    const type = periodVal.slice(0, colonIdx);
    const key  = periodVal.slice(colonIdx + 1);
    return data.filter(row => {
      if (!row.date) return false;
      if (type === 'D') return row.dateStr === key;
      if (type === 'W') {
        const wk = compute.aggregateWeekly([row]);
        return wk.length > 0 && wk[0].week_key === key;
      }
      const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
      return ym === key;
    });
  }

  function _classifyCaptain(activeDayMap, empId) {
    const id = String(empId).toUpperCase();
    if (id.startsWith('GCEBOD')) return 'od';
    if (id.startsWith('GCEB'))   return 'blinkit';
    const days = activeDayMap[empId] || 0;
    if (days < 30)  return 'new';
    if (days < 120) return 'experienced';
    return 'senior';
  }

  function _classifyExpTier(activeDayCounts, empId) {
    const days = activeDayCounts[empId] || 0;
    if (days < 30)  return 'new';
    if (days < 120) return 'experienced';
    return 'senior';
  }

  function _tierMetrics(rows, auditRacksMap) {
    const pickRows  = rows.filter(r => r.flows?.is_picking);
    const putRows   = rows.filter(r => r.flows?.is_putting);
    const auditRows = rows.filter(r => r.flows?.is_audit);
    const captains  = new Set(rows.map(r => r.employee_id));

    const avg = (arr, key) => {
      const vals = arr.map(r => r[key]).filter(v => v != null && !isNaN(v) && v > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);

    // Weighted avg PPI (weighted by orders picked per row)
    const totalPickOrders = sum(pickRows, 'checkout_orders');
    const weightedAvgPPI  = totalPickOrders > 0
      ? pickRows.reduce((s, r) => s + ((r.ppi > 0 ? r.ppi : 0) * (r.checkout_orders || 0)), 0) / totalPickOrders
      : null;

    // Weighted averages by order count (same pattern as weightedAvgPPI)
    const wAvg = (rows, key) => {
      const tot = sum(rows, 'checkout_orders');
      if (!tot) return null;
      const s = rows.reduce((acc, r) => acc + ((r[key] > 0 ? r[key] : 0) * (r.checkout_orders || 0)), 0);
      return s / tot;
    };
    const avgDelay = wAvg(pickRows, 'assigned_to_started_per_order');
    const avgPick  = wAvg(pickRows, 'picking_time_per_order');
    const avgBill  = wAvg(pickRows, 'billing_time_per_order');
    // Compute total time from components to avoid bad raw data
    const avgTotal = (avgDelay != null && avgPick != null && avgBill != null)
      ? avgDelay + avgPick + avgBill : null;

    const totalPutQty   = sum(putRows,   'putaway_qty');
    const totalPutHrs   = sum(putRows,   'putter_active_time') / 3600;
    const totalRacks    = auditRows.reduce((s, r) => {
      const mapKey = `${r.employee_id}_${r.dateIsoStr}`;
      const mapRacks = auditRacksMap?.get(mapKey);
      return s + (mapRacks !== undefined ? mapRacks : (r.racks_audited || 0));
    }, 0);
    const totalAuditHrs = sum(auditRows, 'auditor_active_time') / 3600;

    return {
      captainCount:          captains.size,
      totalOrders:           totalPickOrders,
      weightedAvgPPI,
      avgDelayToStart:       avgDelay,
      avgPickTime:           avgPick,
      avgBillingTime:        avgBill,
      avgTotalTime:          avgTotal,
      totalPickerActiveTime: sum(pickRows, 'picker_active_time') / 3600,
      totalPutawayQty:       totalPutQty,
      iph:                   totalPutHrs > 0 ? totalPutQty / totalPutHrs : null,
      totalPutHours:         totalPutHrs,
      totalRacks,
      hpr:                   totalRacks > 0 ? totalAuditHrs / totalRacks : null,
      totalAuditHours:       totalAuditHrs,
      avgScore:              rows.length ? rows.reduce((s, r) => s + (r.composite_slacker_score || 0), 0) / rows.length : null,
    };
  }

  function renderTiersView() {
    const data = app.getFlaggedData();
    const container = document.getElementById('tiers-content');
    if (!data || data.length === 0 || !container) return;

    // Active-day counts before period start (for experience tier)
    const startVal = document.getElementById('tiers-start')?.value;
    const periodStartMs = startVal ? new Date(startVal).setHours(0,0,0,0) : Infinity;
    const activeDayMap = {};
    for (const row of data) {
      if (!row.employee_id || !row.date || row.date >= periodStartMs) continue;
      (activeDayMap[row.employee_id] = activeDayMap[row.employee_id] || new Set()).add(row.dateStr);
    }
    const activeDayCounts = Object.fromEntries(
      Object.entries(activeDayMap).map(([id, s]) => [id, s.size])
    );

    const filtered = _filterTierRows(data);
    if (!filtered.length) {
      container.innerHTML = '<p class="placeholder-text">No data for selected period.</p>';
      return;
    }

    // Build auditRacksMap for accurate rack counts (Audits sheet over Daily Metrics col H)
    const _tierAuditRaw = sheets.getAuditCached() || [];
    const _tierDateStrs = new Set(filtered.map(r => r.dateIsoStr).filter(Boolean));
    const auditRacksMap = new Map();
    for (const ar of _tierAuditRaw) {
      if (ar.dateStr && _tierDateStrs.has(ar.dateStr))
        auditRacksMap.set(`${ar.employee_id}_${ar.dateStr}`, ar.audit_codes.length);
    }

    let groupDefs, groupRows, groupLabel, rosterMap = new Map();

    if (_tierMode === 'time') {
      // Pick each captain's most recent roster entry on or before the period start.
      const refDate = startVal ? new Date(startVal) : new Date();
      const _rosterSerial = s => {
        const n = parseFloat(s);
        return (!isNaN(n) && n > 1000) ? new Date(Math.round((n - 25569) * 86400000)) : null;
      };
      const bestEntry = new Map();
      for (const r of sheets.getRosterCached()) {
        if (!r.employee_id || !r.shift) continue;
        const shiftDate = _rosterSerial(r.start);
        if (!shiftDate || shiftDate > refDate) continue;
        const prev = bestEntry.get(r.employee_id);
        const prevDate = prev ? _rosterSerial(prev.start) : null;
        if (!prev || !prevDate || shiftDate > prevDate) bestEntry.set(r.employee_id, r);
      }
      rosterMap = new Map(
        [...bestEntry.values()].map(r => [r.employee_id, r.shift.toLowerCase()])
      );
      groupDefs = [
        { key: 'morning', label: 'Morning', color: '#fb923c' },
        { key: 'evening', label: 'Evening', color: '#adc6ff' },
        { key: 'night',   label: 'Night',   color: '#c084fc' },
      ];
      groupLabel = 'Shift';
      groupRows = { morning: [], evening: [], night: [] };
      for (const row of filtered) {
        const f = row.flows;
        if (!f || (!f.is_picking && !f.is_putting && !f.is_audit && !f.is_fnv)) continue;
        const s = rosterMap.get(row.employee_id) || '';
        if (groupRows[s]) groupRows[s].push(row);
      }
    } else {
      groupDefs = [
        { key: 'new',         label: 'New',         sub: '< 30 active days',   color: '#4edea3' },
        { key: 'experienced', label: 'Experienced', sub: '30–120 active days', color: '#adc6ff' },
        { key: 'senior',      label: 'Senior',      sub: '> 120 active days',  color: '#c084fc' },
      ];
      groupLabel = 'Tier';
      groupRows = { new: [], experienced: [], senior: [] };
      for (const row of filtered) {
        const f = row.flows;
        if (!f || (!f.is_picking && !f.is_putting && !f.is_audit && !f.is_fnv)) continue;
        const t = _classifyExpTier(activeDayCounts, row.employee_id);
        groupRows[t].push(row);
      }
    }

    const groupStats = Object.fromEntries(groupDefs.map(g => [g.key, _tierMetrics(groupRows[g.key], auditRacksMap)]));

    // Historical groups: row-level classification (each row classified by captain's tier at that date)
    // Experience: count active days strictly before each row's date → tier at that point in time
    // Time: most recent roster entry on or before each row's date

    // Build per-captain sorted unique active-day list (for row-level experience classification)
    const captainActiveDayMap = new Map();
    for (const row of data) {
      if (!row.employee_id || !row.dateIsoStr) continue;
      if (!captainActiveDayMap.has(row.employee_id)) captainActiveDayMap.set(row.employee_id, new Set());
      captainActiveDayMap.get(row.employee_id).add(row.dateIsoStr);
    }
    const captainSortedDays = new Map();
    for (const [id, dateSet] of captainActiveDayMap) captainSortedDays.set(id, [...dateSet].sort());
    // Returns experience tier for captain on a given date (days active strictly before that date)
    const getExpTierOnDate = (empId, rowDateIsoStr) => {
      const dates = captainSortedDays.get(empId);
      if (!dates) return 'new';
      // Binary search: count dates strictly before rowDateIsoStr
      let lo = 0, hi = dates.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < rowDateIsoStr) lo = mid + 1; else hi = mid; }
      if (lo < 30)  return 'new';
      if (lo < 120) return 'experienced';
      return 'senior';
    };

    // Row-level shift lookup for time-based historical classification
    const _rosterSerialHist = s => { const n = parseFloat(s); return (!isNaN(n) && n > 1000) ? new Date(Math.round((n - 25569) * 86400000)) : null; };
    const captainRosterHistory = new Map();
    for (const r of sheets.getRosterCached()) {
      if (!r.employee_id || !r.shift) continue;
      const shiftDate = _rosterSerialHist(r.start);
      if (!shiftDate) continue;
      if (!captainRosterHistory.has(r.employee_id)) captainRosterHistory.set(r.employee_id, []);
      captainRosterHistory.get(r.employee_id).push({ date: shiftDate, shift: r.shift.toLowerCase() });
    }
    for (const entries of captainRosterHistory.values()) entries.sort((a, b) => a.date - b.date);
    const getShiftOnDate = (empId, rowDate) => {
      const history = captainRosterHistory.get(empId);
      if (!history) return '';
      let shift = '';
      for (const entry of history) { if (entry.date <= rowDate) shift = entry.shift; else break; }
      return shift;
    };

    const histGroupRows = Object.fromEntries(groupDefs.map(g => [g.key, []]));
    for (const row of data) {
      const f = row.flows;
      if (!f || (!f.is_picking && !f.is_putting && !f.is_audit && !f.is_fnv)) continue;
      // Exclude March (2), September (8), October (9) — outlier months (locked)
      if (row.date) { const m = row.date.getMonth(); if (m === 2 || m === 8 || m === 9) continue; }
      const key = _tierMode === 'time'
        ? getShiftOnDate(row.employee_id, row.date)
        : getExpTierOnDate(row.employee_id, row.dateIsoStr);
      if (histGroupRows[key]) histGroupRows[key].push(row);
    }
    const fullAuditRacksMap = new Map();
    for (const ar of _tierAuditRaw) {
      if (ar.dateStr) fullAuditRacksMap.set(`${ar.employee_id}_${ar.dateStr}`, ar.audit_codes.length);
    }
    const histGroupStats = Object.fromEntries(
      groupDefs.map(g => [g.key, _tierMetrics(histGroupRows[g.key] || [], fullAuditRacksMap)])
    );

    _tierGroupRows = groupRows;
    container.innerHTML = _buildTiersHTML(groupStats, groupDefs, groupLabel, histGroupStats);
    container.querySelectorAll('.tiers-table').forEach(t => _initTableSort(t));

    container.querySelectorAll('.tier-count-clickable').forEach(span => {
      span.addEventListener('click', e => {
        e.stopPropagation();
        const groupKey   = span.dataset.group;
        const groupLabel = span.dataset.label;
        const rows       = _tierGroupRows[groupKey] || [];
        const captains   = [...new Map(
          rows.map(r => [r.employee_id, { id: r.employee_id, name: r.employee_name }])
        ).values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        _showShiftPopover(span, captains, groupLabel);
      });
    });
  }

  function _showShiftPopover(anchor, captains, label) {
    document.getElementById('tier-shift-popover')?.remove();
    if (!captains.length) return;

    const pop = document.createElement('div');
    pop.id = 'tier-shift-popover';
    pop.className = 'tier-shift-popover';
    pop.innerHTML = `
      <div class="tier-popover-header">
        ${label} Captains
        <span class="tier-popover-count">${captains.length}</span>
      </div>
      <ul class="tier-popover-list">
        ${captains.map(c => `
          <li>
            <span class="tier-popover-name">${c.name || '—'}</span>
            <span class="tier-popover-id">${c.id}</span>
          </li>`).join('')}
      </ul>`;
    document.body.appendChild(pop);

    const rect  = anchor.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const popW  = 260;
    let left = rect.left + scrollX;
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top  = (rect.bottom + scrollY + 6) + 'px';

    const dismiss = ev => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 0);
  }

  function _buildTiersHTML(groupStats, groupDefs, groupLabel, histGroupStats = null) {
    const fmtDur = v => v !== null ? compute.formatDuration(v) : '—';
    const fmtNum = (v, d=1) => v != null ? _fmt(v, d) : '—';
    const st  = k => groupStats[k];
    const hst = k => histGroupStats?.[k] ?? null;
    const histSub = (val, label) => val !== null
      ? `<div class="tiers-hist-avg">all-time: ${label}</div>` : '';

    const colorCode = (vals, direction) => {
      const valid = vals.filter(v => v !== null && v > 0);
      if (valid.length < 2) return vals.map(() => '');
      const best  = direction === 'HIGH' ? Math.min(...valid) : Math.max(...valid);
      const worst = direction === 'HIGH' ? Math.max(...valid) : Math.min(...valid);
      return vals.map(v => {
        if (v === null || v === 0) return 'tiers-cell-muted';
        if (v === best)  return 'tiers-cell-best';
        if (v === worst) return 'tiers-cell-worst';
        return 'tiers-cell-mid';
      });
    };

    // ── 1. Summary cards ──────────────────────────────────────────────
    const cards = groupDefs.map(g => {
      const s = st(g.key);
      const has = s.captainCount > 0;
      return `
        <div class="tier-metric-card">
          <p class="tier-card-label">${g.label}</p>
          <div class="tier-card-row">
            <span class="tier-card-value${has ? ' tier-count-clickable' : ''}"
              style="color:${g.color}"
              data-group="${g.key}"
              data-label="${g.label}"
              title="${has ? 'Click to see captains' : ''}">${s.captainCount}</span>
            ${has ? `<span class="tier-card-badge" style="color:${g.color};background:${g.color}18">Active</span>` : ''}
          </div>
          ${g.sub ? `<p class="tier-card-sub">${g.sub}</p>` : ''}
          ${has ? `<p class="tier-card-hint">Avg score: ${fmtNum(s.avgScore, 2)}</p>`
                : `<p class="tier-card-hint inactive">No data</p>`}
        </div>`;
    }).join('');

    const bentoGrid = `
      <div class="tiers-bento-grid" style="grid-template-columns:repeat(${groupDefs.length},1fr)">
        ${cards}
      </div>`;

    // ── 2. Picking Flow ───────────────────────────────────────────────
    const ordersVals    = groupDefs.map(g => st(g.key).totalOrders);
    const ppiVals       = groupDefs.map(g => st(g.key).weightedAvgPPI);
    const delayVals     = groupDefs.map(g => st(g.key).avgDelayToStart);
    const pickVals      = groupDefs.map(g => st(g.key).avgPickTime);
    const billVals      = groupDefs.map(g => st(g.key).avgBillingTime);
    const totalVals     = groupDefs.map(g => st(g.key).avgTotalTime);
    const pickActVals   = groupDefs.map(g => st(g.key).totalPickerActiveTime);
    const totalOrders   = ordersVals.reduce((a, v) => a + (v || 0), 0);
    const histOrdersVals   = groupDefs.map(g => hst(g.key)?.totalOrders ?? 0);
    const totalHistOrders  = histOrdersVals.reduce((a, v) => a + (v || 0), 0);
    const clsOrders     = colorCode(ordersVals, 'LOW');
    const clsPPI        = colorCode(ppiVals,    'HIGH');
    const clsDelay      = colorCode(delayVals,  'HIGH');
    const clsPick       = colorCode(pickVals,   'HIGH');
    const clsBill       = colorCode(billVals,   'HIGH');
    const clsTotal      = colorCode(totalVals,  'HIGH');

    const pickTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0;
      const h   = hst(g.key);
      const pct = totalOrders > 0 && ordersVals[i]
        ? `<span class="tiers-pct">${((ordersVals[i]/totalOrders)*100).toFixed(1)}%</span>` : '';
      const histPct = totalHistOrders > 0 && histOrdersVals[i]
        ? `${((histOrdersVals[i]/totalHistOrders)*100).toFixed(1)}%` : null;
      const pickActHrs = pickActVals[i];
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsOrders[i]}">${has ? `${_fmt(ordersVals[i], 0)} ${pct}` : '—'}${histSub(histPct, histPct)}</td>
          <td class="${clsPPI[i]}">${fmtDur(ppiVals[i])}${histSub(h?.weightedAvgPPI ?? null, fmtDur(h?.weightedAvgPPI ?? null))}</td>
          <td class="${clsDelay[i]}">${fmtDur(delayVals[i])}${histSub(h?.avgDelayToStart ?? null, fmtDur(h?.avgDelayToStart ?? null))}</td>
          <td class="${clsPick[i]}">${fmtDur(pickVals[i])}${histSub(h?.avgPickTime ?? null, fmtDur(h?.avgPickTime ?? null))}</td>
          <td class="${clsBill[i]}">${fmtDur(billVals[i])}${histSub(h?.avgBillingTime ?? null, fmtDur(h?.avgBillingTime ?? null))}</td>
          <td class="${clsTotal[i]}">${fmtDur(totalVals[i])}${histSub(h?.avgTotalTime ?? null, fmtDur(h?.avgTotalTime ?? null))}</td>
          <td>${has && pickActHrs > 0 ? fmtNum(pickActHrs) + ' hrs' : '—'}</td>
        </tr>`;
    }).join('');

    const pickSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#adc6ff"></div>
          <h3 class="tiers-section-title">Picking Flow</h3>
        </div>
        <div class="table-wrapper" style="border-radius:12px;">
          <table class="tiers-table">
            <thead><tr>
              <th>${groupLabel}</th>
              <th>Total Orders Picked</th>
              <th>Avg PPI</th>
              <th>Avg Delay</th>
              <th>Avg Pick Time</th>
              <th>Avg Bill Time</th>
              <th>Avg Total Pick Time</th>
              <th>Total Picker Active Time</th>
            </tr></thead>
            <tbody>${pickTableRows}</tbody>
          </table>
        </div>
      </div>`;

    // ── 3. Putting Flow ───────────────────────────────────────────────
    const putQtyVals  = groupDefs.map(g => st(g.key).totalPutawayQty);
    const iphVals     = groupDefs.map(g => st(g.key).iph);
    const putHrVals   = groupDefs.map(g => st(g.key).totalPutHours);
    const totalPutQty = putQtyVals.reduce((a, v) => a + (v || 0), 0);
    const clsPutQty   = colorCode(putQtyVals, 'LOW');
    const clsIPH      = colorCode(iphVals,    'LOW');

    const putTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0 && putQtyVals[i] > 0;
      const h   = hst(g.key);
      const pct = totalPutQty > 0 && putQtyVals[i]
        ? `<span class="tiers-pct">${((putQtyVals[i]/totalPutQty)*100).toFixed(1)}%</span>` : '';
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsPutQty[i]}">${has ? `${_fmt(putQtyVals[i], 0)} ${pct}` : '—'}</td>
          <td class="${clsIPH[i]}">${fmtNum(iphVals[i])}${histSub(h?.iph ?? null, fmtNum(h?.iph ?? null))}</td>
          <td>${has && putHrVals[i] > 0 ? fmtNum(putHrVals[i]) + ' hrs' : '—'}</td>
        </tr>`;
    }).join('');

    const putSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#4d8eff"></div>
          <h3 class="tiers-section-title">Putting Flow</h3>
        </div>
        <div class="table-wrapper" style="border-radius:12px;">
          <table class="tiers-table">
            <thead><tr>
              <th>${groupLabel}</th>
              <th>Total Qty Put</th>
              <th>IPH</th>
              <th>Total Putaway Hours</th>
            </tr></thead>
            <tbody>${putTableRows}</tbody>
          </table>
        </div>
      </div>`;

    // ── 4. Audit Flow ─────────────────────────────────────────────────
    const rackVals    = groupDefs.map(g => st(g.key).totalRacks);
    const hprVals     = groupDefs.map(g => st(g.key).hpr);
    const auditHrVals = groupDefs.map(g => st(g.key).totalAuditHours);
    const clsRacks    = colorCode(rackVals, 'LOW');
    const clsHPR      = colorCode(hprVals,  'HIGH');

    const auditTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0 && rackVals[i] > 0;
      const h   = hst(g.key);
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsRacks[i]}">${has ? _fmt(rackVals[i], 0) : '—'}</td>
          <td class="${clsHPR[i]}">${fmtNum(hprVals[i], 2)}${histSub(h?.hpr ?? null, fmtNum(h?.hpr ?? null, 2))}</td>
          <td>${has && auditHrVals[i] > 0 ? fmtNum(auditHrVals[i]) + ' hrs' : '—'}</td>
        </tr>`;
    }).join('');

    const auditSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#4edea3"></div>
          <h3 class="tiers-section-title">Audit Flow</h3>
        </div>
        <div class="table-wrapper" style="border-radius:12px;">
          <table class="tiers-table">
            <thead><tr>
              <th>${groupLabel}</th>
              <th>Total Racks Audited</th>
              <th>Hrs/Rack (HPR)</th>
              <th>Total Audit Hours</th>
            </tr></thead>
            <tbody>${auditTableRows}</tbody>
          </table>
        </div>
      </div>`;

    return `${bentoGrid}${pickSection}${putSection}${auditSection}`;
  }

  // ── Captain Profile ────────────────────────────────────────────────────

  function _isActiveInFlow(r, flow) {
    switch (flow) {
      case 'picking': return r.flows?.is_picking;
      case 'putting': return r.flows?.is_putting;
      case 'audit':   return r.flows?.is_audit;
      case 'fnv':     return r.flows?.is_fnv;
    }
    return false;
  }

  function initCaptainDropdown() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const captains = [...new Map(data.map(r => [r.employee_id, r.employee_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));

    // Count unique active days per captain
    const dayCount = new Map();
    data.forEach(r => {
      if (!dayCount.has(r.employee_id)) dayCount.set(r.employee_id, new Set());
      dayCount.get(r.employee_id).add(_isoDateStr(r.date));
    });

    const options = captains
      .map(([id, name]) => {
        const days = dayCount.get(id)?.size || 0;
        return `<option value="${_esc(id)}">${_esc(name)} (${_esc(id)}) — ${days}d</option>`;
      })
      .join('');

    const sel = document.getElementById('profile-captain-add');
    if (sel) sel.innerHTML = '<option value="">— Select captain —</option>' + options;
  }

  function onProfileCaptainAdd(selectEl) {
    const id = selectEl.value;
    if (!id) return;
    selectEl.value = '';
    if (_selectedCaptains.find(c => c.id === id)) return;
    if (_selectedCaptains.length >= _CAPTAIN_COLORS.length) return;
    const data = app.getFlaggedData();
    const name = data.find(r => r.employee_id === id)?.employee_name || id;
    _selectedCaptains.push({ id, name, color: _CAPTAIN_COLORS[_selectedCaptains.length] });
    _renderCaptainChips();
    renderCaptainProfile();
  }

  function removeCaptain(id) {
    _selectedCaptains = _selectedCaptains.filter(c => c.id !== id);
    _selectedCaptains.forEach((c, i) => { c.color = _CAPTAIN_COLORS[i]; });
    _renderCaptainChips();
    renderCaptainProfile();
  }

  function onProfileExpGroupLoad(selectEl) {
    const range = selectEl.value;
    selectEl.value = '';
    if (!range) return;

    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    // Count unique active days per captain (all-time, not date-range filtered)
    const dayCount = new Map();
    data.forEach(r => {
      if (!dayCount.has(r.employee_id)) dayCount.set(r.employee_id, { days: new Set(), name: r.employee_name });
      dayCount.get(r.employee_id).days.add(_isoDateStr(r.date));
    });

    const [lo, hi] = range === '201+' ? [201, Infinity] : range.split('-').map(Number);

    const matched = [...dayCount.entries()]
      .filter(([, { days }]) => days.size >= lo && days.size <= hi)
      .sort((a, b) => b[1].days.size - a[1].days.size) // most experienced first
      .map(([id, { name }]) => ({ id, name }));

    _selectedCaptains = [];
    matched.slice(0, _CAPTAIN_COLORS.length).forEach(({ id, name }, i) => {
      _selectedCaptains.push({ id, name, color: _CAPTAIN_COLORS[i] });
    });
    _renderCaptainChips();
    renderCaptainProfile();
  }

  function _renderCaptainChips() {
    const chips = document.getElementById('profile-captain-chips');
    if (!chips) return;
    chips.innerHTML = _selectedCaptains.map(c => `
      <span class="profile-captain-chip">
        <span class="profile-captain-chip-dot" style="background:${c.color}"></span>
        ${_esc(c.name)}
        <button class="profile-captain-chip-remove" onclick="ui.removeCaptain('${_esc(c.id)}')" title="Remove">×</button>
      </span>
    `).join('');
  }

  function initCaptainProfilePeriods() {
    const data = app.getFlaggedData();
    const sel  = document.getElementById('profile-preset');
    if (!sel || !data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateMonthly(data);

    sel.innerHTML = [
      '<option value="all">All Time</option>',
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d =>
        `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d =>
        `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      document.getElementById('profile-start').value = _isoDateStr(sortedDates[0]);
      document.getElementById('profile-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
    }
    _cpDateMode = false;
  }

  function onProfilePresetChange() {
    _cpDateMode = false;
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal = document.getElementById('profile-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('profile-start').value = ds;
      document.getElementById('profile-end').value   = ds;
      _cpDateMode = true;
      renderCaptainProfile();
      return;
    }

    if (periodVal === 'all') {
      const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      if (sortedDates.length > 0) {
        document.getElementById('profile-start').value = _isoDateStr(sortedDates[0]);
        document.getElementById('profile-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
      }
    } else {
      const colonIdx   = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      const rows = data.filter(row => {
        if (!row.date) return false;
        if (periodType === 'W') return compute.aggregateWeekly([row]).some(w => w.week_key === periodKey);
        const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
        return ym === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('profile-start').value = _isoDateStr(dates[0]);
        document.getElementById('profile-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    }
    renderCaptainProfile();
  }

  function onProfileDateChange() {
    _cpDateMode = true;
    renderCaptainProfile();
  }

  function resetProfileDates() {
    const data = app.getFlaggedData();
    const presetSel = document.getElementById('profile-preset');
    if (presetSel) presetSel.value = 'all';
    if (data && data.length > 0) {
      const sortedDates = data.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      document.getElementById('profile-start').value = _isoDateStr(sortedDates[0]);
      document.getElementById('profile-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
    } else {
      document.getElementById('profile-start').value = '';
      document.getElementById('profile-end').value   = '';
    }
    _cpDateMode = false;
    renderCaptainProfile();
  }

  function setCpView(val) {
    _cpView = val || 'daily';
    renderCaptainProfile();
  }

  function renderCaptainProfile() {
    const data = app.getFlaggedData();
    const container = document.getElementById('profile-content');
    if (!container) return;

    if (_selectedCaptains.length === 0) {
      container.innerHTML = '<p class="placeholder-text">Add a captain above to view their performance profile.</p>';
      return;
    }

    const startInput = document.getElementById('profile-start');
    const endInput   = document.getElementById('profile-end');
    const startMs = startInput?.value ? new Date(startInput.value).setHours(0,0,0,0)   : -Infinity;
    const endMs   = endInput?.value   ? new Date(endInput.value).setHours(23,59,59,999) :  Infinity;

    const auditData = (sheets.getAuditCached() || []).filter(r => r.date >= startMs && r.date <= endMs);

    // Aggregated field name for weekly/monthly bucket lookup
    const AGG_FIELD = {
      'assigned_to_started_per_order': 'avg_assigned_to_started',
      'picking_time_per_order':        'avg_picking_time_per_order',
      'billing_time_per_order':        'avg_billing_time',
      'total_time_per_order':          'avg_total_time_per_order',
      'iph':                           'avg_iph',
      'fnv_audit_rate':                'avg_fnv_audit_rate',
    };

    // Build per-captain data with view-appropriate bucket map
    const captainData = _selectedCaptains.map(({ id, name, color }) => {
      const allRows = data.filter(r => r.employee_id === id).sort((a, b) => a.date - b.date);
      const rows    = allRows.filter(r => r.date >= startMs && r.date <= endMs);

      let bucketMap, labelMap;
      if (_cpView === 'weekly') {
        const captainAudit = auditData.filter(a => a.employee_id === id);
        const buckets = compute.aggregateWeekly(rows, captainAudit);
        bucketMap = new Map(buckets.map(b => [b.week_key, b]));
        labelMap  = new Map(buckets.map(b => [b.week_key, b.label || b.week_key]));
      } else if (_cpView === 'monthly') {
        const captainAudit = auditData.filter(a => a.employee_id === id);
        const buckets = compute.aggregateMonthly(rows, captainAudit);
        bucketMap = new Map(buckets.map(b => [b.month_key, b]));
        labelMap  = new Map(buckets.map(b => [b.month_key, b.label || b.month_key]));
      } else {
        // daily
        bucketMap = new Map(rows.map(r => [_isoDateStr(r.date), r]));
        labelMap  = null;
      }

      return { id, name, color, allRows, rows, bucketMap, labelMap };
    });

    // Union bucket-key axis across all captains
    const allKeys = [...new Set(captainData.flatMap(c => [...c.bucketMap.keys()]))].sort();

    if (allKeys.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No data for the selected captains in this date range.</p>';
      return;
    }

    // Build display labels for x-axis (for weekly/monthly, prefer human-readable label from any captain)
    const displayLabels = allKeys.map(k => {
      for (const c of captainData) {
        if (c.labelMap && c.labelMap.has(k)) return c.labelMap.get(k);
      }
      return k; // fallback to key (dates stay as-is)
    });

    // Hero cards (always use raw daily rows for totals)
    const isMulti = captainData.length > 1;
    const heroCards = captainData.map(({ id, name, color, allRows, rows }) => {
      const initials       = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const totalDays      = allRows.length;
      const shownDays      = rows.length;
      const flaggedDays    = rows.filter(r => r.composite_slacker_score > 0).length;
      const isFiltered     = shownDays < totalDays;
      const totalOrders    = rows.reduce((s, r) => s + (r.checkout_orders || 0), 0);
      const totalPutaway   = rows.reduce((s, r) => s + (r.putaway_qty || 0), 0);
      const totalActiveSec = rows.reduce((s, r) => s + (r.total_active_time || 0), 0);
      const activeHrs      = (totalActiveSec / 3600).toFixed(1);
      return `
        <div class="profile-hero">
          <div class="profile-avatar" style="background:${_colorAlpha(color, 0.12)};color:${color}">${initials}</div>
          <div class="profile-hero-info">
            <h3 class="profile-hero-name">${_esc(name)}</h3>
            <p class="profile-hero-id">${_esc(id)}</p>
          </div>
          <div class="profile-hero-stats">
            <div class="profile-stat">
              <span class="profile-stat-value">${totalDays}</span>
              <span class="profile-stat-label">Total Days</span>
            </div>
            ${isFiltered ? `<div class="profile-stat">
              <span class="profile-stat-value" style="color:#adc6ff">${shownDays}</span>
              <span class="profile-stat-label">In Range</span>
            </div>` : ''}
            <div class="profile-stat">
              <span class="profile-stat-value" style="color:${flaggedDays > 0 ? '#ff5c5c' : '#4edea3'}">${flaggedDays}</span>
              <span class="profile-stat-label">Flagged Days</span>
            </div>
            <div class="profile-stat">
              <span class="profile-stat-value">${totalOrders.toLocaleString()}</span>
              <span class="profile-stat-label">Orders Picked</span>
            </div>
            <div class="profile-stat">
              <span class="profile-stat-value">${totalPutaway.toLocaleString()}</span>
              <span class="profile-stat-label">Items Put Away</span>
            </div>
            <div class="profile-stat">
              <span class="profile-stat-value">${activeHrs}h</span>
              <span class="profile-stat-label">Active Time</span>
            </div>
          </div>
        </div>`;
    }).join('');

    const heroHTML = isMulti
      ? `<div class="profile-heroes-row">${heroCards}</div>`
      : heroCards;

    container.innerHTML = heroHTML + '<div class="profile-metric-grid" id="profile-metric-grid"></div>';

    const grid = document.getElementById('profile-metric-grid');

    const activeMetrics = CONFIG.METRICS.filter(m =>
      captainData.some(c => c.rows.some(r => _isActiveInFlow(r, m.flow)))
    );

    activeMetrics.forEach((metric, i) => {
      const series = captainData.map(({ name, color, bucketMap }) => {
        const values = allKeys.map(k => {
          const b = bucketMap.get(k);
          if (!b) return null;
          let v;
          if (_cpView === 'daily') {
            v = metric.key === 'fnv_audit_rate' ? b.fnv_audit_rate : b[metric.key];
          } else if (metric.key === 'audit_hours_per_rack') {
            const racks = b.total_racks_audited;
            v = racks > 0 ? (b.total_audit_hours / racks) : null;
          } else {
            v = b[AGG_FIELD[metric.key]];
          }
          return (v && v > 0) ? (metric.isDuration ? +(v/60).toFixed(2) : +v.toFixed(2)) : null;
        });
        const flagDays = allKeys.map(k => {
          if (_cpView !== 'daily') return false;
          const r = bucketMap.get(k);
          return r ? r.flags?.get(metric.key) === true : false;
        });
        return { label: name, values, flagDays, color };
      });

      const canvasId = `sparkline-${i}`;
      const card = document.createElement('div');
      card.className = 'profile-metric-card';
      card.innerHTML = `
        <h4>${metric.label}${metric.isDuration ? ' (min)' : ''}</h4>
        <canvas id="${canvasId}" height="120"></canvas>
      `;
      grid.appendChild(card);

      setTimeout(() => {
        charts.renderSparkline(canvasId, displayLabels, series);
      }, 0);
    });
  }

  // ── Config Panel ───────────────────────────────────────────────────────

  // ── Slab Config Helpers ───────────────────────────────────────────────

  function _secsToMmss(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function _mmssToSecs(str) {
    const parts = String(str).split(':');
    const m = parseInt(parts[0]) || 0;
    const s = parseInt(parts[1]) || 0;
    return m * 60 + s;
  }

  function _populateSlabTable(tableId, slabs) {
    const tbody = document.getElementById(tableId)?.querySelector('tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    slabs.forEach((slab, i) => {
      if (!rows[i]) return;
      rows[i].querySelector('.slab-time').value   = _secsToMmss(slab.maxTime);
      rows[i].querySelector('.slab-amount').value = slab.amount;
    });
  }

  function _readSlabTable(tableId) {
    const tbody = document.getElementById(tableId)?.querySelector('tbody');
    if (!tbody) return [];
    return [...tbody.querySelectorAll('tr')].map(row => ({
      maxTime: _mmssToSecs(row.querySelector('.slab-time').value),
      amount:  parseInt(row.querySelector('.slab-amount').value) || 0,
    }));
  }

  function loadSlabMonth() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    const ov = overrides[monthKey];
    const slabs400 = ov?.slabs400 || compute.PICKING_SLABS_400;
    const slabs800 = ov?.slabs800 || compute.PICKING_SLABS_800;
    _populateSlabTable('slab-table-400', slabs400);
    _populateSlabTable('slab-table-800', slabs800);
    const t400Input = document.getElementById('order-threshold-400');
    const t800Input = document.getElementById('order-threshold-800');
    if (t400Input) t400Input.value = ov?.threshold400 ?? 400;
    if (t800Input) t800Input.value = ov?.threshold800 ?? 800;
    const resetBtn = document.getElementById('slab-reset-btn');
    if (resetBtn) resetBtn.style.display = ov ? '' : 'none';
    const savedMsg = document.getElementById('slab-saved-msg');
    if (savedMsg) savedMsg.style.display = 'none';
    const noteEl = document.getElementById('slab-override-note');
    if (noteEl) noteEl.textContent = ov ? `Custom criteria active for ${monthKey}` : `Using default criteria for ${monthKey}`;
  }

  function saveSlabOverrides() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const slabs400     = _readSlabTable('slab-table-400');
    const slabs800     = _readSlabTable('slab-table-800');
    const threshold400 = parseInt(document.getElementById('order-threshold-400')?.value) || 400;
    const threshold800 = parseInt(document.getElementById('order-threshold-800')?.value) || 800;
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    overrides[monthKey] = { slabs400, slabs800, threshold400, threshold800 };
    localStorage.setItem('incentiveSlabOverrides', JSON.stringify(overrides));
    _incentiveCache    = null;
    _incentiveCacheKey = null;
    const resetBtn = document.getElementById('slab-reset-btn');
    if (resetBtn) resetBtn.style.display = '';
    const noteEl = document.getElementById('slab-override-note');
    if (noteEl) noteEl.textContent = `Custom criteria active for ${monthKey}`;
    const savedMsg = document.getElementById('slab-saved-msg');
    if (savedMsg) {
      savedMsg.style.display = '';
      setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
    }
  }

  function resetSlabOverrides() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    delete overrides[monthKey];
    localStorage.setItem('incentiveSlabOverrides', JSON.stringify(overrides));
    _incentiveCache    = null;
    _incentiveCacheKey = null;
    loadSlabMonth();
  }

  function renderConfigPanel() {
    const container = document.getElementById('config-content');
    if (!container) return;

    const rowCount = sheets.getCached().length.toLocaleString();

    const metricsRows = CONFIG.METRICS.map(m => `<tr>
      <td>${m.label}</td>
      <td><span class="config-flow-tag">${m.flow.charAt(0).toUpperCase() + m.flow.slice(1)}</span></td>
      <td>${m.direction === 'HIGH'
        ? `${ICONS.arrowUp} <span style="vertical-align:middle">High = Bad</span>`
        : `${ICONS.arrowDown} <span style="vertical-align:middle">Low = Bad</span>`}</td>
    </tr>`).join('');

    const exclTags = [..._customExcludedIds].map(id => `
      <span class="config-excl-tag">
        ${_esc(id)}
        <button class="config-excl-tag-remove" onclick="ui.removeExcludedId('${_esc(id)}')" title="Remove">&times;</button>
      </span>`).join('');

    const defaultSlabs400 = compute.PICKING_SLABS_400;
    const defaultSlabs800 = compute.PICKING_SLABS_800;
    const slabRows = (slabs) => slabs.map(s => `
      <tr>
        <td><input class="slab-time" type="text" value="${_secsToMmss(s.maxTime)}" placeholder="m:ss" /></td>
        <td><input class="slab-amount" type="number" value="${s.amount}" min="0" step="25" /></td>
      </tr>`).join('');

    const curMonth = new Date().toISOString().slice(0, 7);
    const existingOverrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    const hasOverride = !!existingOverrides[curMonth];

    container.innerHTML = `
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-teal">${ICONS.layers}</div>
          <h3>Data Source</h3>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Spreadsheet</span>
          <code class="config-code">${CONFIG.SPREADSHEET_ID}</code>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Sheet</span>
          <span class="config-detail-value">Sheet1 (columns A–V)</span>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Rows loaded</span>
          <span class="config-detail-value">${rowCount}</span>
        </div>
      </div>
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-purple">${ICONS.person}</div>
          <h3>Excluded Captains</h3>
        </div>
        <p class="config-desc">Captain IDs excluded from all calculations when "Excl. Captains" is active.</p>
        <div class="config-excl-input-row">
          <input type="text" id="excl-id-input" placeholder="e.g. DLES123456"
                 onkeydown="if(event.key==='Enter')ui.addExcludedId()" />
          <button class="btn" onclick="ui.addExcludedId()">Add</button>
        </div>
        <div class="config-excl-list">
          ${exclTags || '<span class="config-hint">No custom IDs added yet.</span>'}
        </div>
        <p class="config-hint" style="margin-top:8px">Fixed supervisor IDs (${(CONFIG.SUPERVISOR_IDS || []).join(', ')}) are always included in the toggle.</p>
      </div>
      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-green">${ICONS.barChart}</div>
          <h3>Metric Definitions</h3>
        </div>
        <div class="table-wrapper">
          <table class="data-table config-table">
            <thead><tr><th>Metric</th><th>Flow</th><th>Direction</th></tr></thead>
            <tbody>${metricsRows}</tbody>
          </table>
        </div>
      </div>
      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-amber">${ICONS.flag}</div>
          <h3>Picking Incentive Criteria</h3>
        </div>
        <p class="config-desc">Configure time-based picking incentive slabs per month. Changes apply to the Incentives tab for the selected month.</p>
        <div class="config-month-row">
          <span class="dd-control-label">Month</span>
          <input type="month" id="slab-month-picker" value="${curMonth}" onchange="ui.loadSlabMonth()" />
          <span id="slab-override-note" class="config-hint" style="margin-left:8px">${hasOverride ? `Custom criteria active for ${curMonth}` : `Using default criteria for ${curMonth}`}</span>
        </div>
        <div class="slab-tables-grid">
          <div>
            <div class="slab-threshold-row">
              <input class="slab-threshold-input" id="order-threshold-400" type="number" min="1" step="50"
                     value="${existingOverrides[curMonth]?.threshold400 ?? 400}" />
              <span class="config-hint" style="opacity:1;font-weight:600">+ Orders / Week</span>
            </div>
            <table class="slab-editor-table" id="slab-table-400">
              <thead><tr><th>Max Time (m:ss)</th><th>Amount (&#8377;)</th></tr></thead>
              <tbody>${slabRows(existingOverrides[curMonth]?.slabs400 || defaultSlabs400)}</tbody>
            </table>
          </div>
          <div>
            <div class="slab-threshold-row">
              <input class="slab-threshold-input" id="order-threshold-800" type="number" min="1" step="50"
                     value="${existingOverrides[curMonth]?.threshold800 ?? 800}" />
              <span class="config-hint" style="opacity:1;font-weight:600">+ Orders / Week</span>
            </div>
            <table class="slab-editor-table" id="slab-table-800">
              <thead><tr><th>Max Time (m:ss)</th><th>Amount (&#8377;)</th></tr></thead>
              <tbody>${slabRows(existingOverrides[curMonth]?.slabs800 || defaultSlabs800)}</tbody>
            </table>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.saveSlabOverrides()">Save for Month</button>
          <button class="btn" id="slab-reset-btn" onclick="ui.resetSlabOverrides()" style="${hasOverride ? '' : 'display:none'}">Reset to Default</button>
          <span id="slab-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <p class="config-hint" style="margin-top:6px">Time is the upper bound (exclusive). Rows without a match earn &#8377;0.</p>
      </div>
      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-red">${ICONS.flag}</div>
          <h3>Flow SD Thresholds</h3>
        </div>
        <p class="config-desc">Per-flow SD thresholds for cell coloring and flagging. Borderline SD also determines when a captain is flagged in weekly/monthly view.</p>
        <table class="slab-editor-table flow-threshold-table">
          <thead><tr><th>Flow</th><th>Critical SD</th><th>Flagged SD</th><th>Borderline SD</th></tr></thead>
          <tbody>
            ${_FT_FLOWS.map(flow => {
              const ft = _getFlowThresholds(flow);
              const label = flow.charAt(0).toUpperCase() + flow.slice(1);
              return `<tr>
                <td style="font-weight:600">${label}</td>
                <td><input class="slab-threshold-input" id="ft-${flow}-critical"   type="number" value="${ft.critical}"   min="0.1" step="0.1" /></td>
                <td><input class="slab-threshold-input" id="ft-${flow}-flagged"    type="number" value="${ft.flagged}"    min="0.1" step="0.1" /></td>
                <td><input class="slab-threshold-input" id="ft-${flow}-borderline" type="number" value="${ft.borderline}" min="0.1" step="0.1" /></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="config-row" style="margin-top:16px;gap:24px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">SD Multiplier</span>
            <input type="number" id="threshold-input" min="0.5" max="3" step="0.1" value="${CONFIG.THRESHOLD}"
                   style="width:90px" onchange="app.updateThreshold(this.value)" />
            <span class="config-hint" style="margin-top:2px">Daily flag threshold. Default 1.0.</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Floor Deviation</span>
            <input type="number" id="floor-deviation-input" min="0.05" max="0.95" step="0.05"
                   value="${CONFIG.FLOOR_DEVIATION ?? 0.30}" style="width:90px"
                   onchange="app.updateFloorDeviation(this.value)" />
            <span class="config-hint" style="margin-top:2px">Flag if &gt;${Math.round((CONFIG.FLOOR_DEVIATION ?? 0.30) * 100)}% worse than mean. Default 0.30.</span>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.saveFlowThresholds()">Save</button>
          <button class="btn" onclick="ui.resetFlowThresholds()">Reset to Default</button>
          <span id="flow-thresholds-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <p class="config-hint" style="margin-top:6px">SD defaults: Critical 2.0 · Flagged 1.0 · Borderline 0.5 for all flows.</p>
      </div>
    `;
  }

  // ── Utility ────────────────────────────────────────────────────────────

  function _fmt(val, decimals = 0) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function _isoDateStr(date) {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Inventory Health ────────────────────────────────────────────────

  let _invCache = null;
  let _invCacheKey = null;
  let _invDateMode = false; // false = preset, true = custom range

  function initInventoryHealth() {
    const auditData = sheets.getAuditCached();
    const sel = document.getElementById('inv-preset');
    if (!sel || !auditData || auditData.length === 0) return;

    // Build preset options from audit data (weekly + monthly)
    const weekly  = compute.aggregateWeekly(auditData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));
    const monthly = compute.aggregateMonthly(auditData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

    sel.innerHTML = [
      '<option value="all">All Time</option>',
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    // Default date range: full span of audit data AND daily audit-hour data
    const dailyAll = _supervisorFilter(sheets.getCached());
    const allDates = [
      ...auditData.map(r => r.date),
      ...dailyAll.filter(r => r.auditor_active_time > 0).map(r => r.date),
    ].filter(Boolean).sort((a, b) => a - b);
    if (allDates.length > 0) {
      document.getElementById('inv-start').value = _isoDateStr(allDates[0]);
      document.getElementById('inv-end').value   = _isoDateStr(allDates[allDates.length - 1]);
    }

    _invDateMode = false;
    _invCache = null;
    _invCacheKey = null;
  }

  function onInvPeriodChange() {
    renderInventoryHealth();
  }

  function onInvPresetChange() {
    _invDateMode = false;
    const auditData = sheets.getAuditCached();
    if (!auditData) return;
    const periodVal = document.getElementById('inv-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('inv-start').value = ds;
      document.getElementById('inv-end').value   = ds;
      _invDateMode = true;
      _invCache = null;
      _invCacheKey = null;
      renderInventoryHealth();
      return;
    }

    if (periodVal === 'all') {
      // Reset to full date span (audit + daily audit-hour dates)
      const dailyAll = _supervisorFilter(sheets.getCached());
      const allDates = [
        ...auditData.map(r => r.date),
        ...dailyAll.filter(r => r.auditor_active_time > 0).map(r => r.date),
      ].filter(Boolean).sort((a, b) => a - b);
      if (allDates.length > 0) {
        document.getElementById('inv-start').value = _isoDateStr(allDates[0]);
        document.getElementById('inv-end').value   = _isoDateStr(allDates[allDates.length - 1]);
      }
    } else {
      const colonIdx  = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      const rows = auditData.filter(row => {
        if (!row.date) return false;
        if (periodType === 'W') return compute.aggregateWeekly([{ date: row.date, dateStr: row.dateStr, employee_id: row.employee_id }]).some(w => w.week_key === periodKey);
        const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
        return ym === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('inv-start').value = _isoDateStr(dates[0]);
        document.getElementById('inv-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    }
    _invCache = null;
    _invCacheKey = null;
    renderInventoryHealth();
  }

  function onInvDateChange() {
    _invDateMode = true;
    _invCache = null;
    _invCacheKey = null;
    renderInventoryHealth();
  }

  function renderInventoryHealth() {
    const container = document.getElementById('inv-content');
    if (!container) return;

    const auditData = _supervisorFilter(sheets.getAuditCached() || []);
    const dailyData = _supervisorFilter(sheets.getCached());

    if (!auditData || auditData.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No audit data available. Ensure the "Audits" sheet exists in the source spreadsheet.</p>';
      return;
    }

    // Filter by date range
    const startVal = document.getElementById('inv-start')?.value;
    const endVal   = document.getElementById('inv-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0, 0, 0, 0)      : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23, 59, 59, 999)    : Infinity;

    const filteredAudit = auditData.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    const filteredDaily = dailyData.filter(r => r.date && r.date >= startMs && r.date <= endMs);

    if (filteredAudit.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No audit data for the selected period.</p>';
      return;
    }

    // Compute (or use cache)
    const cacheKey = `${startVal}_${endVal}_${auditData.length}_${dailyData.length}`;
    if (_invCacheKey !== cacheKey) {
      _invCache = compute.computeAuditAggregations(filteredAudit, filteredDaily);
      _invCacheKey = cacheKey;
    }
    const agg = _invCache;
    if (!agg) return;

    const period = document.getElementById('inv-period')?.value || 'weekly';
    const periodData = period === 'daily' ? agg.volume.dailyArray : period === 'monthly' ? agg.volume.monthly : agg.volume.weekly;

    // Totals for stat cards
    const totalRacks = [...agg.volume.daily.values()].reduce((s, d) => s + d.totalRacks, 0);
    const totalAuditors = new Set(filteredAudit.map(r => r.employee_id)).size;
    const activeDays = agg.volume.daily.size;
    const avgRacksPerDay = activeDays > 0 ? (totalRacks / activeDays).toFixed(1) : '0';
    const uniqueCodes = new Set(filteredAudit.flatMap(r => r.audit_codes)).size;

    // Build the full HTML
    container.innerHTML = `
      <!-- Stat Cards -->
      <div class="stat-cards-row">
        ${_invStatCard(ICONS.flowAudit, 'stat-icon-blue', 'Total Racks Audited', _fmt(totalRacks))}
        ${_invStatCard(ICONS.person, 'stat-icon-green', 'Active Auditors', totalAuditors)}
        ${_invStatCard(ICONS.barChart, 'stat-icon-teal', 'Avg Racks / Day', avgRacksPerDay)}
        ${_invStatCard(ICONS.layers, 'stat-icon-purple', 'Unique Rack Codes', _fmt(uniqueCodes))}
      </div>

      <!-- Zone 1: Audit Volume -->
      <div class="bento-grid" style="margin-bottom:20px;">
        <div class="bento-card bento-large">
          <div class="bento-card-header">
            <div>
              <h3 class="bento-card-title">Rack Audit Volume</h3>
              <p class="bento-card-subtitle">Total racks audited vs active auditors over time</p>
            </div>
          </div>
          <canvas id="chart-audit-volume" style="max-height:280px;"></canvas>
        </div>
        <div class="bento-card bento-small">
          <div class="bento-card-header">
            <div>
              <h3 class="bento-card-title">Audit Coverage</h3>
              <p class="bento-card-subtitle">Unique rack codes per ${period === 'daily' ? 'day' : period === 'monthly' ? 'month' : 'week'}</p>
            </div>
          </div>
          <canvas id="chart-audit-coverage" style="max-height:280px;"></canvas>
        </div>
      </div>

      <!-- Zone 2: Captain Performance -->
      <div class="inv-section">
        <div class="tiers-section-header" style="margin-bottom:14px;">
          <div class="tiers-section-pip" style="background:#4edea3"></div>
          <h3 class="tiers-section-title">Captain Audit Performance</h3>
        </div>
        <div class="bento-grid" style="margin-bottom:16px;">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Efficiency: Hours vs Racks</h3>
                <p class="bento-card-subtitle">Each dot = one captain · size = audit days · dashed = avg rate</p>
              </div>
            </div>
            <canvas id="chart-captain-efficiency" style="max-height:300px;"></canvas>
          </div>
          <div class="bento-card bento-small">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Racks / Hour Ranking</h3>
                <p class="bento-card-subtitle">Captain efficiency leaderboard</p>
              </div>
            </div>
            <div id="inv-captain-ranking" class="inv-ranking-list"></div>
          </div>
        </div>
        <div id="inv-captain-table-container"></div>
      </div>

      <!-- Zone 3: Rack Intelligence -->
      <div class="inv-section">
        <div class="tiers-section-header" style="margin-bottom:14px;">
          <div class="tiers-section-pip" style="background:#c084fc"></div>
          <h3 class="tiers-section-title">Rack Intelligence</h3>
        </div>
        <div class="bento-grid" style="margin-bottom:16px;">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Hot-Spot Heatmap</h3>
                <p class="bento-card-subtitle">Audit frequency by floor and aisle</p>
              </div>
            </div>
            <div id="inv-heatmap" style="overflow-x:auto;"></div>
          </div>
          <div class="bento-card bento-small">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Most Audited Racks</h3>
                <p class="bento-card-subtitle">Top repeat audit locations</p>
              </div>
            </div>
            <div id="inv-top-racks" class="inv-rack-list"></div>
          </div>
        </div>
        <div id="inv-rack-table-container"></div>
      </div>
    `;

    // Render charts
    setTimeout(() => {
      charts.renderAuditVolumeChart('chart-audit-volume', periodData);
      charts.renderAuditCoverageChart('chart-audit-coverage', periodData);

      // Scatter chart
      const captainArr = [...agg.captainPerf.values()].filter(c => c.totals.totalHours > 0);
      charts.renderAuditScatterChart('chart-captain-efficiency', captainArr);

      // Captain ranking
      _renderCaptainRanking(captainArr);

      // Captain table
      _renderCaptainAuditTable(captainArr);

      // Heatmap
      _renderHeatmap(agg.rackIntel);

      // Top racks
      _renderTopRacks(agg.rackIntel.sorted);

      // Rack table
      _renderRackDetailTable(agg.rackIntel.sorted);
    }, 0);
  }

  function _invStatCard(icon, colorClass, label, value) {
    return `
      <div class="stat-card">
        <div class="stat-icon ${colorClass}">${icon}</div>
        <div>
          <p class="stat-card-label">${label}</p>
          <p class="stat-card-value">${value}</p>
        </div>
      </div>`;
  }

  function _renderCaptainRanking(captains) {
    const container = document.getElementById('inv-captain-ranking');
    if (!container) return;

    // Lower Hr/Rack = more efficient → sort ascending
    const sorted = [...captains]
      .filter(c => c.totals.hrPerRack !== null)
      .sort((a, b) => (a.totals.hrPerRack || Infinity) - (b.totals.hrPerRack || Infinity));

    const minHPR = sorted.length > 0 ? sorted[0].totals.hrPerRack : 1;
    const maxHPR = sorted.length > 0 ? sorted[sorted.length - 1].totals.hrPerRack : 1;
    const top = sorted.slice(0, 10);

    container.innerHTML = top.map((c, i) => {
      const initials = c.employee_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const range = maxHPR - minHPR || 1;
      const pct = Math.max(10, Math.round(100 - ((c.totals.hrPerRack - minHPR) / range) * 90));
      return `
        <div class="inv-ranking-item">
          <span class="inv-ranking-rank">${i + 1}</span>
          <div class="inv-ranking-avatar">${initials}</div>
          <div class="inv-ranking-info">
            <div class="inv-ranking-name">${_esc(c.employee_name)}</div>
            <div class="inv-ranking-sub">${c.totals.totalHours}h · ${c.totals.totalRacks} racks</div>
          </div>
          <span class="inv-ranking-value">${c.totals.hrPerRack}</span>
          <div class="inv-ranking-bar"><div class="inv-ranking-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  function _renderCaptainAuditTable(captains) {
    const container = document.getElementById('inv-captain-table-container');
    if (!container) return;

    const sorted = [...captains].sort((a, b) => (a.totals.hrPerRack || Infinity) - (b.totals.hrPerRack || Infinity));

    const rows = sorted.map(c => `
      <tr>
        <td><strong>${_esc(c.employee_name)}</strong><br><span style="color:var(--text-muted);font-size:11px;">${_esc(c.employee_id)}</span></td>
        <td>${c.totals.totalDays}<span style="color:var(--text-muted);font-size:11px;"> (${c.totals.rackDays} w/racks)</span></td>
        <td>${_fmt(c.totals.totalRacks)}</td>
        <td>${c.totals.totalHours}</td>
        <td style="font-weight:700;color:#4edea3;">${c.totals.hrPerRack ?? '—'}</td>
        <td>${c.totals.avgRacksPerDay}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Captain</th>
              <th>Days Audited</th>
              <th>Total Racks</th>
              <th>Total Hours</th>
              <th>Audit Efficiency<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Hr / Rack)</span></th>
              <th>Avg Racks / Day</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _initTableSort(container.querySelector('.data-table'));
  }

  function _renderHeatmap(rackIntel) {
    const container = document.getElementById('inv-heatmap');
    if (!container) return;

    const heatmap = rackIntel.floorAisleHeatmap;
    if (!heatmap || heatmap.size === 0) {
      container.innerHTML = '<p class="placeholder-text">No rack data to display.</p>';
      return;
    }

    // Collect all unique aisles across all floors
    const allAisles = new Set();
    for (const [, aisleMap] of heatmap) {
      for (const aisle of aisleMap.keys()) allAisles.add(aisle);
    }
    const aisles = [...allAisles].sort();
    const floors = [...heatmap.keys()].sort();

    // Find max for color scaling
    let maxCount = 0;
    for (const [, aisleMap] of heatmap) {
      for (const [, count] of aisleMap) {
        if (count > maxCount) maxCount = count;
      }
    }

    const cols = aisles.length + 1; // +1 for row labels

    // Header row
    let html = `<div class="inv-heatmap-grid" style="grid-template-columns: 50px repeat(${aisles.length}, 1fr);">`;
    html += '<div class="inv-heatmap-label inv-heatmap-corner"></div>';
    for (const aisle of aisles) {
      html += `<div class="inv-heatmap-label">${aisle}</div>`;
    }

    // Data rows
    for (const floor of floors) {
      html += `<div class="inv-heatmap-label">${floor}</div>`;
      const aisleMap = heatmap.get(floor);
      for (const aisle of aisles) {
        const count = aisleMap?.get(aisle) || 0;
        const intensity = maxCount > 0 ? count / maxCount : 0;
        const bg = count === 0
          ? 'var(--surface-high)'
          : `rgba(78, 222, 163, ${(0.12 + intensity * 0.75).toFixed(2)})`;
        const textColor = intensity > 0.5 ? '#0f1419' : 'var(--text)';
        html += `<div class="inv-heatmap-cell" style="background:${bg};color:${textColor};" title="${floor}-${aisle}: ${count} audits">${count || ''}</div>`;
      }
    }
    html += '</div>';

    container.innerHTML = html;
  }

  function _renderTopRacks(sorted) {
    const container = document.getElementById('inv-top-racks');
    if (!container) return;

    const top = sorted.slice(0, 20);
    const maxCount = top.length > 0 ? top[0].count : 1;

    container.innerHTML = top.map((r, i) => {
      const pct = ((r.count / maxCount) * 100).toFixed(0);
      return `
        <div class="inv-rack-item">
          <span class="inv-rack-rank">${i + 1}</span>
          <span class="inv-rack-code">${_esc(r.rackCode)}</span>
          <div class="inv-rack-bar"><div class="inv-rack-bar-fill" style="width:${pct}%"></div></div>
          <span class="inv-rack-count">${r.count}</span>
          <span class="inv-rack-meta">${r.uniqueCaptains} cap · ${r.uniqueDates} days</span>
        </div>`;
    }).join('');
  }

  function _renderRackDetailTable(sorted) {
    const container = document.getElementById('inv-rack-table-container');
    if (!container) return;

    const rows = sorted.slice(0, 50).map(r => `
      <tr>
        <td style="font-family:'SF Mono','Fira Code',monospace;color:#c084fc;">${_esc(r.rackCode)}</td>
        <td>${_esc(r.floor)}</td>
        <td>${_esc(r.aisle)}</td>
        <td style="font-weight:700;">${r.count}</td>
        <td>${r.uniqueDates}</td>
        <td>${r.uniqueCaptains}</td>
        <td style="font-size:11px;color:var(--text-muted);">${r.lastAudited}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Rack Code</th>
              <th>Floor</th>
              <th>Aisle</th>
              <th>Audit Count</th>
              <th>Unique Days</th>
              <th>Unique Captains</th>
              <th>Last Audited</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _initTableSort(container.querySelector('.data-table'));
  }

  // ── Complaints Deep Dive ──────────────────────────────────────────

  let _complCache = null;
  let _complCacheKey = null;
  let _complIncludeQNG = true;
  let _complDateMode = false;
  let _complCatMode = 'total';
  let _complCatPeriodData = null;

  function initComplaintsDeepDive() {
    const complData = sheets.getComplaintsCached();
    const sel = document.getElementById('compl-preset');
    if (!sel || !complData || complData.length === 0) return;

    const weekly  = compute.aggregateWeekly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));
    const monthly = compute.aggregateMonthly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

    sel.innerHTML = [
      '<option value="all">All Time</option>',
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    // Default: full span of complaints data
    const sortedDates = complData.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      document.getElementById('compl-start').value = _isoDateStr(sortedDates[0]);
      document.getElementById('compl-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
    }

    _complDateMode = false;
    _complCache = null;
    _complCacheKey = null;
  }

  function onComplPeriodChange() {
    renderComplaintsDeepDive();
  }

  function onComplPresetChange() {
    _complDateMode = false;
    const complData = sheets.getComplaintsCached();
    if (!complData) return;
    const periodVal = document.getElementById('compl-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('compl-start').value = ds;
      document.getElementById('compl-end').value   = ds;
      _complDateMode = true;
      _complCache = null;
      _complCacheKey = null;
      renderComplaintsDeepDive();
      return;
    }

    if (periodVal === 'all') {
      const sortedDates = complData.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      if (sortedDates.length > 0) {
        document.getElementById('compl-start').value = _isoDateStr(sortedDates[0]);
        document.getElementById('compl-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
      }
    } else {
      const colonIdx   = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      const rows = complData.filter(row => {
        if (!row.date) return false;
        if (periodType === 'W') return compute.aggregateWeekly([{ date: row.date, dateStr: row.dateStr, employee_id: row.employee_id }]).some(w => w.week_key === periodKey);
        const ym = `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}`;
        return ym === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('compl-start').value = _isoDateStr(dates[0]);
        document.getElementById('compl-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    }
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function onComplDateChange() {
    _complDateMode = true;
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function toggleComplQNG() {
    _complIncludeQNG = !_complIncludeQNG;
    const btn = document.getElementById('compl-qng-toggle');
    if (btn) {
      btn.textContent = _complIncludeQNG ? 'QNG Included' : 'QNG Excluded';
      btn.classList.toggle('active', _complIncludeQNG);
    }
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function onComplCatModeChange(mode) {
    _complCatMode = mode;
    document.querySelectorAll('.compl-cat-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (_complCatPeriodData) {
      charts.renderComplaintCategoryChart('chart-compl-category', _complCatPeriodData, _complCatMode);
    }
  }

  function renderComplaintsDeepDive() {
    const container = document.getElementById('compl-content');
    if (!container) return;

    const complData = _supervisorFilter(sheets.getComplaintsCached() || []);
    const dailyData = _supervisorFilter(sheets.getCached());

    if (!complData || complData.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No complaints data available. Ensure the "Complaints" sheet exists in the source spreadsheet.</p>';
      return;
    }

    // Filter by date range
    const startVal = document.getElementById('compl-start')?.value;
    const endVal   = document.getElementById('compl-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0)     : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999)   : Infinity;
    let filteredCompl = complData.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    let filteredDaily = dailyData.filter(r => r.date && r.date >= startMs && r.date <= endMs);

    // Exclude QNG if toggled off
    if (!_complIncludeQNG) {
      filteredCompl = filteredCompl.filter(r => (r.complaint_category || '').toLowerCase() !== 'qng');
    }

    if (filteredCompl.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No complaints data for the selected period.</p>';
      return;
    }

    // Compute (or use cache)
    const cacheKey = `${startVal}_${endVal}_${complData.length}_qng${_complIncludeQNG ? 1 : 0}`;
    if (_complCacheKey !== cacheKey) {
      _complCache = compute.computeComplaintAggregations(filteredCompl, filteredDaily);
      _complCacheKey = cacheKey;
    }
    const agg = _complCache;
    if (!agg) return;

    const period = document.getElementById('compl-period')?.value || 'weekly';
    const periodData = period === 'daily' ? agg.storeSummary.dailyArray : period === 'monthly' ? agg.storeSummary.merchantCycle : agg.storeSummary.weekly;
    const totals = agg.storeSummary.totals;

    // Build full HTML
    container.innerHTML = `
      <!-- Stat Cards -->
      <div class="stat-cards-row">
        ${_invStatCard(ICONS.alertTriangle, 'stat-icon-red', 'Total Complaints', _fmt(totals.totalComplaints))}
        ${_invStatCard(ICONS.box, 'stat-icon-orange', 'Orders Affected', _fmt(totals.uniqueOrders))}
        ${_invStatCard(ICONS.barChart, 'stat-icon-amber', 'In-Store Fault Rate', totals.inStoreRate + '%')}
        ${_invStatCard(ICONS.box, 'stat-icon-blue', 'Total Orders Picked', _fmt(totals.totalOrdersPicked))}
      </div>

      <!-- Period Summary Table -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#4edea3;"></span>
          <h3 class="tiers-section-title">Period Summary</h3>
        </div>
        <div id="compl-summary-table"></div>
      </div>

      <!-- Zone 1: Trends -->
      <div class="compl-section">
        <div class="bento-grid">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Trend</h3>
                <p class="bento-card-subtitle">Total complaints vs in-store fault rate</p>
              </div>
            </div>
            <canvas id="chart-compl-trend"></canvas>
          </div>
          <div class="bento-card bento-small">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">RCA Breakdown</h3>
                <p class="bento-card-subtitle">Root cause distribution</p>
              </div>
            </div>
            <canvas id="chart-compl-rca"></canvas>
          </div>
        </div>
      </div>

      <!-- Zone 2: Captain Performance -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#ff6b6b;"></span>
          <h3 class="tiers-section-title">Captain Complaint Performance</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Orders Picked vs In-Store Complaints</h3>
                <p class="bento-card-subtitle">Each dot is a captain — size = complaint rate</p>
              </div>
            </div>
            <canvas id="chart-compl-scatter"></canvas>
          </div>
          <div class="bento-card bento-small" style="padding:16px;">
            <div class="bento-card-header" style="margin-bottom:12px;">
              <div>
                <h3 class="bento-card-title">Top Offenders</h3>
                <p class="bento-card-subtitle">By in-store complaints</p>
              </div>
            </div>
            <div id="compl-captain-ranking" class="compl-ranking-list"></div>
          </div>
        </div>
        <div id="compl-captain-table-container" style="margin-top:16px;"></div>
      </div>

      <!-- Zone 3: Category Intelligence -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#fb923c;"></span>
          <h3 class="tiers-section-title">Category Intelligence</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Categories Over Time</h3>
                <p class="bento-card-subtitle">% of total orders picked · stacked by complaint type</p>
              </div>
              <div class="compl-cat-mode-toggle">
                <button class="compl-cat-mode-btn${_complCatMode === 'total'   ? ' active' : ''}" data-mode="total"   onclick="ui.onComplCatModeChange('total')">Total</button>
                <button class="compl-cat-mode-btn${_complCatMode === 'instore' ? ' active' : ''}" data-mode="instore" onclick="ui.onComplCatModeChange('instore')">In-Store</button>
                <button class="compl-cat-mode-btn${_complCatMode === 'outstore'? ' active' : ''}" data-mode="outstore" onclick="ui.onComplCatModeChange('outstore')">Out-Store</button>
              </div>
            </div>
            <canvas id="chart-compl-category"></canvas>
          </div>
          <div class="bento-card bento-small">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Top L0 Categories</h3>
                <p class="bento-card-subtitle">By complaint volume</p>
              </div>
            </div>
            <canvas id="chart-compl-l0"></canvas>
          </div>
        </div>
        <div id="compl-category-table-container" style="margin-top:16px;"></div>
      </div>
    `;

    // Render period summary table (always uses merchant cycles regardless of weekly/monthly toggle)
    const summaryEl = document.getElementById('compl-summary-table');
    if (summaryEl) {
      summaryEl.innerHTML = _renderComplaintSummaryTable(agg.storeSummary.merchantCycle || []);
      _initTableSort(summaryEl.querySelector('.data-table'));
    }

    // Render charts
    _complCatPeriodData = periodData;
    charts.renderComplaintTrendChart('chart-compl-trend', periodData);
    charts.renderRCADonutChart('chart-compl-rca', agg.categoryIntel.sorted.rca);
    charts.renderComplaintCategoryChart('chart-compl-category', periodData, _complCatMode);
    charts.renderL0CategoryChart('chart-compl-l0', agg.categoryIntel.sorted.l0);

    // Render captain scatter
    const captainArr = [...agg.captainPerf.values()].sort((a, b) => b.inStoreYes - a.inStoreYes);
    charts.renderCaptainComplaintScatter('chart-compl-scatter', captainArr);

    // Render captain ranking + table
    _renderCaptainComplaintRanking(captainArr);
    _renderCaptainComplaintTable(captainArr);

    // Render category table
    _renderCategoryTable(agg.categoryIntel.sorted.l0);
  }

  function _renderComplaintSummaryTable(periodData) {
    const pct = (num, den, dp = 1) =>
      den > 0 ? _fmt(num / den * 100, dp) + '%' : '—';

    const rows = periodData.map(d => {
      const ord = d.totalOrdersPicked || 0;
      return `<tr>
        <td style="white-space:nowrap;">${_esc(d.label || d.weekKey || d.monthKey)}</td>
        <td>${_fmt(ord)}</td>
        <td>${_fmt(d.totalComplaints)}</td>
        <td>${_fmt(d.inStoreNo)}</td>
        <td>${_fmt(d.inStoreYes)}</td>
        <td>${pct(d.totalComplaints, ord, 2)}</td>
        <td>${pct(d.inStoreNo, ord, 2)}</td>
        <td>${pct(d.inStoreYes, ord, 2)}</td>
        <td>${_fmt(d.missingOutStore)}</td>
        <td>${_fmt(d.missingInStore)}</td>
        <td>${pct(d.missingInStore, ord, 2)}</td>
      </tr>`;
    }).join('');

    return `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Total Orders</th>
              <th>Total Complaints</th>
              <th>Out-Store Complaints</th>
              <th>In-Store Complaints</th>
              <th>Complaint %</th>
              <th>Out-Store Complaint %</th>
              <th>In-Store Complaint %</th>
              <th>Out-Store Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>In-Store Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>In-Store Missing %</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _renderCaptainComplaintRanking(captains) {
    const container = document.getElementById('compl-captain-ranking');
    if (!container) return;

    const top10 = captains.slice(0, 10);
    const maxVal = top10[0]?.inStoreYes || 1;

    container.innerHTML = top10.map((c, i) => {
      const initials = (c.employee_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const pct = Math.round((c.inStoreYes / maxVal) * 100);
      return `
        <div class="compl-ranking-item">
          <span class="compl-ranking-rank">${i + 1}</span>
          <span class="compl-ranking-avatar">${initials}</span>
          <div class="compl-ranking-info">
            <div class="compl-ranking-name">${_esc(c.employee_name)}</div>
            <div class="compl-ranking-sub">${c.complaintRate}% rate · ${_fmt(c.totalOrdersPicked)} orders</div>
          </div>
          <span class="compl-ranking-value">${c.inStoreYes}</span>
          <div class="compl-ranking-bar"><div class="compl-ranking-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  function _renderCaptainComplaintTable(captains) {
    const container = document.getElementById('compl-captain-table-container');
    if (!container) return;

    const rows = captains.map(c => {
      const rateClass    = c.complaintRate >= 1        ? 'rate-high' : c.complaintRate >= 0.5        ? 'rate-medium' : 'rate-low';
      const pfmRateClass = c.pickerFaultMissingRate >= 1 ? 'rate-high' : c.pickerFaultMissingRate >= 0.5 ? 'rate-medium' : 'rate-low';
      return `<tr>
        <td style="font-weight:600;">${_esc(c.employee_name)}</td>
        <td>${_fmt(c.totalOrdersPicked)}</td>
        <td>${c.totalComplaints}</td>
        <td style="font-weight:700;color:#ff6b6b;">${c.inStoreYes}</td>
        <td>${c.pickerFaultMissing ?? '—'}</td>
        <td><span class="compl-rate-badge ${pfmRateClass}">${c.pickerFaultMissingRate ?? 0}%</span></td>
        <td><span class="compl-rate-badge ${rateClass}">${c.complaintRate}%</span></td>
        <td>${_esc(c.topCategory)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Captain</th>
              <th>Total Orders</th>
              <th>Total Complaints</th>
              <th>In-Store Yes</th>
              <th>Picker Fault Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>Picker Fault Missing Rate</th>
              <th>Complaint Rate</th>
              <th>Top Category</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _initTableSort(container.querySelector('.data-table'));
  }

  function _renderCategoryTable(sortedL0) {
    const container = document.getElementById('compl-category-table-container');
    if (!container) return;

    const rows = sortedL0.map(c => {
      return `<tr>
        <td style="font-weight:600;">${_esc(c.category)}</td>
        <td>${c.count}</td>
        <td style="font-weight:700;color:#ff6b6b;">${c.inStoreYes}</td>
        <td>${c.inStorePct}%</td>
        <td style="font-size:12px;">${_esc(c.topProduct)}</td>
        <td style="font-size:12px;">${_esc(c.topRCA)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>L0 Category</th>
              <th>Complaints</th>
              <th>In-Store Yes</th>
              <th>In-Store %</th>
              <th>Top Product</th>
              <th>Top RCA</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _initTableSort(container.querySelector('.data-table'));
  }

  // ── Incentives ─────────────────────────────────────────────────────────

  let _incentiveCache = null;
  let _incentiveCacheKey = null;

  function initIncentivePeriods() {
    const data = _supervisorFilter(sheets.getCached());
    if (!data || data.length === 0) return;

    const monthly = compute.aggregateMonthly(data);
    const sel = document.getElementById('incentive-month');
    if (!sel) return;

    sel.innerHTML = monthly.slice().reverse()
      .map(m => `<option value="${m.month_key}">${m.label || m.month_key}</option>`)
      .join('');

    _incentiveCache = null;
    _incentiveCacheKey = null;
    renderIncentives();
  }

  function onIncentiveMonthChange() {
    _incentiveCache = null;
    _incentiveCacheKey = null;
    renderIncentives();
  }

  function renderIncentives() {
    const monthKey = document.getElementById('incentive-month')?.value;
    if (!monthKey) return;

    // Picking: use flagged daily data (has flows.is_picking)
    const flaggedData = _supervisorFilter(app.getFlaggedData() || []);
    // Audit: use Audits sheet (has audit_codes array for correct rack counts)
    const auditSheetData = _supervisorFilter(sheets.getAuditCached() || []);

    if (!flaggedData || flaggedData.length === 0) return;

    const cacheKey = `${monthKey}_${flaggedData.length}_${auditSheetData.length}`;
    if (_incentiveCacheKey !== cacheKey) {
      // Use any date-bearing data to derive week keys for this month
      const weekKeys = compute.getWeekKeysForMonth(flaggedData, monthKey);
      const slabOverrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
      const slabOverride  = slabOverrides[monthKey] || null;
      const picking = compute.computePickingIncentives(flaggedData, weekKeys, slabOverride);
      const audit   = compute.computeAuditIncentives(auditSheetData, monthKey);
      _incentiveCache = { weekKeys, picking, audit };
      _incentiveCacheKey = cacheKey;
    }

    const { weekKeys, picking, audit } = _incentiveCache;

    // ── Week labels: "Mar 30 – Apr 5 (2026)" style ──
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const weekLabels = weekKeys.map(wk => {
      const mon = compute.weekStartFromKey(wk);
      const sun = new Date(mon.getTime() + 6 * 86400000);
      const label = `${MONTHS[mon.getMonth()]} ${mon.getDate()} – ${MONTHS[sun.getMonth()]} ${sun.getDate()} (${sun.getFullYear()})`;
      return { key: wk, label };
    });

    // ── Aggregate totals ──
    let totalPicking = 0, totalAudit = 0, earningCount = 0;
    const allCaptains = new Set([...picking.keys(), ...audit.keys()]);
    for (const empId of allCaptains) {
      const p = picking.get(empId)?.total || 0;
      const a = audit.get(empId)?.amount || 0;
      totalPicking += p;
      totalAudit += a;
      if (p > 0 || a > 0) earningCount++;
    }

    // ── Stat cards ──
    const cardsEl = document.getElementById('incentive-stat-cards');
    if (cardsEl) {
      cardsEl.innerHTML = `
        <div class="stat-card">
          <div class="stat-label">Picking Incentive</div>
          <div class="stat-value" style="color:var(--accent)">\u20B9${_fmt(totalPicking)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Audit Incentive</div>
          <div class="stat-value" style="color:var(--green)">\u20B9${_fmt(totalAudit)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Payout</div>
          <div class="stat-value">\u20B9${_fmt(totalPicking + totalAudit)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Captains Earning</div>
          <div class="stat-value">${earningCount} / ${allCaptains.size}</div>
        </div>`;
    }

    // ── Unified table ──
    // Columns: Captain | [W1 Picking] [W2 Picking] ... | Audit Total | Total Incentive
    const tableEl = document.getElementById('incentive-table-content');
    if (!tableEl) return;

    // Build combined list sorted by total incentive desc
    const combined = [];
    for (const empId of allCaptains) {
      const cap   = picking.get(empId);
      const aud   = audit.get(empId);
      const name  = cap?.employee_name || aud?.employee_name || empId;
      const pTotal = cap?.total || 0;
      const aAmt   = aud?.amount || 0;
      combined.push({ empId, name, cap, aud, pTotal, aAmt, total: pTotal + aAmt });
    }
    combined.sort((a, b) => b.total - a.total);

    // Header
    const weekHeaders = weekLabels.map(w => `<th>${w.label}<br><small style="font-weight:400;opacity:0.8">Picking</small></th>`).join('');

    // Rows
    const rows = combined.map(c => {
      const weekCells = weekLabels.map(w => {
        const wk = c.cap?.weeks.get(w.key);
        if (!wk || wk.orders === 0) return '<td style="color:var(--text-muted)">—</td>';
        const amtClass = wk.amount > 0 ? 'cell-green' : '';
        const detail = `<div style="font-size:11px;color:var(--text-muted);font-weight:400;margin-top:2px">${_fmt(wk.orders)} orders · ${compute.formatDuration(wk.avgTime)}</div>`;
        return `<td class="${amtClass}">${wk.amount > 0 ? '\u20B9' + _fmt(wk.amount) : '—'}${detail}</td>`;
      }).join('');

      // Audit cell: show racks + amount
      let auditCell;
      if (c.aud) {
        const r = c.aud.totalRacks;
        auditCell = `<td class="${c.aud.amount > 0 ? 'cell-green' : ''}">\u20B9${_fmt(c.aud.amount)}<div style="font-size:11px;color:var(--text-muted);font-weight:400;margin-top:2px">${r} rack${r !== 1 ? 's' : ''}</div></td>`;
      } else {
        auditCell = `<td style="color:var(--text-muted)">—</td>`;
      }

      const rowClass = c.total > 0 ? '' : 'incentive-zero';
      return `<tr class="${rowClass}">
        <td><strong>${_esc(c.name)}</strong><br><small style="color:var(--text-muted)">${c.empId}</small></td>
        ${weekCells}
        ${auditCell}
        <td><strong>\u20B9${_fmt(c.total)}</strong></td>
      </tr>`;
    }).join('');

    // Totals row
    const weekTotals = weekLabels.map(w => {
      let wAmt = 0;
      for (const [, cap] of picking) { const wk = cap.weeks.get(w.key); if (wk) wAmt += wk.amount; }
      return `<td><strong>${wAmt > 0 ? '\u20B9' + _fmt(wAmt) : '—'}</strong></td>`;
    }).join('');

    tableEl.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Captain</th>
            ${weekHeaders}
            <th>Audit Total</th>
            <th>Total Incentive</th>
          </tr></thead>
          <tbody>
            ${rows}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid var(--border)">
              <td><strong>TOTAL</strong></td>
              ${weekTotals}
              <td><strong>\u20B9${_fmt(totalAudit)}</strong></td>
              <td><strong>\u20B9${_fmt(totalPicking + totalAudit)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    _initTableSort(tableEl.querySelector('.data-table'));
  }

  return {
    switchTab,
    renderStoreOverview,
    setOverviewPeriod,
    initOverviewPeriods,
    onOverviewPresetChange,
    onOverviewDateChange,
    initDeepDivePeriods,
    renderDeepDive,
    setDDFilter,
    toggleDDTier,
    togglePickingBreakdown,
    onDeepDivePresetChange,
    onDeepDiveDateChange,
    initTiersView,
    renderTiersView,
    onTierPresetChange,
    onTierDateChange,
    toggleTierMode,
    initFlagsDate,
    renderDailyFlags,
    initCaptainDropdown,
    initCaptainProfilePeriods,
    renderCaptainProfile,
    resetProfileDates,
    onProfilePresetChange,
    onProfileDateChange,
    onProfileCaptainAdd,
    onProfileExpGroupLoad,
    removeCaptain,
    setCpView,
    renderConfigPanel,
    initInventoryHealth,
    onInvPeriodChange,
    onInvPresetChange,
    onInvDateChange,
    renderInventoryHealth,
    initComplaintsDeepDive,
    onComplPeriodChange,
    onComplPresetChange,
    onComplDateChange,
    renderComplaintsDeepDive,
    toggleComplQNG,
    onComplCatModeChange,
    toggleSupervisors,
    addExcludedId,
    removeExcludedId,
    loadSlabMonth,
    saveSlabOverrides,
    resetSlabOverrides,
    saveFlowThresholds,
    resetFlowThresholds,
    toggleTheme,
    filterSupervisors,
    updateSupervisorBtn: _updateSupervisorBtn,
    initIncentivePeriods,
    onIncentiveMonthChange,
    renderIncentives,
  };
})();


// ═══════════════════════════════════════════════════════════════════════
//  app — Main orchestrator
// ═══════════════════════════════════════════════════════════════════════

const app = (() => {
  let _flaggedData  = null;
  let _storeStats   = null;
  let _personalAvgs = null;
  let _currentTab   = 'store-overview';

  async function init() {
    ui.renderConfigPanel();
    await refresh();
  }

  async function refresh() {
    _setLoading(true);
    try {
      const raw = await sheets.fetchData(true);
      await sheets.fetchAuditData(true);
      await sheets.fetchComplaintsData(true);
      await sheets.fetchRosterData(true);

      // Compute stats pipeline (filter supervisors before stats/flagging)
      const filteredRaw = ui.filterSupervisors(raw);
      _storeStats   = compute.computeStoreStats(filteredRaw);
      _personalAvgs = compute.computePersonalAvgs(filteredRaw);
      const _storedThresholds = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
      _flaggedData  = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, _storedThresholds);

      // Update last-refreshed timestamp
      const ts = document.getElementById('last-refreshed');
      if (ts) ts.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;

      ui.updateSupervisorBtn();

      // Init dynamic dropdowns
      ui.initDeepDivePeriods();
      ui.initFlagsDate();
      ui.initCaptainDropdown();
      ui.initCaptainProfilePeriods();
      ui.initOverviewPeriods();
      ui.initTiersView();
      ui.initInventoryHealth();
      ui.initComplaintsDeepDive();
      ui.initIncentivePeriods();

      // Render active tab
      _renderCurrentTab();

      // Update config row count
      const countEl = document.getElementById('config-row-count');
      if (countEl) countEl.textContent = raw.length.toLocaleString();

    } catch (err) {
      console.error('Dashboard load error:', err);
      alert(`Failed to load data: ${err.message}`);
    } finally {
      _setLoading(false);
    }
  }

  function switchTab(tabId) {
    _currentTab = tabId;
    ui.switchTab(tabId);
    _renderCurrentTab();
  }

  function updateThreshold(val) {
    CONFIG.THRESHOLD = parseFloat(val) || 1.0;
    // Re-flag with new threshold
    const raw = sheets.getCached();
    if (raw.length > 0) {
      const filteredRaw = ui.filterSupervisors(raw);
      const storedThresholds = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
      _flaggedData = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, storedThresholds);
      _renderCurrentTab();
    }
  }

  function updateFloorDeviation(val) {
    CONFIG.FLOOR_DEVIATION = parseFloat(val) ?? 0.30;
    _renderCurrentTab();
  }

  function updateFlowThresholds(thresholdMap, filteredRaw) {
    _flaggedData = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, thresholdMap);
    _renderCurrentTab();
  }

  function _renderCurrentTab() {
    switch (_currentTab) {
      case 'store-overview':    ui.renderStoreOverview(); break;
      case 'captain-deep-dive': ui.renderDeepDive(); break;
      case 'daily-flags':       ui.renderDailyFlags(); break;
      case 'captain-profile':   ui.renderCaptainProfile(); break;
      case 'tier-analysis':     ui.renderTiersView(); break;
      case 'inventory-health':       ui.renderInventoryHealth(); break;
      case 'complaints-deep-dive':   ui.renderComplaintsDeepDive(); break;
      case 'incentives':             ui.renderIncentives(); break;
      case 'config-panel':           ui.renderConfigPanel(); break;
    }
  }

  function _setLoading(show) {
    const el = document.getElementById('loading-overlay');
    if (el) el.classList.toggle('hidden', !show);
  }

  function getFlaggedData()  { return _flaggedData; }
  function getStoreStats()   { return _storeStats; }
  function getPersonalAvgs() { return _personalAvgs; }

  return { init, refresh, switchTab, updateThreshold, updateFloorDeviation, updateFlowThresholds, getFlaggedData, getStoreStats, getPersonalAvgs, renderCurrentTab: _renderCurrentTab };
})();
