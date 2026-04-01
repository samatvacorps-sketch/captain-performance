/**
 * ui.js — DOM rendering: tabs, tables, dropdowns, summary cards
 *
 * Depends on: compute, charts, CONFIG
 * Called by: app (main orchestrator defined at bottom of this file)
 */

const ui = (() => {

  // ── Sort State (persists across re-renders) ───────────────────────────
  let _sortState = { col: null, dir: 'desc' };

  // ── Deep Dive Captain Filter ───────────────────────────────────────────
  // 'all' | 'flagged' | 'ok'
  let _ddFilter = 'all';

  function setDDFilter(val) {
    _ddFilter = (_ddFilter === val) ? 'all' : val;   // toggle off if already active
    renderDeepDive();
  }

  // ── Supervisor Exclusion ─────────────────────────────────────────────
  let _excludeSupervisors = localStorage.getItem('excludeSupervisors') !== 'false'; // default true

  function _supervisorFilter(rows) {
    if (!_excludeSupervisors || !CONFIG.SUPERVISOR_IDS) return rows;
    const s = new Set(CONFIG.SUPERVISOR_IDS);
    return rows.filter(r => !s.has(r.employee_id));
  }

  function _updateSupervisorBtn() {
    const btn = document.getElementById('supervisor-toggle');
    if (!btn) return;
    btn.classList.toggle('active', _excludeSupervisors);
    btn.textContent = _excludeSupervisors ? 'Excl. Supervisors' : 'Incl. Supervisors';
  }

  function toggleSupervisors() {
    _excludeSupervisors = !_excludeSupervisors;
    localStorage.setItem('excludeSupervisors', String(_excludeSupervisors));
    _updateSupervisorBtn();
    app.refresh();
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
    const aggregated = period === 'weekly'
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
    if (title) title.textContent = period === 'weekly' ? 'Weekly Summary' : 'Monthly Summary';

    _renderOverviewTable(aggregated, period);
  }

  function _renderOverviewTable(aggregated, period) {
    const head = document.getElementById('overview-table-head');
    const body = document.getElementById('overview-table-body');
    if (!head || !body) return;

    head.innerHTML = `<tr>
      <th>${period === 'weekly' ? 'Week' : 'Month'}</th>
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
      periodType = diffDays === 0 ? 'D' : 'W';
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

    // Compute period store stats (avg + SD) from the filtered rows
    const periodStoreStats = _computePeriodStoreStats(filtered);

    // Aggregate per captain for this period
    const byCaptain = _groupByCaptain(filtered, periodType, periodStoreStats);

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
      section.innerHTML = `
        <div class="flow-section-header">${meta.icon} ${meta.label} — ${captains.length} active captains</div>
        ${_buildDeepDiveTable(captains, meta.metrics, flow, periodStoreStats)}
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

  function _groupByCaptain(rows, periodType, periodStoreStats) {
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
          const flagged = devSD > 0.5; // Weekly/monthly: flag from 0.5 SD (daily keeps CONFIG.THRESHOLD)
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

      // Putting extras
      captain.total_putaway_qty = captain.rows
        .filter(r => r.flows?.is_putting)
        .reduce((s, r) => s + (r.putaway_qty || 0), 0);

      // Audit extras
      captain.total_racks_audited = captain.rows
        .filter(r => r.flows?.is_audit)
        .reduce((s, r) => s + (r.racks_audited || 0), 0);
      captain.total_auditor_hours = captain.rows
        .filter(r => r.flows?.is_audit)
        .reduce((s, r) => s + (r.auditor_active_time || 0), 0) / 3600;

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
  function _computePeriodStoreStats(rows) {
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
          if (metric.key === 'audit_hours_per_rack')
            return (r.auditor_active_time > 0 && r.racks_audited > 0)
              ? (r.auditor_active_time / 3600) / r.racks_audited : null;
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
      case 'total_orders': return captain.total_orders_picked ?? 0;
      case 'avg_ppi':               return captain.avg_ppi ?? -Infinity;
      case 'total_time_per_order':  return captain.avgValues?.total_time_per_order ?? -Infinity;
      case 'putaway_qty':  return captain.total_putaway_qty ?? 0;
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

  function _buildDeepDiveTable(captains, metrics, flow, periodStoreStats) {
    if (flow === 'picking') return _buildPickingTable(captains, periodStoreStats);
    if (flow === 'putting') return _buildPuttingTable(captains, periodStoreStats);
    if (flow === 'audit')   return _buildAuditTable(captains, periodStoreStats);
    if (flow === 'fnv')     return _buildFNVTable(captains);
    return '';
  }

  function _buildPickingTable(captains, periodStoreStats) {
    // Metric order: Delay to Start | Pick Time/Order | Billing Time/Order | Picks Per Interval
    const orderedMetrics = [
      CONFIG.METRICS.find(m => m.key === 'assigned_to_started_per_order'),
      CONFIG.METRICS.find(m => m.key === 'picking_time_per_order'),
      CONFIG.METRICS.find(m => m.key === 'billing_time_per_order'),
      CONFIG.METRICS.find(m => m.key === 'total_time_per_order'),
    ].filter(Boolean);

    const metricSortKeys = {
      'assigned_to_started_per_order': 'assigned_to_started_per_order',
      'picking_time_per_order': 'picking_time_per_order',
      'billing_time_per_order': 'billing_time_per_order',
      'total_time_per_order': 'total_time_per_order',
    };

    const headers = `
      ${_thSort('Captain', 'name', 'picking')}
      ${_thSort('Score<br/><small style="font-weight:400;opacity:0.8">composite</small>', 'score', 'picking')}
      ${_thSort('Total Orders', 'total_orders', 'picking')}
      ${_thSort('PPI<br/><small style="font-weight:400;opacity:0.8">sec/item</small>', 'avg_ppi', 'picking')}
      ${orderedMetrics.map(m =>
        _thSort(`${m.label}<br/><small style="font-weight:400;opacity:0.8">actual | personal | store</small>`, metricSortKeys[m.key], 'picking')
      ).join('')}
    `;

    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => {
      const metricCells = orderedMetrics.map(metric => {
        const dev     = captain.deviations.get(metric.key);
        const cls     = compute.deviationClass(dev);
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
        <td>${_scoreBadge(captain.picking_score)}</td>
        <td>${_fmt(captain.total_orders_picked)}</td>
        <td>${captain.avg_ppi !== null ? _fmt(captain.avg_ppi, 2) : '—'}</td>
        ${metricCells}
        <td>${_statusBadge(captain.picking_score)}</td>
      </tr>`;
    }).join('');

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>${headers}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildPuttingTable(captains, periodStoreStats) {
    const metric = CONFIG.METRICS.find(m => m.key === 'iph');
    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => {
      const dev     = metric ? captain.deviations.get(metric.key) : null;
      const cls     = compute.deviationClass(dev);
      const actual  = metric ? captain.avgValues[metric.key] : null;
      const flagged = metric ? captain.flags.get(metric.key) : false;
      const personalAvg = metric ? app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key) : null;
      const storeAvg    = metric ? (periodStoreStats?.get(metric.key)?.avg ?? null) : null;
      const fmt = v => (v === null || v === undefined) ? '—' : _fmt(v, 1);

      return `<tr>
        ${_captainCell(captain.employee_name, captain.employee_id)}
        <td>${_scoreBadge(captain.putting_score)}</td>
        <td>${_fmt(captain.total_putaway_qty)}</td>
        <td class="${cls}" title="${flagged ? '🚩 Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ` <span style="opacity:0.7;vertical-align:middle">${ICONS.flagSm}</span>` : ''}
        </td>
        <td>${_statusBadge(captain.putting_score)}</td>
      </tr>`;
    }).join('');

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'putting')}
        ${_thSort('Score', 'score', 'putting')}
        ${_thSort('Putaway Qty', 'putaway_qty', 'putting')}
        ${_thSort('Items Put Away/Hr<br/><small style="font-weight:400;opacity:0.7">actual | personal | store</small>', 'iph', 'putting')}
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildAuditTable(captains, periodStoreStats) {
    const metric = CONFIG.METRICS.find(m => m.key === 'audit_hours_per_rack');
    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => {
      const dev     = metric ? captain.deviations.get(metric.key) : null;
      const cls     = compute.deviationClass(dev);
      const actual  = metric ? captain.avgValues[metric.key] : null;
      const flagged = metric ? captain.flags.get(metric.key) : false;
      const personalAvg = metric ? app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key) : null;
      const storeAvg    = metric ? (periodStoreStats?.get(metric.key)?.avg ?? null) : null;
      const fmt = v => (v === null || v === undefined) ? '—' : _fmt(v, 2);

      return `<tr>
        ${_captainCell(captain.employee_name, captain.employee_id)}
        <td>${_scoreBadge(captain.audit_score)}</td>
        <td>${_fmt(captain.total_racks_audited)}</td>
        <td>${_fmt(captain.total_auditor_hours, 1)} h</td>
        <td class="${cls}" title="${flagged ? 'Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ` <span style="opacity:0.7;vertical-align:middle">${ICONS.flagSm}</span>` : ''}
        </td>
        <td>${_statusBadge(captain.audit_score)}</td>
      </tr>`;
    }).join('');

    return `<div class="table-wrapper" style="border-radius:0;border:none;"><table class="dd-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'audit')}
        ${_thSort('Score', 'score', 'audit')}
        ${_thSort('Racks Audited', 'racks', 'audit')}
        ${_thSort('Auditor Hours', 'audit_hours', 'audit')}
        ${_thSort('Audit Efficiency<br/><small style="font-weight:400;opacity:0.7">actual | personal | store (hr/rack)</small>', 'audit_hours_per_rack', 'audit')}
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildFNVTable(captains) {
    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => `<tr>
      ${_captainCell(captain.employee_name, captain.employee_id)}
      <td>${captain.avg_fnv_rate !== null ? _fmt(captain.avg_fnv_rate, 1) : '—'}</td>
      <td>${_fmt(captain.total_fnv_hours, 1)} h</td>
    </tr>`).join('');

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

  function initTiersView() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const weekly  = compute.aggregateWeekly(data);
    const monthly = compute.aggregateMonthly(data);
    const sel = document.getElementById('tiers-period');
    if (!sel) return;

    sel.innerHTML = [
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
    renderTiersView();
  }

  function onTierPresetChange() {
    _tierDateMode = false;
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal  = document.getElementById('tiers-period')?.value;
    if (!periodVal) return;
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

  function _tierMetrics(rows) {
    const pickRows = rows.filter(r => r.flows?.is_picking);
    const putRows  = rows.filter(r => r.flows?.is_putting);
    const captains = new Set(rows.map(r => r.employee_id));

    const avg = (arr, key) => {
      const vals = arr.map(r => r[key]).filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
    const avgScore = rows.length > 0
      ? rows.reduce((s, r) => s + (r.composite_slacker_score || 0), 0) / rows.length : null;

    return {
      captainCount:       captains.size,
      totalOrders:        sum(pickRows, 'checkout_orders'),
      avgPickTime:        avg(pickRows, 'picking_time_per_order'),
      avgDelayToStart:    avg(pickRows, 'assigned_to_started_per_order'),
      avgBillingTime:     avg(pickRows, 'billing_time_per_order'),
      avgTotalTime:       avg(pickRows, 'total_time_per_order'),
      avgPPI:             avg(pickRows, 'ppi'),
      totalPutawayQty:    sum(putRows, 'putaway_qty'),
      avgIPH:             avg(putRows, 'iph'),
      avgScore:           avgScore,
    };
  }

  function renderTiersView() {
    const data = app.getFlaggedData();
    const container = document.getElementById('tiers-content');
    if (!data || data.length === 0 || !container) return;

    // Determine period start to count active days UP TO (not including) that date
    const startVal = document.getElementById('tiers-start')?.value;
    const periodStartMs = startVal ? new Date(startVal).setHours(0,0,0,0) : Infinity;

    // Count each captain's active days strictly before the selected period start
    const activeDayMap = {};
    for (const row of data) {
      if (!row.employee_id || !row.dateStr) continue;
      if (row.date && row.date < periodStartMs) {
        if (!activeDayMap[row.employee_id]) activeDayMap[row.employee_id] = new Set();
        activeDayMap[row.employee_id].add(String(row.dateStr));
      }
    }
    const activeDayCounts = {};
    for (const [id, days] of Object.entries(activeDayMap)) {
      activeDayCounts[id] = days.size;
    }

    const filtered = _filterTierRows(data);
    if (filtered.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No data for selected period.</p>';
      return;
    }

    // Split filtered rows by tier
    const tierRows = { new: [], experienced: [], senior: [], blinkit: [], od: [] };
    for (const row of filtered) {
      const tier = _classifyCaptain(activeDayCounts, row.employee_id);
      tierRows[tier].push(row);
    }

    const stats = {
      new:        _tierMetrics(tierRows.new),
      experienced: _tierMetrics(tierRows.experienced),
      senior:     _tierMetrics(tierRows.senior),
      blinkit:    _tierMetrics(tierRows.blinkit),
      od:         _tierMetrics(tierRows.od),
    };

    container.innerHTML = _buildTiersHTML(stats, activeDayCounts);
    container.querySelectorAll('.tiers-table').forEach(t => _initTableSort(t));
  }

  function _buildTiersHTML(stats, activeDayCounts) {
    const tiers = [
      { key: 'new',         label: 'New',          sub: '< 30 active days',      color: '#4edea3' },
      { key: 'experienced', label: 'Experienced',  sub: '30–120 active days',    color: '#adc6ff' },
      { key: 'senior',      label: 'Senior',       sub: '> 120 active days',     color: '#c084fc' },
      { key: 'blinkit',     label: 'Blinkit Caps', sub: 'GCEB (excl. GCEBOD)',   color: '#fb923c' },
      { key: 'od',          label: 'ODs',          sub: 'ID starts with GCEBOD', color: '#fbbf24' },
    ];

    const fmtDur = v => v !== null ? compute.formatDuration(v) : '—';
    const fmtNum = (v, d=1) => v !== null ? _fmt(v, d) : '—';
    const st = k => stats[k];

    // Color-code values across tiers
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

    // ── 1. Tier overview cards (5-column equal grid) ───────────────────
    const allCards = tiers.map(t => {
      const has = st(t.key).captainCount > 0;
      return `
        <div class="tier-metric-card">
          <p class="tier-card-label">${t.label}</p>
          <div class="tier-card-row">
            <span class="tier-card-value" style="color:${t.color}">${st(t.key).captainCount}</span>
            ${has ? `<span class="tier-card-badge" style="color:${t.color};background:${t.color}18">Active</span>` : ''}
          </div>
          <p class="tier-card-sub">${t.sub}</p>
          ${has ? `<p class="tier-card-hint">Avg score: ${fmtNum(st(t.key).avgScore, 2)}</p>`
                : `<p class="tier-card-hint inactive">No data</p>`}
        </div>`;
    }).join('');

    const bentoGrid = `
      <div class="tiers-bento-grid">
        ${allCards}
      </div>`;

    // ── 2. Picking Flow Analysis ──────────────────────────────────────
    const pickVals = {
      orders:  tiers.map(t => st(t.key).totalOrders),
      pick:    tiers.map(t => st(t.key).avgPickTime),
      delay:   tiers.map(t => st(t.key).avgDelayToStart),
      billing: tiers.map(t => st(t.key).avgBillingTime),
      score:   tiers.map(t => st(t.key).avgScore),
    };
    const totalOrders = pickVals.orders.reduce((a, v) => a + (v || 0), 0);

    const pickRows = tiers.map((t, i) => {
      const has = st(t.key).captainCount > 0;
      const orderPct = totalOrders > 0 && pickVals.orders[i]
        ? `<span class="tiers-pct">${((pickVals.orders[i]/totalOrders)*100).toFixed(1)}%</span>` : '';
      const clsPick   = colorCode(pickVals.pick,    'HIGH');
      const clsDelay  = colorCode(pickVals.delay,   'HIGH');
      const clsBill   = colorCode(pickVals.billing, 'HIGH');
      const clsScore  = colorCode(pickVals.score,   'HIGH');
      return `
        <tr class="${has ? '' : 'tiers-row-empty'}">
          <td class="tiers-tier-name" style="color:${t.color}">${t.label}</td>
          <td>${has ? `${_fmt(pickVals.orders[i], 0)} ${orderPct}` : '—'}</td>
          <td class="${clsPick[i]}">${fmtDur(pickVals.pick[i])}</td>
          <td class="${clsDelay[i]}">${fmtDur(pickVals.delay[i])}</td>
          <td class="${clsBill[i]}">${fmtDur(pickVals.billing[i])}</td>
          <td class="${clsScore[i]}">${fmtNum(pickVals.score[i], 2)}</td>
        </tr>`;
    }).join('');

    const pickSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#adc6ff"></div>
          <h3 class="tiers-section-title">Picking Flow Analysis</h3>
        </div>
        <div class="table-wrapper" style="border-radius:12px;">
          <table class="tiers-table">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Total Picked</th>
                <th>Avg Pick Time</th>
                <th>Avg Delay</th>
                <th>Billing Time</th>
                <th>Avg Score</th>
              </tr>
            </thead>
            <tbody>${pickRows}</tbody>
          </table>
        </div>
      </div>`;

    // ── 3. Putting Flow Bento ─────────────────────────────────────────
    const totalPutaway = tiers.reduce((a, t) => a + (st(t.key).totalPutawayQty || 0), 0);
    const activePut    = tiers.filter(t => st(t.key).totalPutawayQty > 0);
    const clsIPH       = colorCode(tiers.map(t => st(t.key).avgIPH), 'LOW');

    const iph_mini_cards = tiers.map((t, i) => {
      const iph = st(t.key).avgIPH;
      const qty = st(t.key).totalPutawayQty;
      if (!qty) return '';
      const pct = totalPutaway > 0 ? (qty / totalPutaway) * 100 : 0;
      return `
        <div class="tier-iph-card ${clsIPH[i]}">
          <p class="tier-card-label" style="color:${t.color}">${t.label}</p>
          <p class="tier-iph-value">${fmtNum(iph, 1)}</p>
          <div class="tier-iph-bar-bg">
            <div class="tier-iph-bar-fill" style="width:${pct.toFixed(1)}%;background:${t.color}"></div>
          </div>
          <p class="tier-card-hint">${_fmt(qty, 0)} items · ${pct.toFixed(1)}%</p>
        </div>`;
    }).filter(Boolean).join('');

    const putSection = `
      <div class="tiers-flow-section">
        <div class="tiers-section-header">
          <div class="tiers-section-pip" style="background:#4d8eff"></div>
          <h3 class="tiers-section-title">Putting Flow Analysis</h3>
        </div>
        <div class="tiers-putting-bento">
          <div class="tiers-putting-hero">
            <p class="tier-card-label">Total Putaway Qty</p>
            <p class="tiers-hero-value">${_fmt(totalPutaway, 0)}</p>
            <p class="tier-card-hint">${activePut.length} tier${activePut.length !== 1 ? 's' : ''} active this period</p>
          </div>
          <div class="tiers-iph-grid">${iph_mini_cards || '<p class="tier-card-hint inactive" style="padding:16px">No putting data for period</p>'}</div>
        </div>
      </div>`;

    return `${bentoGrid}${pickSection}${putSection}`;
  }

  // ── Captain Profile ────────────────────────────────────────────────────

  function initCaptainDropdown() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const captains = [...new Map(data.map(r => [r.employee_id, r.employee_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));

    const sel = document.getElementById('profile-captain');
    if (!sel) return;

    sel.innerHTML = '<option value="">— Select Captain —</option>' +
      captains.map(([id, name]) => `<option value="${_esc(id)}">${_esc(name)} (${_esc(id)})</option>`).join('');
  }

  function resetProfileDates() {
    document.getElementById('profile-start').value = '';
    document.getElementById('profile-end').value   = '';
    renderCaptainProfile();
  }

  function renderCaptainProfile() {
    const data = app.getFlaggedData();
    const container = document.getElementById('profile-content');
    const captainId = document.getElementById('profile-captain')?.value;

    if (!container) return;

    if (!captainId) {
      container.innerHTML = '<p class="placeholder-text">Select a captain to view their performance profile.</p>';
      return;
    }

    const allCaptainRows = data
      .filter(r => r.employee_id === captainId)
      .sort((a, b) => a.date - b.date);

    if (allCaptainRows.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No data for this captain.</p>';
      return;
    }

    // Auto-set date range to this captain's full history on first load
    const startInput = document.getElementById('profile-start');
    const endInput   = document.getElementById('profile-end');
    if (startInput && !startInput.value) {
      startInput.value = _isoDateStr(allCaptainRows[0].date);
    }
    if (endInput && !endInput.value) {
      endInput.value = _isoDateStr(allCaptainRows[allCaptainRows.length - 1].date);
    }

    // Filter to selected date range
    const startMs = startInput?.value ? new Date(startInput.value).setHours(0,0,0,0)   : -Infinity;
    const endMs   = endInput?.value   ? new Date(endInput.value).setHours(23,59,59,999) :  Infinity;
    const captainRows = allCaptainRows.filter(r => r.date >= startMs && r.date <= endMs);

    if (captainRows.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No data for this captain in the selected date range.</p>';
      return;
    }

    const name        = captainRows[0].employee_name;
    const totalDays   = allCaptainRows.length;          // always total, not filtered
    const shownDays   = captainRows.length;
    const flaggedDays = captainRows.filter(r => r.composite_slacker_score > 0).length;
    const isFiltered  = shownDays < totalDays;

    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    container.innerHTML = `
      <div class="profile-hero">
        <div class="profile-avatar">${initials}</div>
        <div class="profile-hero-info">
          <h3 class="profile-hero-name">${_esc(name)}</h3>
          <p class="profile-hero-id">${_esc(captainId)}</p>
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
        </div>
      </div>
      <div class="profile-metric-grid" id="profile-metric-grid"></div>
    `;

    const grid = document.getElementById('profile-metric-grid');
    const labels = captainRows.map(r => _isoDateStr(r.date));

    // Active metrics for this captain
    const activeMetrics = CONFIG.METRICS.filter(metric => {
      return captainRows.some(r => {
        switch (metric.flow) {
          case 'picking': return r.flows?.is_picking;
          case 'putting': return r.flows?.is_putting;
          case 'audit':   return r.flows?.is_audit;
          case 'fnv':     return r.flows?.is_fnv;
        }
        return false;
      });
    });

    activeMetrics.forEach((metric, i) => {
      const values = captainRows.map(r => {
        const v = metric.key === 'fnv_audit_rate' ? r.fnv_audit_rate : r[metric.key];
        return (v && v > 0) ? (metric.isDuration ? +(v/60).toFixed(2) : +v.toFixed(2)) : null;
      });

      const flagDays = captainRows.map(r => r.flags?.get(metric.key) === true);
      const canvasId = `sparkline-${i}`;

      const card = document.createElement('div');
      card.className = 'profile-metric-card';
      card.innerHTML = `
        <h4>${metric.label}${metric.isDuration ? ' (min)' : ''}</h4>
        <canvas id="${canvasId}" height="120"></canvas>
      `;
      grid.appendChild(card);

      // Render after DOM insertion
      setTimeout(() => {
        charts.renderSparkline(canvasId, labels, values, flagDays);
      }, 0);
    });
  }

  // ── Config Panel ───────────────────────────────────────────────────────

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

    container.innerHTML = `
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-blue">${ICONS.sliders}</div>
          <h3>Flagging Threshold</h3>
        </div>
        <p class="config-desc">Standard deviations worse than store average required to flag a captain.</p>
        <div class="config-row">
          <span class="dd-control-label">Multiplier</span>
          <input type="number" id="threshold-input" min="0.5" max="3" step="0.1" value="${CONFIG.THRESHOLD}"
                 onchange="app.updateThreshold(this.value)" />
        </div>
        <p class="config-hint">Default: 1.0 (= 1 SD). Higher = stricter (fewer flags).</p>
      </div>
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
      '<optgroup label="Weekly">',
      ...weekly.slice().reverse().map(d => `<option value="W:${d.week_key}">${d.label || d.week_key}</option>`),
      '</optgroup>',
      '<optgroup label="Monthly">',
      ...monthly.slice().reverse().map(d => `<option value="M:${d.month_key}">${d.label || d.month_key}</option>`),
      '</optgroup>',
    ].join('');

    // Default to All Time — leave date inputs empty so all daily metrics are included
    document.getElementById('inv-start').value = '';
    document.getElementById('inv-end').value   = '';

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

    if (periodVal === 'all') {
      // Clear date inputs so all daily metrics data is included (true All Time)
      document.getElementById('inv-start').value = '';
      document.getElementById('inv-end').value   = '';
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
    const cacheKey = `${startVal}_${endVal}_${auditData.length}`;
    if (_invCacheKey !== cacheKey) {
      _invCache = compute.computeAuditAggregations(filteredAudit, filteredDaily);
      _invCacheKey = cacheKey;
    }
    const agg = _invCache;
    if (!agg) return;

    const period = document.getElementById('inv-period')?.value || 'weekly';
    const periodData = period === 'monthly' ? agg.volume.monthly : agg.volume.weekly;

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
              <p class="bento-card-subtitle">Unique rack codes per ${period === 'monthly' ? 'month' : 'week'}</p>
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

  function initComplaintsDeepDive() {
    const complData = sheets.getComplaintsCached();
    const sel = document.getElementById('compl-preset');
    if (!sel || !complData || complData.length === 0) return;

    const weekly  = compute.aggregateWeekly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));
    const monthly = compute.aggregateMonthly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

    sel.innerHTML = [
      '<option value="all">All Time</option>',
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
    const periodData = period === 'monthly' ? agg.storeSummary.monthly : agg.storeSummary.weekly;
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

      <!-- Zone 1: Trends -->
      <div class="compl-section">
        <div class="bento-grid">
          <div class="bento-card bento-large">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Trend</h3>
                <p class="bento-card-subtitle">Total complaints vs in-store fault rate</p>
              </div>
              <div class="bento-chart-legend">
                <span class="legend-item"><span class="legend-dot" style="background:#ff6b6b;"></span>Complaints</span>
                <span class="legend-item"><span class="legend-dot" style="background:#ffca28;"></span>In-Store %</span>
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
                <p class="bento-card-subtitle">Stacked by complaint type</p>
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

    // Render charts
    charts.renderComplaintTrendChart('chart-compl-trend', periodData);
    charts.renderRCADonutChart('chart-compl-rca', agg.categoryIntel.sorted.rca);
    charts.renderComplaintCategoryChart('chart-compl-category', periodData);
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
    onDeepDivePresetChange,
    onDeepDiveDateChange,
    initTiersView,
    renderTiersView,
    onTierPresetChange,
    onTierDateChange,
    initFlagsDate,
    renderDailyFlags,
    initCaptainDropdown,
    renderCaptainProfile,
    resetProfileDates,
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
    toggleSupervisors,
    filterSupervisors,
    updateSupervisorBtn: _updateSupervisorBtn,
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

      // Compute stats pipeline (filter supervisors before stats/flagging)
      const filteredRaw = ui.filterSupervisors(raw);
      _storeStats   = compute.computeStoreStats(filteredRaw);
      _personalAvgs = compute.computePersonalAvgs(filteredRaw, sheets.getAuditCached() || []);
      _flaggedData  = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD);

      // Update last-refreshed timestamp
      const ts = document.getElementById('last-refreshed');
      if (ts) ts.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;

      ui.updateSupervisorBtn();

      // Init dynamic dropdowns
      ui.initDeepDivePeriods();
      ui.initFlagsDate();
      ui.initCaptainDropdown();
      ui.initOverviewPeriods();
      ui.initTiersView();
      ui.initInventoryHealth();
      ui.initComplaintsDeepDive();

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
      _flaggedData = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD);
      _renderCurrentTab();
    }
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

  return { init, refresh, switchTab, updateThreshold, getFlaggedData, getStoreStats, getPersonalAvgs };
})();
