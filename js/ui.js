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
  const _FT_DEFAULTS = {
    picking: { critical: 0.5,  flagged: 0.25, borderline: 0.1  },
    putting: { critical: 0.25, flagged: 0.1,  borderline: 0.01 },
    audit:   { critical: 0.5,  flagged: 0.25, borderline: 0.1  },
    fnv:     { critical: 2,    flagged: 1,    borderline: 0.5  },
  };
  const _FT_FLOWS = ['picking', 'putting', 'audit', 'fnv'];

  // ── Productivity Weights ─────────────────────────────────────────────
  const _PW_DEFAULTS = { order: 6, putaway: 1, rack: 315 };

  function _getProductivityWeights() {
    const stored = JSON.parse(localStorage.getItem('productivityWeights') || '{}');
    return {
      order:   +(stored.order   ?? _PW_DEFAULTS.order),
      putaway: +(stored.putaway ?? _PW_DEFAULTS.putaway),
      rack:    +(stored.rack    ?? _PW_DEFAULTS.rack),
    };
  }

  function updateProductivityWeights() {
    const order   = parseFloat(document.getElementById('pw-order')?.value);
    const putaway = parseFloat(document.getElementById('pw-putaway')?.value);
    const rack    = parseFloat(document.getElementById('pw-rack')?.value);
    if ([order, putaway, rack].some(isNaN)) return;
    localStorage.setItem('productivityWeights', JSON.stringify({ order, putaway, rack }));
    const msg = document.getElementById('pw-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
    renderStoreOverview();
  }

  function resetProductivityWeights() {
    localStorage.removeItem('productivityWeights');
    renderConfigPanel();
    renderStoreOverview();
  }

  // ── Staff Availability divisor (orders ÷ X = required hours) ─────────
  const _STAFF_AVAIL_DEFAULT_DIVISOR = 6.8;

  function _getStaffAvailDivisor() {
    return parseFloat(localStorage.getItem('staffAvailDivisor') || _STAFF_AVAIL_DEFAULT_DIVISOR);
  }

  function updateStaffAvailDivisor(val) {
    const v = parseFloat(val);
    if (!isNaN(v) && v > 0) {
      localStorage.setItem('staffAvailDivisor', v);
      const msg = document.getElementById('staff-avail-saved-msg');
      if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
      renderStoreOverview();
    }
  }

  function resetStaffAvailDivisor() {
    localStorage.removeItem('staffAvailDivisor');
    renderConfigPanel();
    renderStoreOverview();
  }

  function _getFlowThresholds(flow) {
    const stored = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
    const defaults = _FT_DEFAULTS[flow] || { critical: 2, flagged: 1, borderline: 0.5 };
    return { ...defaults, ...(stored[flow] || {}) };
  }

  function _readFlowThresholdInputs() {
    const out = {};
    for (const flow of _FT_FLOWS) {
      const def = _FT_DEFAULTS[flow];
      out[flow] = {
        critical:   parseFloat(document.getElementById(`ft-${flow}-critical`)?.value)   || def.critical,
        flagged:    parseFloat(document.getElementById(`ft-${flow}-flagged`)?.value)    || def.flagged,
        borderline: parseFloat(document.getElementById(`ft-${flow}-borderline`)?.value) || def.borderline,
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
    const monthly = compute.aggregateBillingMonthly(data);

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
      if (periodType === 'W') {
        const rows = data.filter(row => row.date && compute.aggregateWeekly([row]).some(w => w.week_key === periodKey));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('overview-start').value = _isoDateStr(dates[0]);
          document.getElementById('overview-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('overview-start', 'overview-end', periodKey);
      }
    }
    renderStoreOverview();
  }

  function onOverviewDateChange() {
    _overviewDateMode = true;
    renderStoreOverview();
  }

  // ── Store Overview: SLA band ───────────────────────────────────────
  // Cycle-to-date position on the three SLA targets, always pinned to the
  // CURRENT billing cycle (26th → 25th) regardless of the date filter below.
  // Cards click through to the Key Metrics tab.
  function _renderOverviewSlaBand() {
    const el = document.getElementById('overview-sla-band');
    if (!el) return;
    const instore = sheets.getInstoreCached() || [];
    const compl = sheets.getComplaintsCached() || [];
    if (!instore.length && !compl.length) { el.innerHTML = ''; return; }

    const DAY = 86400000;
    const now = new Date();
    const cycleKey = _billingCycleKeyOf(now);
    const [cy, cm] = cycleKey.split('-').map(Number);
    const cycleStart = new Date(cy, cm - 2, 26).getTime();
    const cycleEnd   = new Date(cy, cm - 1, 25, 23, 59, 59, 999).getTime();
    const targets = _getSlaTargets(cycleKey);
    const snap = _kmSnapshot(cycleStart, Math.min(cycleEnd, Date.now()));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yday = _kmSnapshot(today.getTime() - DAY, today.getTime() - 1);

    const card = (title, value, tiers, direction, ydayPct, foot) => {
      const r = _kmTierReached(value, tiers, direction);
      return `
        <button type="button" class="ov-sla-card ${r.cls}" onclick="app.switchTab('key-metrics')">
          <div class="ov-sla-head"><span class="ov-sla-title">${title}</span><span class="km-score-badge">${r.label}</span></div>
          <div class="ov-sla-value">${value != null ? value + '%' : '—'}</div>
          <div class="ov-sla-foot">${foot}</div>
          <div class="ov-sla-yday">T-1: <strong>${ydayPct != null ? ydayPct + '%' : '—'}</strong> · SLA 2 at ${tiers.sla2}%</div>
        </button>`;
    };

    el.innerHTML = `
      <div class="ov-sla-band-head">
        <span class="ov-sla-band-title">SLA Position — ${_billingMonthLabel(cycleKey)}</span>
        <span class="ov-sla-band-hint">cycle to date · tap a card for the full breakdown</span>
      </div>
      <div class="ov-sla-grid">
        ${card('In-Store Time', snap.instore.pct, targets.instore, 'high', yday.instore.pct,
          `${_fmt(snap.instore.met)} / ${_fmt(snap.instore.denom)} orders ≤ 2.5 min (IPO ≤ 6)`)}
        ${card('Complaints', snap.compl.pct, targets.complaints, 'low', yday.compl.pct,
          `${_fmt(snap.compl.items)} qualifying items · ${_fmt(snap.compl.orders)} orders`)}
        ${_ovFillRateCard(card, snap, yday, targets)}
      </div>`;
  }

  // Fill Rate card for the Store Overview SLA band. Uses the shared `card`
  // builder when PNA / missing data exists for the cycle, else a placeholder.
  function _ovFillRateCard(card, snap, yday, targets) {
    const fill = snap.fill;
    const hasData = fill && (fill.pnaOrders > 0 || fill.missOrders > 0) && fill.checkoutOrders > 0;
    if (!hasData) {
      return `
        <button type="button" class="ov-sla-card km-tier-na km-soon" onclick="app.switchTab('key-metrics')">
          <div class="ov-sla-head"><span class="ov-sla-title">Fill Rate</span><span class="km-score-badge">NO DATA</span></div>
          <div class="ov-sla-value">—</div>
          <div class="ov-sla-foot">Delivered in full ÷ checkout orders</div>
          <div class="ov-sla-yday">No PNA / missing-item rows this cycle</div>
        </button>`;
    }
    return card('Fill Rate', fill.pct, targets.fillrate, 'high', yday.fill ? yday.fill.pct : null,
      `${_fmt(fill.inFull)} / ${_fmt(fill.checkoutOrders)} in full · ${_fmt(fill.affected)} short`);
  }

  function renderStoreOverview() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    _renderOverviewSlaBand();

    const auditData      = _supervisorFilter(sheets.getAuditCached() || []);
    const complaintsData = _supervisorFilter(sheets.getComplaintsCached() || []);
    const instoreData    = _supervisorFilter(sheets.getInstoreCached() || []);

    // Filter by date range
    const startVal = document.getElementById('overview-start')?.value;
    const endVal   = document.getElementById('overview-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0)   : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999) : Infinity;
    const filtered      = data.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    const filteredAudit = auditData ? auditData.filter(r => r.date && r.date >= startMs && r.date <= endMs) : [];
    const filteredCompl = complaintsData ? complaintsData.filter(r => r.date && r.date >= startMs && r.date <= endMs) : [];
    const filteredInstore = instoreData ? instoreData.filter(r => r.date && r.date >= startMs && r.date <= endMs) : [];

    const period = document.getElementById('overview-period')?.value || 'weekly';
    const aggregated = period === 'daily'
      ? compute.aggregateDaily(filtered, filteredAudit, filteredCompl, filteredInstore)
      : period === 'weekly'
        ? compute.aggregateWeekly(filtered, filteredAudit, filteredCompl, filteredInstore)
        : compute.aggregateBillingMonthly(filtered, filteredAudit, filteredCompl, filteredInstore);

    // Charts
    charts.renderOrdersHoursChart('chart-orders-hours', aggregated);
    charts.renderTimeMetricsChart('chart-time-metrics', aggregated);
    charts.renderActiveTimeProductivityChart('chart-active-productivity', aggregated);
    charts.renderPutawayChart('chart-putaway-hours', aggregated);
    charts.renderIPHChart('chart-iph', aggregated);
    charts.renderStoreAuditVolumeChart('chart-store-audit-volume', aggregated);
    charts.renderAuditEfficiencyChart('chart-audit-efficiency', aggregated);
    charts.renderProductivityPerHourChart('chart-productivity-per-hour', aggregated);
    charts.renderOrdersPerHourChart('chart-orders-per-hour', aggregated);
    charts.renderStaffAvailabilityChart('chart-staff-availability', aggregated);

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
      <th>Avg Ready to Assign</th>
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
      <td>${compute.formatDuration(d.avg_ready_to_assign)}</td>
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
    const monthly = compute.aggregateBillingMonthly(data);

    const sel = document.getElementById('deep-dive-period');
    if (!sel) return;

    sel.innerHTML = [
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${_billingMonthLabel(d.month_key)}</option>`),
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
    if (periodType === 'D') {
      const rows = data.filter(row => row.date && row.dateStr === periodKey);
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('deep-dive-start').value = _isoDateStr(dates[0]);
        document.getElementById('deep-dive-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    } else if (periodType === 'W') {
      const rows = data.filter(row => {
        if (!row.date) return false;
        const wk = compute.aggregateWeekly([row]);
        return wk.length > 0 && wk[0].week_key === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('deep-dive-start').value = _isoDateStr(dates[0]);
        document.getElementById('deep-dive-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    } else {
      _applyBillingMonthDates('deep-dive-start', 'deep-dive-end', periodKey);
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
        if (e.target?.closest?.('.table-filter-btn')) return;
        _doDeepDiveSort();
      }, { passive: false });
      let _ddLastTouch = 0;
      th.addEventListener('touchend', () => { _ddLastTouch = Date.now(); }, { passive: true });
      th.addEventListener('click', (e) => {
        if (e.target?.closest?.('.table-filter-btn')) return;
        if (Date.now() - _ddLastTouch < 500) return;
        _doDeepDiveSort();
      });
    });
    container.querySelectorAll('.dd-table').forEach(t => _initTableFilters(t));
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

  const _FILTER_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h12L9 8.5V13l-2 1V8.5z"/></svg>';
  let _tableFilterPopover = null;

  /**
   * Generic DOM table sorter.
   * Attaches asc/desc click sorting to every <th> in the table's <thead>.
   * Compares cell text numerically when both values parse as numbers,
   * otherwise lexicographically. "—" and empty cells sort last.
   */
  function _initTableSort(tableEl) {
    if (!tableEl) return;
    _initTableFilters(tableEl);

    const ths = [...tableEl.querySelectorAll('thead th')];
    ths.forEach((th, colIdx) => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      if (th.dataset.sortBound === '1') return;
      th.dataset.sortBound = '1';

      // Core sort handler — shared by both click and touchend
      function _doSort() {
        const tbody = tableEl.querySelector('tbody');
        if (!tbody) return;
        const prevDir = th.dataset.sortDir || '';
        const dir = prevDir === 'asc' ? 'desc' : 'asc';
        // Reset all headers
        ths.forEach(t => {
          t.dataset.sortDir = '';
          const marker = t.querySelector('.table-sort-marker');
          if (marker) marker.textContent = '';
        });
        th.dataset.sortDir = dir;
        const marker = th.querySelector('.table-sort-marker');
        if (marker) marker.textContent = dir === 'asc' ? ' ▲' : ' ▼';
        // Sort rows
        const rows = [...tbody.querySelectorAll('tr')];
        rows.sort((rowA, rowB) => {
          const aRaw = _tableCellText(rowA.cells[colIdx]);
          const bRaw = _tableCellText(rowB.cells[colIdx]);
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
        if (e.target?.closest?.('.table-filter-btn')) return;
        _doSort();
      }, { passive: false });

      // click handles desktop mice and keyboard Enter/Space on focused th
      let _lastTouchEnd = 0;
      th.addEventListener('touchend', () => { _lastTouchEnd = Date.now(); }, { passive: true });
      th.addEventListener('click', (e) => {
        if (e.target?.closest?.('.table-filter-btn')) return;
        if (Date.now() - _lastTouchEnd < 500) return; // already handled by touchend
        _doSort();
      });
    });
  }

  function _initTableFilters(tableEl) {
    if (!tableEl) return;
    const ths = [...tableEl.querySelectorAll('thead th')];
    if (ths.length === 0) return;

    if (!tableEl._columnFilters) tableEl._columnFilters = new Map();
    tableEl.classList.add('filterable-table');

    ths.forEach((th, colIdx) => {
      _ensureTableHeaderControls(th, colIdx);
      const btn = th.querySelector('.table-filter-btn');
      if (!btn || btn.dataset.filterBound === '1') return;
      btn.dataset.filterBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openTableFilterPopover(tableEl, colIdx, th, btn);
      });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openTableFilterPopover(tableEl, colIdx, th, btn);
      }, { passive: false });
    });

    _applyTableFilters(tableEl);
  }

  function _ensureTableHeaderControls(th, colIdx) {
    if (th.dataset.filterReady === '1') return;
    th.dataset.filterReady = '1';
    if (th.dataset.origHtml === undefined) th.dataset.origHtml = th.innerHTML;
    const label = th.dataset.origHtml || `Column ${colIdx + 1}`;
    th.innerHTML = `
      <span class="table-header-control">
        <span class="table-header-label">${label}</span>
        <span class="table-sort-marker" aria-hidden="true"></span>
        <button type="button" class="table-filter-btn" data-col="${colIdx}" aria-label="Filter column ${colIdx + 1}">${_FILTER_ICON}</button>
      </span>`;
  }

  function _openTableFilterPopover(tableEl, colIdx, th, btn) {
    _closeTableFilterPopover();

    const kind = _inferTableFilterKind(tableEl, colIdx);
    const current = tableEl._columnFilters?.get(colIdx) || null;
    const label = (th.dataset.origHtml || th.textContent || `Column ${colIdx + 1}`)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || `Column ${colIdx + 1}`;

    const pop = document.createElement('div');
    pop.id = 'table-filter-popover';
    pop.className = 'table-filter-popover';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = _tableFilterPopoverHTML(label, kind, current);
    document.body.appendChild(pop);
    _tableFilterPopover = pop;

    const rect = btn.getBoundingClientRect();
    const width = 260;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, Math.min(window.innerHeight - pop.offsetHeight - 12, rect.bottom + 8))}px`;

    const operator = pop.querySelector('[data-filter-role="operator"]');
    const value1 = pop.querySelector('[data-filter-role="value1"]');
    const value2 = pop.querySelector('[data-filter-role="value2"]');
    const betweenRow = pop.querySelector('[data-filter-role="between-row"]');
    const applyBtn = pop.querySelector('[data-filter-action="apply"]');
    const clearBtn = pop.querySelector('[data-filter-action="clear"]');

    const syncFields = () => {
      const isBetween = operator?.value === 'between';
      if (betweenRow) betweenRow.classList.toggle('hidden', !isBetween);
      if (value1) value1.placeholder = isBetween ? 'Min' : (kind === 'number' ? 'Value' : 'Text');
    };
    operator?.addEventListener('change', syncFields);
    syncFields();

    const apply = () => {
      const op = operator?.value || '';
      const v1 = value1?.value?.trim() || '';
      const v2 = value2?.value?.trim() || '';
      if (!op || (op !== 'empty' && op !== 'not_empty' && !v1)) {
        tableEl._columnFilters.delete(colIdx);
      } else {
        tableEl._columnFilters.set(colIdx, { kind, op, v1, v2 });
      }
      _applyTableFilters(tableEl);
      _closeTableFilterPopover();
    };

    applyBtn?.addEventListener('click', apply);
    clearBtn?.addEventListener('click', () => {
      tableEl._columnFilters.delete(colIdx);
      _applyTableFilters(tableEl);
      _closeTableFilterPopover();
    });
    pop.addEventListener('click', e => e.stopPropagation());
    pop.addEventListener('keydown', e => {
      if (e.key === 'Enter') apply();
      if (e.key === 'Escape') _closeTableFilterPopover();
    });
    setTimeout(() => document.addEventListener('click', _closeTableFilterPopover, { once: true }), 0);
    value1?.focus();
  }

  function _tableFilterPopoverHTML(label, kind, current) {
    const isNumber = kind === 'number';
    const op = current?.op || (isNumber ? 'gt' : 'contains');
    const v1 = current?.v1 || '';
    const v2 = current?.v2 || '';
    const numberOps = [
      ['gt', 'Greater than'],
      ['gte', 'Greater than or equal'],
      ['lt', 'Less than'],
      ['lte', 'Less than or equal'],
      ['eq', 'Equals'],
      ['between', 'Between'],
      ['empty', 'Blank'],
      ['not_empty', 'Not blank'],
    ];
    const textOps = [
      ['contains', 'Contains'],
      ['not_contains', 'Does not contain'],
      ['eq', 'Equals'],
      ['starts', 'Starts with'],
      ['empty', 'Blank'],
      ['not_empty', 'Not blank'],
    ];
    const opts = (isNumber ? numberOps : textOps)
      .map(([value, text]) => `<option value="${value}"${op === value ? ' selected' : ''}>${text}</option>`)
      .join('');
    const inputType = isNumber ? 'number' : 'text';

    return `
      <div class="table-filter-title">${_esc(label)}</div>
      <select class="table-filter-select" data-filter-role="operator">${opts}</select>
      <input class="table-filter-input" data-filter-role="value1" type="${inputType}" value="${_esc(v1)}" />
      <div class="table-filter-between${op === 'between' ? '' : ' hidden'}" data-filter-role="between-row">
        <input class="table-filter-input" data-filter-role="value2" type="${inputType}" value="${_esc(v2)}" placeholder="Max" />
      </div>
      <div class="table-filter-actions">
        <button type="button" class="table-filter-clear" data-filter-action="clear">Clear</button>
        <button type="button" class="table-filter-apply" data-filter-action="apply">Apply</button>
      </div>`;
  }

  function _closeTableFilterPopover() {
    _tableFilterPopover?.remove();
    _tableFilterPopover = null;
  }

  function _inferTableFilterKind(tableEl, colIdx) {
    const rows = [...tableEl.querySelectorAll('tbody tr')].filter(r => !r.classList.contains('dd-tier-divider'));
    let filled = 0;
    let numeric = 0;
    for (const row of rows.slice(0, 40)) {
      const raw = _tableCellText(row.cells[colIdx]);
      if (!raw || raw === '—') continue;
      filled++;
      if (_tableNumericValue(raw) !== null) numeric++;
    }
    return filled > 0 && numeric / filled >= 0.6 ? 'number' : 'text';
  }

  function _tableCellText(cell) {
    if (!cell) return '';
    const controlValues = [...cell.querySelectorAll('select,input,textarea')]
      .map(el => {
        if (el.tagName === 'SELECT') return el.selectedOptions?.[0]?.textContent || el.value || '';
        return el.value || '';
      })
      .filter(Boolean);
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('select,input,textarea,script,style').forEach(el => el.remove());
    return [...controlValues, clone.textContent || ''].join(' ').replace(/\s+/g, ' ').trim();
  }

  function _tableNumericValue(raw) {
    const text = String(raw || '').trim();
    if (!text || text === '—') return null;
    const firstPart = text.split('|')[0].trim();
    const duration = firstPart.match(/^(-?\d+):(\d{2})(?::(\d{2}))?$/);
    if (duration) {
      const a = Number(duration[1]);
      const b = Number(duration[2]);
      const c = duration[3] === undefined ? null : Number(duration[3]);
      return c === null ? (a * 60) + b : (a * 3600) + (b * 60) + c;
    }
    const words = firstPart.match(/[A-Za-z]+/g) || [];
    if (words.length > 0) {
      const allowedUnits = new Set(['h', 'hr', 'hrs', 'hour', 'hours', 's', 'sec', 'secs', 'second', 'seconds', 'm', 'min', 'mins', 'minute', 'minutes', 'order', 'orders', 'rack', 'racks', 'day', 'days']);
      if (words.some(w => !allowedUnits.has(w.toLowerCase()))) return null;
    }
    const cleaned = firstPart.replace(/,/g, '').replace(/[^\d.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function _applyTableFilters(tableEl) {
    const filters = tableEl._columnFilters || new Map();
    const rows = [...tableEl.querySelectorAll('tbody tr')];
    if (filters.size === 0) {
      rows.forEach(row => { row.hidden = false; });
    } else {
      rows.forEach(row => {
        if (row.classList.contains('dd-tier-divider')) {
          row.hidden = true;
          return;
        }
        row.hidden = !_rowPassesTableFilters(row, filters);
      });
      _syncDividerRows(rows);
    }

    tableEl.classList.toggle('has-table-filters', filters.size > 0);
    tableEl.querySelectorAll('.table-filter-btn').forEach(btn => {
      const colIdx = Number(btn.dataset.col);
      btn.classList.toggle('active', filters.has(colIdx));
    });
  }

  function _rowPassesTableFilters(row, filters) {
    for (const [colIdx, filter] of filters.entries()) {
      const raw = _tableCellText(row.cells[colIdx]);
      if (!_cellPassesTableFilter(raw, filter)) return false;
    }
    return true;
  }

  function _cellPassesTableFilter(raw, filter) {
    const text = String(raw || '').trim();
    if (filter.op === 'empty') return !text || text === '—';
    if (filter.op === 'not_empty') return !!text && text !== '—';

    if (filter.kind === 'number') {
      const value = _tableNumericValue(text);
      const v1 = Number(filter.v1);
      const v2 = Number(filter.v2);
      if (value === null || !Number.isFinite(v1)) return false;
      if (filter.op === 'gt') return value > v1;
      if (filter.op === 'gte') return value >= v1;
      if (filter.op === 'lt') return value < v1;
      if (filter.op === 'lte') return value <= v1;
      if (filter.op === 'eq') return value === v1;
      if (filter.op === 'between') return Number.isFinite(v2) && value >= Math.min(v1, v2) && value <= Math.max(v1, v2);
      return true;
    }

    const hay = text.toLowerCase();
    const needle = String(filter.v1 || '').toLowerCase();
    if (filter.op === 'contains') return hay.includes(needle);
    if (filter.op === 'not_contains') return !hay.includes(needle);
    if (filter.op === 'eq') return hay === needle;
    if (filter.op === 'starts') return hay.startsWith(needle);
    return true;
  }

  function _syncDividerRows(rows) {
    let divider = null;
    let hasVisibleInGroup = false;
    const flush = () => {
      if (divider) divider.hidden = !hasVisibleInGroup;
    };
    for (const row of rows) {
      if (row.classList.contains('dd-tier-divider')) {
        flush();
        divider = row;
        hasVisibleInGroup = false;
      } else if (!row.hidden) {
        hasVisibleInGroup = true;
      }
    }
    flush();
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
        <td>${_statusBadgeByDev(captain.deviations.get('total_time_per_order'), 'picking')}</td>
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
        <td>${_fmt(captain.total_putter_hours, 1)} h</td>
        <td class="${captain.zero_put ? 'cell-red' : ''}">${_fmt(captain.total_putaway_qty)}</td>
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
        ${_thSort('Putter Hours', 'put_hours', 'putting')}
        ${_thSort('Putaway Qty', 'putaway_qty', 'putting')}
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
        <td>${_fmt(captain.total_auditor_hours, 1)} h</td>
        <td class="${captain.zero_audit ? 'cell-red' : ''}">${_fmt(captain.total_racks_audited)}</td>
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
        ${_thSort('Auditor Hours', 'audit_hours', 'audit')}
        ${_thSort('Racks Audited', 'racks', 'audit')}
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

  // ── Attendance ────────────────────────────────────────────────────────

  const _ATTENDANCE_OVERRIDE_KEY = 'attendanceOverrides';
  const _ATTENDANCE_MANUAL_OPTIONS = [
    'Full-day',
    'Half-day',
    'Off',
    'N/A',
    'Unplanned Leave',
    ...Array.from({ length: 13 }, (_, i) => `${i + 1} hrs`),
  ];
  const _ATTENDANCE_TIME_FIELDS = [
    { key: 'total_active_time', label: 'Total Active' },
    { key: 'picker_active_time', label: 'Picking' },
    { key: 'putter_active_time', label: 'Putting' },
    { key: 'auditor_active_time', label: 'Audit' },
    { key: 'fnv_active_time', label: 'FNV' },
  ];
  let _attendanceSort = { key: 'name', dir: 'asc' };
  let _attendancePopoverDismiss = null;
  let _attendancePopoverEscape = null;

  function initAttendance() {
    const input = document.getElementById('attendance-month');
    if (!input) return;
    if (!input.value) input.value = _latestAttendanceMonth();
    renderAttendance();
  }

  function onAttendanceMonthChange() {
    _hideAttendanceTimePopover();
    renderAttendance();
  }

  function renderAttendance() {
    _hideAttendanceTimePopover();
    const monthInput = document.getElementById('attendance-month');
    const gridEl = document.getElementById('attendance-grid');
    if (!monthInput || !gridEl) return;

    if (!monthInput.value) monthInput.value = _latestAttendanceMonth();
    const monthKey = monthInput.value;
    const [year, month] = monthKey.split('-').map(Number);
    if (!year || !month) return;

    const data = sheets.getCached();
    const rosterRows = sheets.getRosterCached();
    const dates = _attendanceMonthDates(year, month);
    const hoursByKey = _attendanceHoursByKey(data);
    const rosterByCaptain = _attendanceRosterByCaptain(rosterRows);
    const overrides = _getAttendanceOverrides();
    const activeIds = _attendanceActiveCaptainIds(dates, rosterByCaptain);
    const captains = _attendanceCaptains(rosterRows).filter(c => activeIds.has(c.id));
    const bonusResults = compute.computeAttendanceBonus(data, rosterRows, monthKey, overrides);
    const summary = { active: 0, full: 0, half: 0, off: 0, na: 0, totalStaff: _attendanceMonthTotalHours(dates, hoursByKey) };

    if (captains.length === 0) {
      gridEl.innerHTML = `<p class="placeholder-text">No roster-active captains found in ${_esc(_attendanceMonthLabel(monthKey))}.</p>`;
      _renderAttendanceSummary(summary, monthKey);
      return;
    }

    const headDays = dates.map(date => {
      const iso = _isoDateStr(date);
      const day = date.toLocaleDateString(undefined, { weekday: 'short' });
      const label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return _attendanceTh(
        `<span>${day}</span><strong>${label}</strong>`,
        `date:${iso}`,
        'attendance-date-col'
      );
    }).join('');

    const candidateRows = captains.map(captain => {
      const cells = dates.map(date => {
        const iso = _isoDateStr(date);
        const auto = _computeAttendanceStatus(captain.id, date, hoursByKey, rosterByCaptain);
        const key = _attendanceOverrideKey(captain.id, iso);
        const override = overrides[key] || '';
        const value = override || auto.status;

        return { iso, auto, override, value };
      });
      const workDays = cells.reduce((sum, cell) => sum + _attendanceWorkDayValue(cell.value), 0);
      const weekOffs = cells.filter(cell => cell.value === 'Off').length;
      return { captain, cells, workDays, weekOffs, bonus: bonusResults.get(captain.id) || null };
    });
    const rows = candidateRows.filter(row =>
      row.cells.some(cell => _attendanceWorkDayValue(cell.value) > 0)
    );

    if (rows.length === 0) {
      gridEl.innerHTML = `<p class="placeholder-text">No captains have at least 1 active working day in ${_esc(_attendanceMonthLabel(monthKey))}.</p>`;
      _renderAttendanceSummary(summary, monthKey);
      return;
    }

    for (const row of rows) {
      for (const cell of row.cells) _addAttendanceSummary(summary, cell.value);
    }

    rows.sort(_attendanceRowSorter);

    const attendanceRows = rows.map(row => {
      const cellHtml = row.cells.map(cell => {
        const statusCls = _attendanceStatusClass(cell.value);
        const autoCls = _attendanceStatusClass(cell.auto.status);
        const autoHours = cell.auto.rawHours > 0 ? ` · ${_fmt(cell.auto.rawHours, 1)}h` : '';

        return `
          <td class="attendance-status-cell">
            <div class="attendance-cell-stack">
              <select class="attendance-select ${cell.override ? `status-${statusCls} manual` : 'status-manual'}"
                    data-emp-id="${_esc(row.captain.id)}"
                    data-date="${cell.iso}"
                    data-auto="${_esc(cell.auto.status)}"
                    onchange="ui.onAttendanceOverrideChange(this)">
              <option value="" ${cell.override ? '' : 'selected'}>Use auto</option>
              ${_ATTENDANCE_MANUAL_OPTIONS.map(opt =>
                `<option value="${_esc(opt)}" ${cell.override === opt ? 'selected' : ''}>${_esc(opt)}</option>`
              ).join('')}
            </select>
              <div class="attendance-auto-line status-${autoCls}">Auto: ${_esc(cell.auto.status)}${autoHours}</div>
            </div>
          </td>`;
      }).join('');

      return `
        <tr>
          <td class="attendance-id-col">${_esc(row.captain.id)}</td>
          <td class="attendance-name-col">
            <div class="captain-cell">
              <div class="captain-avatar">${_initials(row.captain.name || row.captain.id)}</div>
              <button type="button"
                      class="attendance-captain-trigger"
                      data-emp-id="${_esc(row.captain.id)}"
                      data-captain-name="${_esc(row.captain.name || 'Unknown')}"
                      aria-haspopup="dialog"
                      aria-expanded="false"
                      aria-label="Show time summary for ${_esc(row.captain.name || row.captain.id)}">
                <div class="captain-name">${_esc(row.captain.name || 'Unknown')}</div>
                <div class="captain-id">${_esc(row.captain.id)}</div>
              </button>
            </div>
          </td>
          ${cellHtml}
          <td class="attendance-total-cell attendance-summary-col">${_fmt(row.workDays, 1)}</td>
          <td class="attendance-total-cell attendance-summary-col">${_fmt(row.weekOffs)}</td>
          <td class="attendance-total-cell attendance-type-col">${_attendanceTypeDaysLabel(row.bonus)}</td>
          <td class="attendance-total-cell attendance-summary-col">${_fmt(row.bonus?.allowed_offs ?? 0)}</td>
          <td class="attendance-total-cell attendance-bonus-col">${row.bonus?.bonus_amount > 0 ? '&#8377;' + _fmt(row.bonus.bonus_amount) : '&#8377;0'}</td>
          <td class="attendance-total-cell attendance-reason-col ${row.bonus?.eligible ? 'attendance-bonus-ok' : 'attendance-bonus-blocked'}">${_esc(row.bonus?.reason || '—')}</td>
        </tr>`;
    }).join('');

    const totalWorkDays = rows.reduce((sum, row) => sum + row.workDays, 0);
    const totalWeekOffs = rows.reduce((sum, row) => sum + row.weekOffs, 0);
    const totalFtDays = rows.reduce((sum, row) => sum + (row.bonus?.ft_days || 0), 0);
    const totalPtDays = rows.reduce((sum, row) => sum + (row.bonus?.pt_days || 0), 0);
    const totalAllowedOffs = rows.reduce((sum, row) => sum + (row.bonus?.allowed_offs || 0), 0);
    const totalAttendanceBonus = rows.reduce((sum, row) => sum + (row.bonus?.bonus_amount || 0), 0);
    const totalRow = dates.map(date => {
      const iso = _isoDateStr(date);
      let totalHours = 0;
      for (const [key, hrs] of hoursByKey.entries()) {
        if (key.endsWith(`_${iso}`)) totalHours += hrs;
      }
      return `<td class="attendance-total-cell">${_fmt(Math.round(totalHours) / 10, 1)}</td>`;
    }).join('');

    gridEl.innerHTML = `
      <div class="attendance-shell">
        <div class="table-wrapper attendance-table-wrapper">
          <table class="data-table attendance-table">
            <thead>
              <tr>
                ${_attendanceTh('employee_id', 'id', 'attendance-id-col')}
                ${_attendanceTh('Employee Name', 'name', 'attendance-name-col')}
                ${headDays}
                ${_attendanceTh('Work Days', 'workDays', 'attendance-summary-head')}
                ${_attendanceTh('Week Offs', 'weekOffs', 'attendance-summary-head')}
                ${_attendanceTh('FT / PT Days', 'typeDays', 'attendance-type-head')}
                ${_attendanceTh('Allowed Offs', 'allowedOffs', 'attendance-summary-head')}
                ${_attendanceTh('Att. Bonus', 'bonus', 'attendance-bonus-head')}
                ${_attendanceTh('Reason', 'reason', 'attendance-reason-head')}
              </tr>
            </thead>
            <tbody>${attendanceRows}</tbody>
            <tfoot>
              <tr>
                <td class="attendance-id-col"></td>
                <td class="attendance-name-col attendance-total-label">Total Staff</td>
                ${totalRow}
                <td class="attendance-total-cell attendance-summary-col">${_fmt(totalWorkDays, 1)}</td>
                <td class="attendance-total-cell attendance-summary-col">${_fmt(totalWeekOffs)}</td>
                <td class="attendance-total-cell attendance-type-col">FT ${_fmt(totalFtDays)} / PT ${_fmt(totalPtDays)}</td>
                <td class="attendance-total-cell attendance-summary-col">${_fmt(totalAllowedOffs)}</td>
                <td class="attendance-total-cell attendance-bonus-col">&#8377;${_fmt(totalAttendanceBonus)}</td>
                <td class="attendance-total-cell attendance-reason-col"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>`;

    _bindAttendanceCaptainTriggers(gridEl);
    _initTableFilters(gridEl.querySelector('.attendance-table'));
    _renderAttendanceSummary(summary, monthKey);
  }

  function onAttendanceOverrideChange(selectEl) {
    const empId = _cleanAttendanceId(selectEl.dataset.empId);
    const date = selectEl.dataset.date;
    if (!empId || !date) return;
    const key = _attendanceOverrideKey(empId, date);
    const overrides = _getAttendanceOverrides();
    if (selectEl.value) overrides[key] = selectEl.value;
    else delete overrides[key];
    localStorage.setItem(_ATTENDANCE_OVERRIDE_KEY, JSON.stringify(overrides));
    _incentiveCache = null;
    _incentiveCacheKey = null;
    renderAttendance();
  }

  function clearAttendanceOverrides() {
    _hideAttendanceTimePopover();
    const month = document.getElementById('attendance-month')?.value;
    if (!month) return;
    const overrides = _getAttendanceOverrides();
    const prefix = `${month}-`;
    let changed = false;
    for (const key of Object.keys(overrides)) {
      const datePart = key.split('_').pop();
      if (datePart && datePart.startsWith(prefix)) {
        delete overrides[key];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(_ATTENDANCE_OVERRIDE_KEY, JSON.stringify(overrides));
    _incentiveCache = null;
    _incentiveCacheKey = null;
    renderAttendance();
  }

  function sortAttendance(key) {
    _hideAttendanceTimePopover();
    if (_attendanceSort.key === key) {
      _attendanceSort.dir = _attendanceSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      _attendanceSort = { key, dir: key === 'name' || key === 'id' ? 'asc' : 'desc' };
    }
    renderAttendance();
  }

  function _latestAttendanceMonth() {
    const dates = sheets.getCached().map(r => r.date).filter(Boolean).sort((a, b) => b - a);
    const d = dates[0] || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function _attendanceMonthDates(year, month) {
    const last = new Date(year, month, 0).getDate();
    return Array.from({ length: last }, (_, i) => new Date(year, month - 1, i + 1));
  }

  function _attendanceCaptains(rosterRows) {
    const captains = new Map();
    for (const r of rosterRows || []) {
      const id = _cleanAttendanceId(r.employee_id);
      if (!id || captains.has(id)) continue;
      captains.set(id, { id, name: r.employee_name || '' });
    }
    return [...captains.values()];
  }

  function _attendanceRosterByCaptain(rosterRows) {
    const out = new Map();
    for (const r of rosterRows || []) {
      const id = _cleanAttendanceId(r.employee_id);
      if (!id) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(r);
    }
    return out;
  }

  function _attendanceHoursByKey(data) {
    const out = new Map();
    for (const row of data || []) {
      const id = _cleanAttendanceId(row.employee_id);
      const iso = row.dateIsoStr || _isoDateStr(row.date);
      const hrs = (row.total_active_time || 0) / 3600;
      if (!id || !iso || isNaN(hrs) || hrs <= 0) continue;
      const key = _attendanceOverrideKey(id, iso);
      out.set(key, (out.get(key) || 0) + hrs);
    }
    return out;
  }

  function _attendanceActiveCaptainIds(dates, rosterByCaptain) {
    const ids = new Set();
    for (const date of dates) {
      for (const id of rosterByCaptain.keys()) {
        if (_isRosterActiveOnDate(rosterByCaptain.get(id) || [], date)) ids.add(id);
      }
    }
    return ids;
  }

  function _attendanceMonthTotalHours(dates, hoursByKey) {
    const dateSet = new Set(dates.map(_isoDateStr));
    let total = 0;
    for (const [key, hrs] of hoursByKey.entries()) {
      const iso = key.split('_').pop();
      if (dateSet.has(iso)) total += hrs;
    }
    return total;
  }

  function _computeAttendanceStatus(empId, date, hoursByKey, rosterByCaptain) {
    const id = _cleanAttendanceId(empId);
    if (!_isRosterActiveOnDate(rosterByCaptain.get(id) || [], date)) return { status: 'N/A', rawHours: 0 };
    const rawHours = hoursByKey.get(_attendanceOverrideKey(id, _isoDateStr(date))) || 0;
    if (!rawHours) return { status: 'Off', rawHours: 0 };
    const adjusted = rawHours >= 5 ? rawHours + 1 : rawHours + 0.5;
    const rounded = Math.round(adjusted);
    if (rounded >= 9 && rounded <= 11) return { status: 'Full-day', rawHours };
    if (rounded >= 4 && rounded <= 6) return { status: 'Half-day', rawHours };
    return { status: `${rounded} hrs`, rawHours };
  }

  function _isRosterActiveOnDate(rows, date) {
    const target = _dateOnly(date).getTime();
    return rows.some(r => {
      const start = _rosterDate(r.start);
      if (!start || _dateOnly(start).getTime() > target) return false;
      const end = _rosterDate(r.end);
      return !end || _dateOnly(end).getTime() >= target;
    });
  }

  function _rosterDate(value) {
    if (value === undefined || value === null || value === '') return null;
    const str = String(value).trim();
    const n = parseFloat(str);
    if (/^-?\d+(\.\d+)?$/.test(str) && !isNaN(n) && n > 1000) {
      return new Date(Math.round((n - 25569) * 86400000));
    }
    const d = new Date(str);
    return isNaN(d) ? null : d;
  }

  function _dateOnly(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function _cleanAttendanceId(value) {
    return String(value || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '').toUpperCase();
  }

  function _attendanceOverrideKey(empId, isoDate) {
    return `${_cleanAttendanceId(empId)}_${isoDate}`;
  }

  function _getAttendanceOverrides() {
    try {
      return JSON.parse(localStorage.getItem(_ATTENDANCE_OVERRIDE_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function _attendanceOverrideSignature(monthKey, overrides = _getAttendanceOverrides()) {
    const prefix = `${monthKey}-`;
    return Object.keys(overrides || {})
      .filter(key => {
        const datePart = key.split('_').pop();
        return datePart && datePart.startsWith(prefix);
      })
      .sort()
      .map(key => `${key}:${overrides[key]}`)
      .join('|');
  }

  function _addAttendanceSummary(summary, status) {
    if (status === 'N/A') {
      summary.na++;
      return;
    }
    if (status === 'Full-day') summary.full++;
    else if (status === 'Half-day') summary.half++;
    else if (status === 'Off') summary.off++;
    if (status !== 'Off') summary.active++;
  }

  function _attendanceWorkDayValue(status) {
    if (status === 'Full-day') return 1;
    if (status === 'Half-day') return 0.5;
    const m = String(status || '').match(/^(\d+)\s*hrs?$/i);
    if (!m) return 0;
    const hrs = parseInt(m[1], 10);
    if (hrs >= 7) return 1;
    if (hrs > 0) return 0.5;
    return 0;
  }

  function _attendanceStatusRank(status) {
    if (status === 'N/A') return 0;
    if (status === 'Off') return 1;
    if (status === 'Unplanned Leave') return 2;
    if (status === 'Half-day') return 3;
    const m = String(status || '').match(/^(\d+)\s*hrs?$/i);
    if (m) return 4 + (parseInt(m[1], 10) / 100);
    if (status === 'Full-day') return 6;
    return 0;
  }

  function _attendanceRowSorter(a, b) {
    const dir = _attendanceSort.dir === 'asc' ? 1 : -1;
    const key = _attendanceSort.key;
    const av = _attendanceSortValue(a, key);
    const bv = _attendanceSortValue(b, key);
    if (typeof av === 'number' && typeof bv === 'number') {
      return (av - bv || a.captain.name.localeCompare(b.captain.name)) * dir;
    }
    return (String(av).localeCompare(String(bv)) || a.captain.id.localeCompare(b.captain.id)) * dir;
  }

  function _attendanceSortValue(row, key) {
    if (key === 'id') return row.captain.id;
    if (key === 'name') return row.captain.name || row.captain.id;
    if (key === 'workDays') return row.workDays;
    if (key === 'weekOffs') return row.weekOffs;
    if (key === 'typeDays') return (row.bonus?.ft_days || 0) + (row.bonus?.pt_days || 0);
    if (key === 'allowedOffs') return row.bonus?.allowed_offs || 0;
    if (key === 'bonus') return row.bonus?.bonus_amount || 0;
    if (key === 'reason') return row.bonus?.reason || '';
    if (key.startsWith('date:')) {
      const iso = key.slice(5);
      const cell = row.cells.find(c => c.iso === iso);
      return cell ? _attendanceStatusRank(cell.value) : 0;
    }
    return '';
  }

  function _bindAttendanceCaptainTriggers(root) {
    root.querySelectorAll('.attendance-captain-trigger').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        _showAttendanceTimePopover(btn, {
          id: btn.dataset.empId || '',
          name: btn.dataset.captainName || '',
        });
      });
    });
  }

  function _showAttendanceTimePopover(anchor, captain) {
    const empId = _cleanAttendanceId(captain.id);
    if (!empId) return;
    _hideAttendanceTimePopover();

    anchor.setAttribute('aria-expanded', 'true');
    const monthKey = document.getElementById('attendance-month')?.value || _latestAttendanceMonth();
    const rows = _attendanceCaptainTimeRows(empId, monthKey);
    const totalSeconds = rows.find(r => r.key === 'total_active_time')?.seconds || 0;
    const pop = document.createElement('div');
    pop.id = 'attendance-time-popover';
    pop.className = 'attendance-time-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `${captain.name || empId} active time summary`);
    pop.innerHTML = `
      <div class="attendance-time-header">
        <div>
          <div class="attendance-time-title">${_esc(captain.name || 'Unknown')}</div>
          <div class="attendance-time-sub">${_esc(empId)} · ${_esc(_attendanceMonthLabel(monthKey))}</div>
        </div>
        <div class="attendance-time-total">${_fmt(totalSeconds / 3600, 1)} h</div>
      </div>
      <div class="attendance-time-rows">
        ${rows.map(row => {
          const pctText = row.percent === null ? '—' : `${_fmt(row.percent, 1)}%`;
          const width = row.percent === null ? '0' : String(Math.min(100, Math.max(0, row.percent)).toFixed(1));
          return `
            <div class="attendance-time-row ${row.key === 'total_active_time' ? 'is-total' : ''}">
              <div class="attendance-time-label">${_esc(row.label)}</div>
              <div class="attendance-time-hours">${_fmt(row.seconds / 3600, 1)} h</div>
              <div class="attendance-time-percent">${pctText}</div>
              <div class="attendance-time-bar" aria-hidden="true"><span style="width:${width}%"></span></div>
            </div>`;
        }).join('')}
      </div>`;
    document.body.appendChild(pop);

    _positionAttendanceTimePopover(anchor, pop);

    _attendancePopoverDismiss = ev => {
      if (!pop.contains(ev.target) && ev.target !== anchor) _hideAttendanceTimePopover();
    };
    _attendancePopoverEscape = ev => {
      if (ev.key === 'Escape') _hideAttendanceTimePopover();
    };
    setTimeout(() => {
      document.addEventListener('click', _attendancePopoverDismiss, true);
      document.addEventListener('keydown', _attendancePopoverEscape, true);
    }, 0);
  }

  function _positionAttendanceTimePopover(anchor, pop) {
    const rect = anchor.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const popW = Math.min(340, window.innerWidth - 16);
    let left = rect.left + scrollX;
    if (left + popW > window.innerWidth + scrollX - 8) left = window.innerWidth + scrollX - popW - 8;
    if (left < scrollX + 8) left = scrollX + 8;

    pop.style.width = popW + 'px';
    pop.style.left = left + 'px';
    pop.style.top = (rect.bottom + scrollY + 8) + 'px';

    const popRect = pop.getBoundingClientRect();
    if (rect.bottom + popRect.height > window.innerHeight - 8 && rect.top > popRect.height + 8) {
      pop.style.top = (rect.top + scrollY - popRect.height - 8) + 'px';
    }
  }

  function _hideAttendanceTimePopover() {
    document.querySelectorAll('.attendance-captain-trigger[aria-expanded="true"]').forEach(btn => {
      btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('attendance-time-popover')?.remove();
    if (_attendancePopoverDismiss) {
      document.removeEventListener('click', _attendancePopoverDismiss, true);
      _attendancePopoverDismiss = null;
    }
    if (_attendancePopoverEscape) {
      document.removeEventListener('keydown', _attendancePopoverEscape, true);
      _attendancePopoverEscape = null;
    }
  }

  function _attendanceCaptainTimeRows(empId, monthKey) {
    const totals = Object.fromEntries(_ATTENDANCE_TIME_FIELDS.map(f => [f.key, 0]));
    const monthPrefix = `${monthKey}-`;
    for (const row of sheets.getCached() || []) {
      if (_cleanAttendanceId(row.employee_id) !== empId) continue;
      const iso = row.dateIsoStr || _isoDateStr(row.date);
      if (!iso || !iso.startsWith(monthPrefix)) continue;
      for (const field of _ATTENDANCE_TIME_FIELDS) {
        totals[field.key] += row[field.key] || 0;
      }
    }
    const totalSeconds = totals.total_active_time || 0;
    return _ATTENDANCE_TIME_FIELDS.map(field => {
      const seconds = totals[field.key] || 0;
      return {
        key: field.key,
        label: field.label,
        seconds,
        percent: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : null,
      };
    });
  }

  function _attendanceTypeDaysLabel(bonus) {
    if (!bonus) return '—';
    const missing = bonus.missing_type_days ? ` / Missing ${_fmt(bonus.missing_type_days)}` : '';
    return `FT ${_fmt(bonus.ft_days)} / PT ${_fmt(bonus.pt_days)}${missing}`;
  }

  function _attendanceTh(labelHtml, key, cls = '') {
    const active = _attendanceSort.key === key;
    const icon = active ? (_attendanceSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${cls} attendance-sortable" onclick="ui.sortAttendance('${_esc(key)}')">${labelHtml}<span class="attendance-sort-icon">${icon}</span></th>`;
  }

  function _renderAttendanceSummary(summary, monthKey) {
    const el = document.getElementById('attendance-summary-cards');
    if (!el) return;
    const staff = Math.round(summary.totalStaff) / 10;
    el.innerHTML = `
      <div class="flags-metric-card accent-blue">
        <div class="flags-metric-label">Active Marks</div>
        <div class="flags-metric-row"><span class="flags-metric-value small color-blue">${_fmt(summary.active)}</span></div>
        <div class="flags-metric-sub">${_esc(_attendanceMonthLabel(monthKey))}</div>
      </div>
      <div class="flags-metric-card accent-green">
        <div class="flags-metric-label">Full-day</div>
        <div class="flags-metric-row"><span class="flags-metric-value small color-teal">${_fmt(summary.full)}</span></div>
        <div class="flags-metric-sub">Computed and manual values</div>
      </div>
      <div class="flags-metric-card accent-amber">
        <div class="flags-metric-label">Half-day</div>
        <div class="flags-metric-row"><span class="flags-metric-value small color-amber">${_fmt(summary.half)}</span></div>
        <div class="flags-metric-sub">4-6 rounded hours</div>
      </div>
      <div class="flags-metric-card accent-red">
        <div class="flags-metric-label">Off</div>
        <div class="flags-metric-row"><span class="flags-metric-value small color-red">${_fmt(summary.off)}</span></div>
        <div class="flags-metric-sub">Roster-active with no hours</div>
      </div>
      <div class="flags-metric-card">
        <div class="flags-metric-label">N/A</div>
        <div class="flags-metric-row"><span class="flags-metric-value small">${_fmt(summary.na)}</span></div>
        <div class="flags-metric-sub">Outside roster period</div>
      </div>
      <div class="flags-metric-card accent-blue">
        <div class="flags-metric-label">Total Staff</div>
        <div class="flags-metric-row"><span class="flags-metric-value small color-blue">${_fmt(staff, 1)}</span></div>
        <div class="flags-metric-sub">Total active hours divided by 10</div>
      </div>`;
  }

  function _attendanceMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function _attendanceStatusClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'full-day') return 'full';
    if (s === 'half-day') return 'half';
    if (s === 'off') return 'off';
    if (s === 'n/a') return 'na';
    if (s === 'unplanned leave') return 'leave';
    if (s.includes('hrs')) return 'hours';
    return 'other';
  }

  // ── Tier Analysis ──────────────────────────────────────────────────────

  let _tierDateMode = false;
  let _tierMode = 'time'; // 'time' | 'experience'
  let _tierGroupRows = {}; // snapshot for popover access

  function initTiersView() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateBillingMonthly(data);
    const sel = document.getElementById('tiers-period');
    if (!sel) return;

    sel.innerHTML = [
      '<option value="t1">T-1 (Yesterday)</option>',
      '<option value="t2">T-2 (Day before yesterday)</option>',
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${_billingMonthLabel(d.month_key)}</option>`),
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
    if (periodType === 'W') {
      const rows = data.filter(row => {
        if (!row.date) return false;
        const wk = compute.aggregateWeekly([row]);
        return wk.length > 0 && wk[0].week_key === periodKey;
      });
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort((a, b) => a - b);
        document.getElementById('tiers-start').value = _isoDateStr(dates[0]);
        document.getElementById('tiers-end').value   = _isoDateStr(dates[dates.length - 1]);
      }
    } else {
      _applyBillingMonthDates('tiers-start', 'tiers-end', periodKey);
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
      totalActiveTime:       sum(rows, 'total_active_time') / 3600,
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
    const totalPickActHrs = pickActVals.reduce((a, v) => a + (v || 0), 0);

    const pickTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0;
      const h   = hst(g.key);
      const pct = totalOrders > 0 && ordersVals[i]
        ? `<span class="tiers-pct">${((ordersVals[i]/totalOrders)*100).toFixed(1)}%</span>` : '';
      const histPct = totalHistOrders > 0 && histOrdersVals[i]
        ? `${((histOrdersVals[i]/totalHistOrders)*100).toFixed(1)}%` : null;
      const pickActHrs = pickActVals[i];
      const pickActPct = totalPickActHrs > 0 && pickActHrs > 0
        ? `<span class="tiers-pct">${((pickActHrs / totalPickActHrs) * 100).toFixed(1)}%</span>` : '';
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsOrders[i]}">${has ? `${_fmt(ordersVals[i], 0)} ${pct}` : '—'}${histSub(histPct, histPct)}</td>
          <td class="${clsPPI[i]}">${fmtDur(ppiVals[i])}${histSub(h?.weightedAvgPPI ?? null, fmtDur(h?.weightedAvgPPI ?? null))}</td>
          <td class="${clsDelay[i]}">${fmtDur(delayVals[i])}${histSub(h?.avgDelayToStart ?? null, fmtDur(h?.avgDelayToStart ?? null))}</td>
          <td class="${clsPick[i]}">${fmtDur(pickVals[i])}${histSub(h?.avgPickTime ?? null, fmtDur(h?.avgPickTime ?? null))}</td>
          <td class="${clsBill[i]}">${fmtDur(billVals[i])}${histSub(h?.avgBillingTime ?? null, fmtDur(h?.avgBillingTime ?? null))}</td>
          <td class="${clsTotal[i]}">${fmtDur(totalVals[i])}${histSub(h?.avgTotalTime ?? null, fmtDur(h?.avgTotalTime ?? null))}</td>
          <td>${has && pickActHrs > 0 ? `${fmtNum(pickActHrs)} hrs ${pickActPct}` : '—'}</td>
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
    const totalPutQty    = putQtyVals.reduce((a, v) => a + (v || 0), 0);
    const totalPutHrsAll = putHrVals.reduce((a, v) => a + (v || 0), 0);
    const clsPutQty   = colorCode(putQtyVals, 'LOW');
    const clsIPH      = colorCode(iphVals,    'LOW');

    const putTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0 && putQtyVals[i] > 0;
      const h   = hst(g.key);
      const pct = totalPutQty > 0 && putQtyVals[i]
        ? `<span class="tiers-pct">${((putQtyVals[i]/totalPutQty)*100).toFixed(1)}%</span>` : '';
      const putHrPct = totalPutHrsAll > 0 && putHrVals[i] > 0
        ? `<span class="tiers-pct">${((putHrVals[i] / totalPutHrsAll) * 100).toFixed(1)}%</span>` : '';
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsPutQty[i]}">${has ? `${_fmt(putQtyVals[i], 0)} ${pct}` : '—'}</td>
          <td class="${clsIPH[i]}">${fmtNum(iphVals[i])}${histSub(h?.iph ?? null, fmtNum(h?.iph ?? null))}</td>
          <td>${has && putHrVals[i] > 0 ? `${fmtNum(putHrVals[i])} hrs ${putHrPct}` : '—'}</td>
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
    const rackVals       = groupDefs.map(g => st(g.key).totalRacks);
    const hprVals        = groupDefs.map(g => st(g.key).hpr);
    const auditHrVals    = groupDefs.map(g => st(g.key).totalAuditHours);
    const totalAuditHrsAll = auditHrVals.reduce((a, v) => a + (v || 0), 0);
    const clsRacks    = colorCode(rackVals, 'LOW');
    const clsHPR      = colorCode(hprVals,  'HIGH');

    const auditTableRows = groupDefs.map((g, i) => {
      const has = st(g.key).captainCount > 0 && rackVals[i] > 0;
      const h   = hst(g.key);
      const auHrPct = totalAuditHrsAll > 0 && auditHrVals[i] > 0
        ? `<span class="tiers-pct">${((auditHrVals[i] / totalAuditHrsAll) * 100).toFixed(1)}%</span>` : '';
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsRacks[i]}">${has ? _fmt(rackVals[i], 0) : '—'}</td>
          <td class="${clsHPR[i]}">${fmtNum(hprVals[i], 2)}${histSub(h?.hpr ?? null, fmtNum(h?.hpr ?? null, 2))}</td>
          <td>${has && auditHrVals[i] > 0 ? `${fmtNum(auditHrVals[i])} hrs ${auHrPct}` : '—'}</td>
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

    // ── 5. Total Active Time ──────────────────────────────────────────
    const actVals     = groupDefs.map(g => st(g.key).totalActiveTime);
    const totalActHrs = actVals.reduce((a, v) => a + (v || 0), 0);
    const clsAct      = colorCode(actVals, 'LOW');

    const actTableRows = groupDefs.map((g, i) => {
      const has = actVals[i] > 0;
      const pct = totalActHrs > 0 && actVals[i]
        ? `<span class="tiers-pct">${((actVals[i] / totalActHrs) * 100).toFixed(1)}%</span>` : '';
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${g.color}">${g.label}</td>
          <td class="${clsAct[i]}">${has ? `${fmtNum(actVals[i])} hrs ${pct}` : '—'}</td>
        </tr>`;
    }).join('');

    const actSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#f59e0b"></div>
          <h3 class="tiers-section-title">Total Active Time</h3>
        </div>
        <div class="table-wrapper" style="border-radius:12px;">
          <table class="tiers-table">
            <thead><tr>
              <th>${groupLabel}</th>
              <th>Total Active Time</th>
            </tr></thead>
            <tbody>${actTableRows}</tbody>
          </table>
        </div>
      </div>`;

    return `${bentoGrid}${pickSection}${putSection}${auditSection}${actSection}`;
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
    const monthly = compute.aggregateBillingMonthly(data);

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
      if (periodType === 'W') {
        const rows = data.filter(row => row.date && compute.aggregateWeekly([row]).some(w => w.week_key === periodKey));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('profile-start').value = _isoDateStr(dates[0]);
          document.getElementById('profile-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('profile-start', 'profile-end', periodKey);
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
        const buckets = compute.aggregateBillingMonthly(rows, captainAudit);
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

  // ── SLA Targets config helpers ────────────────────────────────────
  function _slaTargetRow(label, metric, tiers, arrow) {
    const step = metric === 'complaints' ? '0.01' : '0.1';
    const cell = tier => `<td><input class="slab-threshold-input" id="sla-${metric}-${tier}" type="number" min="0" max="100" step="${step}" value="${tiers[tier]}" /></td>`;
    return `<tr>
      <td style="font-weight:600">${label} <span style="color:var(--text-muted)">${arrow}</span></td>
      ${cell('baseline')}${cell('sla1')}${cell('sla2')}
    </tr>`;
  }

  function loadSlaTargetCycle() {
    const cycle = document.getElementById('sla-target-cycle')?.value;
    if (!cycle) return;
    const t = _getSlaTargets(cycle);
    for (const m of _KM_METRICS) for (const tier of _KM_TIERS) {
      const el = document.getElementById(`sla-${m}-${tier}`);
      if (el) el.value = t[m][tier];
    }
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const note = document.getElementById('sla-target-note');
    if (note) note.textContent = all[cycle] ? 'Custom targets set for this cycle' : 'Using default targets';
  }

  function updateSlaTarget() {
    const cycle = document.getElementById('sla-target-cycle')?.value;
    if (!cycle) return;
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const obj = {};
    for (const m of _KM_METRICS) {
      obj[m] = {};
      for (const tier of _KM_TIERS) {
        const v = parseFloat(document.getElementById(`sla-${m}-${tier}`)?.value);
        obj[m][tier] = isNaN(v) ? undefined : v;
      }
    }
    all[cycle] = obj;
    localStorage.setItem('slaTargets', JSON.stringify(all));
    const note = document.getElementById('sla-target-note');
    if (note) note.textContent = 'Custom targets set for this cycle';
    const msg = document.getElementById('sla-target-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
  }

  function toggleComplaintSlaCategory() {
    const boxes = document.querySelectorAll('.km-cat-checklist input[type="checkbox"]');
    const checked = [...boxes].filter(b => b.checked).map(b => b.dataset.cat);
    localStorage.setItem('complaintSlaCategories', JSON.stringify(checked));
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

    // ── SLA Targets card data ──
    const _slaDaily = sheets.getCached();
    const slaCycleList = (_slaDaily && _slaDaily.length)
      ? compute.aggregateBillingMonthly(_slaDaily.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id }))).map(d => d.month_key)
      : [];
    const slaTargetCycle = (_kmCycleKey && slaCycleList.includes(_kmCycleKey))
      ? _kmCycleKey
      : (slaCycleList[slaCycleList.length - 1] || curMonth);
    const slaT = _getSlaTargets(slaTargetCycle);
    const slaCycleOptions = (slaCycleList.length ? slaCycleList : [curMonth]).slice().reverse()
      .map(k => `<option value="${k}"${k === slaTargetCycle ? ' selected' : ''}>${_billingMonthLabel(k)}</option>`).join('');
    const complCats = [...new Set((sheets.getComplaintsCached() || []).map(r => r.complaint_category).filter(Boolean))].sort();
    const _savedCatSet = _getComplaintSlaCategorySet();
    const catChecks = complCats.map(cat => {
      const checked = _savedCatSet ? _savedCatSet.has(cat.toLowerCase()) : !_KM_EXCLUDE_RE.test(cat.toLowerCase());
      return `<label class="km-cat-check"><input type="checkbox" data-cat="${_esc(cat)}" ${checked ? 'checked' : ''} onchange="ui.toggleComplaintSlaCategory()"> ${_esc(cat)}</label>`;
    }).join('');

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
          <span class="config-detail-value">Daily Metrics (A:V) · Audits · Complaints · Roster · PNAs · In-store Time (separate book)</span>
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
          <div class="config-card-icon stat-icon-blue">${ICONS.barChart}</div>
          <h3>SLA Targets (Key Metrics)</h3>
        </div>
        <p class="config-desc">Three-tiered per-cycle targets (Baseline / SLA 1 / SLA 2) shown on the Key Metrics tab. In-store &amp; fill-rate are "higher is better"; complaints is "lower is better".</p>
        <div class="config-month-row">
          <span class="dd-control-label">Cycle</span>
          <select id="sla-target-cycle" onchange="ui.loadSlaTargetCycle()">${slaCycleOptions}</select>
          <span id="sla-target-note" class="config-hint" style="margin-left:8px"></span>
        </div>
        <table class="slab-editor-table sla-target-table" style="margin-top:14px">
          <thead><tr><th>Metric</th><th>Baseline (%)</th><th>SLA 1 (%)</th><th>SLA 2 (%)</th></tr></thead>
          <tbody>
            ${_slaTargetRow('In-Store Time', 'instore', slaT.instore, '↑')}
            ${_slaTargetRow('Complaints', 'complaints', slaT.complaints, '↓')}
            ${_slaTargetRow('Fill Rate', 'fillrate', slaT.fillrate, '↑')}
          </tbody>
        </table>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.updateSlaTarget()">Save Targets</button>
          <span id="sla-target-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <div style="margin-top:18px">
          <span class="dd-control-label">Qualifying Complaint Categories</span>
          <p class="config-hint" style="margin:4px 0 8px">Checked categories count toward the Complaints SLA. MDND, Poor-Quality and QNG are excluded by default.</p>
          <div class="km-cat-checklist">
            ${complCats.length ? catChecks : '<span class="config-hint">No complaint categories loaded yet.</span>'}
          </div>
        </div>
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
        <p class="config-hint" style="margin-top:6px">Defaults — Picking/Audit: 0.5 · 0.25 · 0.1 &nbsp;|&nbsp; Putting: 0.25 · 0.1 · 0.01 &nbsp;|&nbsp; FNV: 2.0 · 1.0 · 0.5</p>
      </div>

      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-teal">${ICONS.barChart}</div>
          <h3>Productivity Weights</h3>
        </div>
        <p class="config-hint" style="margin-bottom:12px">Each activity is converted to <strong>item-equivalents</strong> using these multipliers, then summed to compute the Productivity and IPH charts.<br><br><code>Productivity = (Orders × W<sub>order</sub>) + (Putaway Items × W<sub>putaway</sub>) + (Racks Audited × W<sub>rack</sub>)</code></p>
        <div class="config-row" style="align-items:flex-end;gap:24px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Order Weight (W<sub>order</sub>)</span>
            <input type="number" id="pw-order" min="0.1" step="0.5"
                   value="${_getProductivityWeights().order}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per order picked. Default: ${_PW_DEFAULTS.order}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Putaway Weight (W<sub>putaway</sub>)</span>
            <input type="number" id="pw-putaway" min="0.1" step="0.1"
                   value="${_getProductivityWeights().putaway}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per putaway item. Default: ${_PW_DEFAULTS.putaway}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Rack Weight (W<sub>rack</sub>)</span>
            <input type="number" id="pw-rack" min="1" step="5"
                   value="${_getProductivityWeights().rack}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per rack audited. Default: ${_PW_DEFAULTS.rack}</span>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.updateProductivityWeights()">Save</button>
          <button class="btn" onclick="ui.resetProductivityWeights()">Reset to Default</button>
          <span id="pw-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
      </div>

      <div class="config-card">
        <h3 class="config-card-title">Staff Availability</h3>
        <p class="config-hint" style="margin-bottom:12px">Controls the divisor in the formula: <strong>Active Hours − (Orders ÷ X)</strong>. Adjust X to reflect how many orders one captain-hour of capacity should handle.</p>
        <div class="config-row" style="align-items:flex-end;gap:16px">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Orders per Captain-Hour (X)</span>
            <input type="number" id="staff-avail-divisor-input" min="0.1" step="0.1"
                   value="${_getStaffAvailDivisor()}" style="width:100px"
                   onchange="ui.updateStaffAvailDivisor(this.value)" />
            <span class="config-hint" style="margin-top:2px">Default: ${_STAFF_AVAIL_DEFAULT_DIVISOR}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn" onclick="ui.resetStaffAvailDivisor()">Reset to Default</button>
            <span id="staff-avail-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
          </div>
        </div>
      </div>
    `;
    container.querySelectorAll('.config-table').forEach(t => _initTableSort(t));
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

  // Converts "YYYY-MM" month key to billing-cycle label: "Mar 26 – Apr 25, 2026"
  // Billing cycle: 26th of previous month → 25th of named month
  function _billingMonthLabel(monthKey) {
    const [y, mo] = monthKey.split('-').map(Number);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startDate = new Date(y, mo - 2, 26); // JS handles mo-2 < 0 → wraps to Dec of y-1
    const endDate   = new Date(y, mo - 1, 25);
    return `${MONTHS[startDate.getMonth()]} 26 \u2013 ${MONTHS[endDate.getMonth()]} 25, ${endDate.getFullYear()}`;
  }

  // Given a billing-cycle month key "YYYY-MM", set start/end date picker values
  function _applyBillingMonthDates(startElId, endElId, monthKey) {
    const [y, mo] = monthKey.split('-').map(Number);
    document.getElementById(startElId).value = _isoDateStr(new Date(y, mo - 2, 26));
    document.getElementById(endElId).value   = _isoDateStr(new Date(y, mo - 1, 25));
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
    const monthly = compute.aggregateBillingMonthly(auditData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

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
      if (periodType === 'W') {
        const rows = auditData.filter(row => row.date && compute.aggregateWeekly([{ date: row.date, dateStr: row.dateStr, employee_id: row.employee_id }]).some(w => w.week_key === periodKey));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('inv-start').value = _isoDateStr(dates[0]);
          document.getElementById('inv-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('inv-start', 'inv-end', periodKey);
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

  function _getSlaTargets(cycleKey) {
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const stored = all[cycleKey] || {};
    const out = {};
    for (const m of _KM_METRICS) {
      const sm = stored[m] || {};
      out[m] = {};
      for (const tier of _KM_TIERS) {
        out[m][tier] = sm[tier] != null ? sm[tier] : _KM_TARGET_DEFAULTS[m][tier];
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
  // Set when the user has saved a selection, else null (apply default rule).
  function _getComplaintSlaCategorySet() {
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
      const d = new Date();
      d.setDate(d.getDate() - (periodVal === 't1' ? 1 : 2));
      const ds = _isoDateStr(d);
      document.getElementById('km-start').value = ds;
      document.getElementById('km-end').value   = ds;
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
  function _kmPaceSection(startVal, endVal, inst, comp, targets) {
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

    if (!instCol && !complCol) return '';
    return `
      <div class="km-card km-pace-card">
        <h4 class="km-block-title">Cycle Pace — day ${elapsed} of ${totalDays} · ${left} day${left === 1 ? '' : 's'} left
          <span class="km-target-line">assumes remaining days carry the window's average volume</span></h4>
        <div class="km-pace-grid">${instCol}${complCol}</div>
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
          ${_kmHourStat(h.totalOrders, 'orders')}
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

  // ── Complaints Deep Dive ──────────────────────────────────────────

  let _complCache = null;
  let _complCacheKey = null;
  let _complIncludeQNG = true;
  let _complDateMode = false;
  let _complCatMode = 'total';
  let _complCatPeriodData = null;
  let _complDetailRows = [];
  let _complDetailCaptains = new Map();
  let _complPickerNames = new Map();
  let _complDetailPeriod = { start: '', end: '' };
  let _complDetailEscHandler = null;
  let _complCaptainRows = [];
  let _complCaptainCategory = 'all';

  function initComplaintsDeepDive() {
    const complData = sheets.getComplaintsCached();
    const sel = document.getElementById('compl-preset');
    if (!sel || !complData || complData.length === 0) return;

    const weekly  = compute.aggregateWeekly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));
    const monthly = compute.aggregateBillingMonthly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

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
      if (periodType === 'W') {
        const rows = complData.filter(row => row.date && compute.aggregateWeekly([{ date: row.date, dateStr: row.dateStr, employee_id: row.employee_id }]).some(w => w.week_key === periodKey));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('compl-start').value = _isoDateStr(dates[0]);
          document.getElementById('compl-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('compl-start', 'compl-end', periodKey);
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

  function onComplCaptainCategoryChange(category) {
    _complCaptainCategory = category || 'all';
    _renderCaptainComplaintTable(_complCaptainRows);
  }

  function renderComplaintsDeepDive() {
    const container = document.getElementById('compl-content');
    if (!container) return;
    _closeComplaintDetail();

    const complData = _supervisorFilter(sheets.getComplaintsCached() || []);
    const dailyData = _supervisorFilter(sheets.getCached());
    _complPickerNames = new Map();
    dailyData.forEach(row => {
      if (row.employee_id && row.employee_name && !_complPickerNames.has(row.employee_id)) {
        _complPickerNames.set(row.employee_id, row.employee_name);
      }
    });

    if (!complData || complData.length === 0) {
      _complDetailRows = [];
      _complCaptainRows = [];
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
    _complDetailRows = filteredCompl;
    _complDetailPeriod = { start: startVal || '', end: endVal || '' };

    if (filteredCompl.length === 0) {
      _complDetailRows = [];
      _complCaptainRows = [];
      container.innerHTML = '<p class="placeholder-text">No complaints data for the selected period.</p>';
      return;
    }

    // Compute (or use cache)
    const cacheKey = `${startVal}_${endVal}_${complData.length}_${filteredDaily.length}_qng${_complIncludeQNG ? 1 : 0}`;
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
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Trend</h3>
                <p class="bento-card-subtitle">Total complaints vs in-store fault rate</p>
              </div>
            </div>
            <canvas id="chart-compl-trend"></canvas>
          </div>
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">RCA Breakdown</h3>
                <p class="bento-card-subtitle">% of total orders · stacked by root cause</p>
              </div>
            </div>
            <canvas id="chart-compl-rca"></canvas>
          </div>
        </div>
      </div>

      <!-- Zone 2: Category Intelligence -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#fb923c;"></span>
          <h3 class="tiers-section-title">Category Intelligence</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-full">
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
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">L0 Category Table</h3>
                <p class="bento-card-subtitle">Category-level complaints, products, and RCA</p>
              </div>
            </div>
            <div id="compl-category-table-container"></div>
          </div>
        </div>
      </div>

      <!-- Zone 3: Captain Performance -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#ff6b6b;"></span>
          <h3 class="tiers-section-title">Captain Complaint Performance</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Orders Picked vs In-Store Complaints</h3>
                <p class="bento-card-subtitle">Each dot is a captain — size = complaint rate</p>
              </div>
            </div>
            <canvas id="chart-compl-scatter"></canvas>
          </div>
        </div>
        <div id="compl-captain-table-container" style="margin-top:16px;"></div>
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
    charts.renderRCADonutChart('chart-compl-rca', periodData);
    charts.renderComplaintCategoryChart('chart-compl-category', periodData, _complCatMode);

    // Render captain scatter
    const captainArr = [...agg.captainPerf.values()].sort((a, b) => b.inStoreYes - a.inStoreYes);
    _complCaptainRows = captainArr;
    _complDetailCaptains = new Map(captainArr.map(c => [c.employee_id || '', c]));
    charts.renderCaptainComplaintScatter('chart-compl-scatter', captainArr);

    // Render captain table
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

  function _complCaptainCategoryOptions(captains) {
    const totals = new Map();
    captains.forEach(c => {
      Object.entries(c.byCategory || {}).forEach(([category, count]) => {
        const key = category || 'unknown';
        totals.set(key, (totals.get(key) || 0) + (Number(count) || 0));
      });
    });

    return [...totals.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([category, count]) => ({ category, count }));
  }

  function _renderCaptainComplaintTable(captains) {
    const container = document.getElementById('compl-captain-table-container');
    if (!container) return;

    const categoryOptions = _complCaptainCategoryOptions(captains);
    const activeExists = _complCaptainCategory === 'all' || categoryOptions.some(opt => opt.category === _complCaptainCategory);
    if (!activeExists) _complCaptainCategory = 'all';

    const activeCategory = _complCaptainCategory;
    const filteredCaptains = activeCategory === 'all'
      ? captains
      : captains.filter(c => ((c.byCategory || {})[activeCategory] || 0) > 0);
    const totalCategoryComplaints = categoryOptions.reduce((sum, opt) => sum + opt.count, 0);

    const categoryButtons = [
      `<button type="button" class="compl-category-filter-btn${activeCategory === 'all' ? ' active' : ''}" data-compl-captain-cat="all">All<span>${_fmt(totalCategoryComplaints)}</span></button>`,
      ...categoryOptions.map(opt => `
        <button type="button" class="compl-category-filter-btn${activeCategory === opt.category ? ' active' : ''}" data-compl-captain-cat="${_esc(opt.category)}">
          ${_esc(opt.category)}<span>${_fmt(opt.count)}</span>
        </button>`),
    ].join('');

    const rows = filteredCaptains.map(c => {
      const rateClass    = c.complaintRate >= 1        ? 'rate-high' : c.complaintRate >= 0.5        ? 'rate-medium' : 'rate-low';
      const pfmRateClass = c.pickerFaultMissingRate >= 1 ? 'rate-high' : c.pickerFaultMissingRate >= 0.5 ? 'rate-medium' : 'rate-low';
      const empId = c.employee_id || '';
      const captainLabel = c.employee_name || empId || 'Unknown Captain';
      const inStoreCell = _renderComplaintDrillCell(c.inStoreYes, empId, 'instore', `View in-store complaints for ${captainLabel}`, true);
      const pfmCell = _renderComplaintDrillCell(c.pickerFaultMissing, empId, 'pfm', `View picker fault missing complaints for ${captainLabel}`);
      const categoryCell = activeCategory === 'all'
        ? _esc(c.topCategory)
        : `<span class="compl-selected-category">
            <span>${_esc(activeCategory)}</span>
            <span class="compl-selected-category-count">${_fmt((c.byCategory || {})[activeCategory] || 0)} complaints</span>
          </span>`;
      return `<tr>
        <td style="font-weight:600;">${_esc(c.employee_name)}</td>
        <td>${_fmt(c.totalOrdersPicked)}</td>
        <td>${c.totalComplaints}</td>
        <td>${inStoreCell}</td>
        <td>${pfmCell}</td>
        <td><span class="compl-rate-badge ${pfmRateClass}">${c.pickerFaultMissingRate ?? 0}%</span></td>
        <td><span class="compl-rate-badge ${rateClass}">${c.complaintRate}%</span></td>
        <td>${categoryCell}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="compl-table-toolbar">
        <span class="compl-table-toolbar-label">Complaint Category</span>
        <div class="compl-category-filter-chips">${categoryButtons}</div>
      </div>
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
              <th>${activeCategory === 'all' ? 'Top Category' : 'Selected Category'}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _bindComplaintCaptainCategoryToggles(container);
    _initTableSort(container.querySelector('.data-table'));
    _bindComplaintDrilldowns(container);
  }

  function _bindComplaintCaptainCategoryToggles(container) {
    container.querySelectorAll('[data-compl-captain-cat]').forEach(btn => {
      btn.addEventListener('click', () => onComplCaptainCategoryChange(btn.dataset.complCaptainCat || 'all'));
    });
  }

  function _renderCategoryTable(sortedL0) {
    const container = document.getElementById('compl-category-table-container');
    if (!container) return;

    const rows = sortedL0.map(c => {
      const category = c.category || 'Unknown';
      const complaintsCell = _renderL0ComplaintDrillCell(c.count, category, 'all', `View all complaints for ${category}`);
      const inStoreCell = _renderL0ComplaintDrillCell(c.inStoreYes, category, 'instore', `View in-store complaints for ${category}`, true);
      return `<tr>
        <td style="font-weight:600;">${_esc(category)}</td>
        <td>${complaintsCell}</td>
        <td>${inStoreCell}</td>
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
    _bindComplaintDrilldowns(container);
  }

  function _renderComplaintDrillCell(count, empId, kind, label, danger = false) {
    const n = Number(count) || 0;
    const text = _fmt(n);
    if (n <= 0) {
      return `<span class="compl-drill-empty${danger ? ' compl-drill-danger-text' : ''}">${text}</span>`;
    }
    return `<button type="button"
      class="compl-drill-btn${danger ? ' compl-drill-danger' : ''}"
      data-compl-emp="${_esc(empId || '')}"
      data-compl-kind="${_esc(kind)}"
      aria-label="${_esc(label)}">${text}</button>`;
  }

  function _renderL0ComplaintDrillCell(count, l0Category, kind, label, danger = false) {
    const n = Number(count) || 0;
    const text = _fmt(n);
    if (n <= 0) {
      return `<span class="compl-drill-empty${danger ? ' compl-drill-danger-text' : ''}">${text}</span>`;
    }
    return `<button type="button"
      class="compl-drill-btn${danger ? ' compl-drill-danger' : ''}"
      data-compl-l0="${_esc(l0Category || 'Unknown')}"
      data-compl-kind="${_esc(kind)}"
      aria-label="${_esc(label)}">${text}</button>`;
  }

  function _bindComplaintDrilldowns(container) {
    container.querySelectorAll('.compl-drill-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.dataset.complL0 !== undefined) {
          _showL0ComplaintDetail(btn.dataset.complL0 || 'Unknown', btn.dataset.complKind || 'all');
        } else {
          _showComplaintDetail(btn.dataset.complEmp || '', btn.dataset.complKind || 'instore');
        }
      });
    });
  }

  function _showComplaintDetail(empId, kind) {
    const isPickerMissing = kind === 'pfm';
    const matchesKind = (row) => {
      if (!row.in_store) return false;
      if (!isPickerMissing) return true;
      return (row.complaint_category || '').toLowerCase() === 'item_missing';
    };
    const rows = _complDetailRows
      .filter(row => (row.employee_id || '') === empId && matchesKind(row))
      .slice();

    const captain = _complDetailCaptains.get(empId);
    const captainName = captain?.employee_name || empId || 'Unknown Captain';
    const title = isPickerMissing ? 'Picker Fault Missing' : 'In-Store Yes';
    _showComplaintRowsDetail(rows, title, captainName);
  }

  function _showL0ComplaintDetail(l0Category, kind) {
    const isInStoreOnly = kind === 'instore';
    const rows = _complDetailRows
      .filter(row => {
        const rowL0 = row.l0_category || 'Unknown';
        if (rowL0 !== l0Category) return false;
        return isInStoreOnly ? !!row.in_store : true;
      })
      .slice();
    const title = isInStoreOnly ? 'L0 In-Store Complaints' : 'L0 Complaints';
    _showComplaintRowsDetail(rows, title, l0Category || 'Unknown', { showPickerName: true });
  }

  function _complPickerName(row) {
    const empId = row.employee_id || '';
    return row.employee_name
      || _complDetailCaptains.get(empId)?.employee_name
      || _complPickerNames.get(empId)
      || empId
      || 'Unknown';
  }

  function _showComplaintRowsDetail(rows, title, heading, options = {}) {
    const showPickerName = !!options.showPickerName;
    const sortedRows = rows
      .slice()
      .sort((a, b) => (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0));

    _closeComplaintDetail();
    if (sortedRows.length === 0) return;

    const uniqueOrders = new Set(rows.map(r => r.order_id).filter(Boolean)).size;
    const periodText = _complDetailPeriod.start && _complDetailPeriod.end
      ? `${_complDetailPeriod.start} to ${_complDetailPeriod.end}`
      : 'Selected period';

    const bodyRows = sortedRows.map(r => `
      <tr>
        <td style="white-space:nowrap;">${_esc(r.dateStr || _isoDateStr(r.date))}</td>
        <td>${_esc(r.order_id || '—')}</td>
        ${showPickerName ? `<td>${_esc(_complPickerName(r))}</td>` : ''}
        <td class="compl-detail-product">${_esc(r.product_name || '—')}</td>
        <td>${_esc(r.complaint_category || 'unknown')}</td>
        <td class="compl-detail-rca">${_esc(r.rca || '—')}</td>
        <td>${_esc(r.l0_category || '—')}</td>
        <td>${_esc(r.l1_category || '—')}</td>
      </tr>
    `).join('');

    const modal = document.createElement('div');
    modal.id = 'compl-detail-modal';
    modal.className = 'compl-detail-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'compl-detail-title');
    modal.innerHTML = `
      <div class="compl-detail-modal">
        <div class="compl-detail-header">
          <div>
            <p class="compl-detail-kicker">${_esc(title)}</p>
            <h3 id="compl-detail-title">${_esc(heading)}</h3>
            <p class="compl-detail-subtitle">${_esc(periodText)}</p>
          </div>
          <button type="button" class="compl-detail-close" aria-label="Close complaint details">&times;</button>
        </div>
        <div class="compl-detail-summary">
          <span>${_fmt(uniqueOrders)} unique order${uniqueOrders === 1 ? '' : 's'}</span>
          <span>${_fmt(sortedRows.length)} complaint row${sortedRows.length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-wrapper compl-detail-table-wrapper">
          <table class="data-table compl-detail-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Order ID</th>
                ${showPickerName ? '<th>Picker Name</th>' : ''}
                <th>Product</th>
                <th>Complaint Category</th>
                <th>RCA</th>
                <th>L0</th>
                <th>L1</th>
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.querySelector('.compl-detail-close')?.addEventListener('click', _closeComplaintDetail);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) _closeComplaintDetail();
    });
    _complDetailEscHandler = (event) => {
      if (event.key === 'Escape') _closeComplaintDetail();
    };
    document.addEventListener('keydown', _complDetailEscHandler);
    _initTableSort(modal.querySelector('.data-table'));
    modal.querySelector('.compl-detail-close')?.focus();
  }

  function _closeComplaintDetail() {
    document.getElementById('compl-detail-modal')?.remove();
    if (_complDetailEscHandler) {
      document.removeEventListener('keydown', _complDetailEscHandler);
      _complDetailEscHandler = null;
    }
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
        const paidRacks = c.aud.payableRacks ?? r;
        const capNote = paidRacks < r ? ` · ${paidRacks} paid` : '';
        auditCell = `<td class="${c.aud.amount > 0 ? 'cell-green' : ''}">\u20B9${_fmt(c.aud.amount)}<div style="font-size:11px;color:var(--text-muted);font-weight:400;margin-top:2px">${r} rack${r !== 1 ? 's' : ''}${capNote}</div></td>`;
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
    initAttendance,
    onAttendanceMonthChange,
    renderAttendance,
    onAttendanceOverrideChange,
    clearAttendanceOverrides,
    sortAttendance,
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
    initKeyMetrics,
    renderKeyMetrics,
    onKmPresetChange,
    onKmDateChange,
    kmJumpT1,
    loadSlaTargetCycle,
    updateSlaTarget,
    toggleComplaintSlaCategory,
    initComplaintsDeepDive,
    onComplPeriodChange,
    onComplPresetChange,
    onComplDateChange,
    renderComplaintsDeepDive,
    toggleComplQNG,
    onComplCatModeChange,
    onComplCaptainCategoryChange,
    toggleSupervisors,
    addExcludedId,
    removeExcludedId,
    loadSlabMonth,
    saveSlabOverrides,
    resetSlabOverrides,
    saveFlowThresholds,
    resetFlowThresholds,
    updateProductivityWeights,
    resetProductivityWeights,
    updateStaffAvailDivisor,
    resetStaffAvailDivisor,
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
      await sheets.fetchInstoreData(true);
      await sheets.fetchPnaData(true);
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
      ui.initAttendance();
      ui.initCaptainDropdown();
      ui.initCaptainProfilePeriods();
      ui.initOverviewPeriods();
      ui.initTiersView();
      ui.initInventoryHealth();
      ui.initComplaintsDeepDive();
      ui.initKeyMetrics();
      ui.initIncentivePeriods();

      // Render active tab
      _renderCurrentTab();

      // Update config row count
      const countEl = document.getElementById('config-row-count');
      if (countEl) countEl.textContent = raw.length.toLocaleString();

    } catch (err) {
      console.error('Dashboard load error:', err);
      _showError(`Failed to load data: ${err.message}`);
    } finally {
      _setLoading(false);
    }
  }

  // Non-blocking error toast (replaces alert(), which froze the UI and
  // looked broken on mobile). Auto-dismisses; click to dismiss early.
  function _showError(msg) {
    document.getElementById('app-error-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'app-error-toast';
    el.className = 'error-toast';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<span>${String(msg).replace(/</g, '&lt;')}</span><button type="button" aria-label="Dismiss">&times;</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
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
      case 'attendance':         ui.renderAttendance(); break;
      case 'captain-profile':   ui.renderCaptainProfile(); break;
      case 'tier-analysis':     ui.renderTiersView(); break;
      case 'inventory-health':       ui.renderInventoryHealth(); break;
      case 'key-metrics':            ui.renderKeyMetrics(); break;
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
