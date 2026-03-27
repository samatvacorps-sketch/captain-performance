/**
 * ui.js — DOM rendering: tabs, tables, dropdowns, summary cards
 *
 * Depends on: compute, charts, CONFIG
 * Called by: app (main orchestrator defined at bottom of this file)
 */

const ui = (() => {

  // ── Sort State (persists across re-renders) ───────────────────────────
  let _sortState = { col: null, dir: 'desc' };

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

  function renderStoreOverview() {
    const data = app.getFlaggedData();
    if (!data || data.length === 0) return;

    const period = document.getElementById('overview-period')?.value || 'weekly';
    const aggregated = period === 'weekly'
      ? compute.aggregateWeekly(data)
      : compute.aggregateMonthly(data);

    // Charts
    charts.renderOrdersHoursChart('chart-orders-hours', aggregated);
    charts.renderTimeMetricsChart('chart-time-metrics', aggregated);
    charts.renderIPHChart('chart-iph', aggregated);
    charts.renderComplaintsChart('chart-complaints', aggregated);

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
      <th>Picking Hours</th>
      <th>Avg Pick Time</th>
      <th>Avg Delay to Start</th>
      <th>Avg Billing Time</th>
      <th>Putaway Qty</th>
      <th>Avg IPH</th>
      <th>Racks Audited</th>
      <th>Complaints</th>
    </tr>`;

    body.innerHTML = aggregated.map(d => `<tr>
      <td>${d.label || d.week_key || d.month_key}</td>
      <td>${d.active_captains || 0}</td>
      <td>${_fmt(d.total_orders_picked)}</td>
      <td>${_fmt(d.total_picking_hours, 1)} h</td>
      <td>${compute.formatDuration(d.avg_picking_time_per_order)}</td>
      <td>${compute.formatDuration(d.avg_assigned_to_started)}</td>
      <td>${compute.formatDuration(d.avg_billing_time)}</td>
      <td>${_fmt(d.total_putaway_qty)}</td>
      <td>${_fmt(d.avg_iph, 1)}</td>
      <td>${_fmt(d.total_racks_audited)}</td>
      <td>${_fmt(d.total_complaints)}</td>
    </tr>`).join('');
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
    renderDeepDive();
  }

  function onDeepDiveDateChange() {
    _deepDiveDateMode = true;
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
    container.innerHTML = '';

    const flows = flowFilter === 'all'
      ? ['picking', 'putting', 'audit', 'fnv']
      : [flowFilter];

    const flowMeta = {
      picking: { label: 'Picking Flow', icon: '📦', metrics: CONFIG.METRICS.filter(m => m.flow === 'picking') },
      putting: { label: 'Putting Flow', icon: '📥', metrics: CONFIG.METRICS.filter(m => m.flow === 'putting') },
      audit:   { label: 'Audit Flow',   icon: '🔍', metrics: CONFIG.METRICS.filter(m => m.flow === 'audit') },
      fnv:     { label: 'FNV Audit Flow', icon: '🥦', metrics: CONFIG.METRICS.filter(m => m.flow === 'fnv') },
    };

    for (const flow of flows) {
      const meta = flowMeta[flow];
      const captains = byCaptain.filter(c => c[`has_${flow}`]);
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
      container.innerHTML = '<p class="placeholder-text">No active captains in the selected period/flow.</p>';
    }

    // Attach sort click listeners
    container.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (_sortState.col === col) {
          _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _sortState.col = col;
          _sortState.dir = 'desc';
        }
        renderDeepDive();
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
        .map(r => metric.key === 'fnv_audit_rate' ? r.fnv_audit_rate : r[metric.key])
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
    const active = col === _sortState.col ? 'style="color:#4fc3f7"' : '';
    return `<th data-sort="${col}" data-flow="${flow}" ${active} style="cursor:pointer;user-select:none">${label}${indicator}</th>`;
  }

  function _buildDeepDiveTable(captains, metrics, flow, periodStoreStats) {
    if (flow === 'picking') return _buildPickingTable(captains, periodStoreStats);
    if (flow === 'putting') return _buildPuttingTable(captains, periodStoreStats);
    if (flow === 'audit')   return _buildAuditTable(captains);
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
      ${_thSort('ID', 'id', 'picking')}
      ${_thSort('Score<br/><small style="font-weight:400;opacity:0.8">avg daily</small>', 'score', 'picking')}
      ${_thSort('Total Orders', 'total_orders', 'picking')}
      ${_thSort('PPI<br/><small style="font-weight:400;opacity:0.8">sec/item</small>', 'avg_ppi', 'picking')}
      ${orderedMetrics.map(m =>
        _thSort(`${m.label}<br/><small style="font-weight:400;opacity:0.8">actual | personal | store</small>`, metricSortKeys[m.key], 'picking')
      ).join('')}
    `;

    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => {
      const scoreCls = captain.composite_slacker_score >= 1.5 ? 'cell-dark-red'
                      : captain.composite_slacker_score >= 0.5 ? 'cell-red' : '';

      const metricCells = orderedMetrics.map(metric => {
        const dev     = captain.deviations.get(metric.key);
        const cls     = compute.deviationClass(dev);
        const actual  = captain.avgValues[metric.key];
        const flagged = captain.flags.get(metric.key);
        const personalAvg = app.getPersonalAvgs()?.get(captain.employee_id)?.get(metric.key);
        const storeAvg    = periodStoreStats?.get(metric.key)?.avg ?? null;
        const fmt = v => (v === null || v === undefined) ? '—'
          : metric.isDuration ? compute.formatDuration(v) : _fmt(v, 1);
        return `<td class="${cls}" title="${flagged ? '🚩 Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ' 🚩' : ''}
        </td>`;
      }).join('');

      return `<tr>
        <td><strong>${_esc(captain.employee_name)}</strong></td>
        <td>${_esc(captain.employee_id)}</td>
        <td class="${scoreCls}">${captain.composite_slacker_score}</td>
        <td>${_fmt(captain.total_orders_picked)}</td>
        <td>${captain.avg_ppi !== null ? _fmt(captain.avg_ppi, 2) : '—'}</td>
        ${metricCells}
      </tr>`;
    }).join('');

    return `<div class="table-wrapper"><table class="data-table">
      <thead><tr>${headers}</tr></thead>
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
      const scoreCls = captain.composite_slacker_score >= 1.5 ? 'cell-dark-red'
                      : captain.composite_slacker_score >= 0.5 ? 'cell-red' : '';
      const fmt = v => (v === null || v === undefined) ? '—' : _fmt(v, 1);

      return `<tr>
        <td><strong>${_esc(captain.employee_name)}</strong></td>
        <td>${_esc(captain.employee_id)}</td>
        <td class="${scoreCls}">${captain.composite_slacker_score}</td>
        <td>${_fmt(captain.total_putaway_qty)}</td>
        <td class="${cls}" title="${flagged ? '🚩 Flagged' : ''}">
          ${fmt(actual)} | ${fmt(personalAvg)} | ${fmt(storeAvg)}${flagged ? ' 🚩' : ''}
        </td>
      </tr>`;
    }).join('');

    return `<div class="table-wrapper"><table class="data-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'putting')}
        ${_thSort('ID', 'id', 'putting')}
        ${_thSort('Score<br/><small style="font-weight:400;opacity:0.8">avg daily</small>', 'score', 'putting')}
        ${_thSort('Putaway Qty', 'putaway_qty', 'putting')}
        ${_thSort('Items Put Away/Hr<br/><small style="font-weight:400;opacity:0.8">actual | personal | store</small>', 'iph', 'putting')}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildAuditTable(captains) {
    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => `<tr>
      <td><strong>${_esc(captain.employee_name)}</strong></td>
      <td>${_esc(captain.employee_id)}</td>
      <td>${_fmt(captain.total_racks_audited)}</td>
      <td>${_fmt(captain.total_auditor_hours, 1)} h</td>
    </tr>`).join('');

    return `<div class="table-wrapper"><table class="data-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'audit')}
        ${_thSort('ID', 'id', 'audit')}
        ${_thSort('Racks Audited', 'racks', 'audit')}
        ${_thSort('Auditor Hours', 'audit_hours', 'audit')}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function _buildFNVTable(captains) {
    const sorted = _sortedCaptains(captains, _sortState.col);
    const rows = sorted.map(captain => `<tr>
      <td><strong>${_esc(captain.employee_name)}</strong></td>
      <td>${_esc(captain.employee_id)}</td>
      <td>${captain.avg_fnv_rate !== null ? _fmt(captain.avg_fnv_rate, 1) : '—'}</td>
      <td>${_fmt(captain.total_fnv_hours, 1)} h</td>
    </tr>`).join('');

    return `<div class="table-wrapper"><table class="data-table">
      <thead><tr>
        ${_thSort('Captain', 'name', 'fnv')}
        ${_thSort('ID', 'id', 'fnv')}
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

    // Summary cards
    const totalActive = new Set(dayRows.map(r => r.employee_id)).size;
    const flaggedRows  = dayRows.filter(r => r.composite_slacker_score > 0);
    const flaggedCount = new Set(flaggedRows.map(r => r.employee_id)).size;
    const serialCount  = new Set(dayRows.filter(r => r.composite_slacker_score >= 2).map(r => r.employee_id)).size;

    const pickSlackers = new Set(dayRows.filter(r => r.flags?.get('picking_time_per_order') || r.flags?.get('assigned_to_started_per_order') || r.flags?.get('billing_time_per_order') || r.flags?.get('ppi')).map(r => r.employee_id)).size;
    const putSlackers  = new Set(dayRows.filter(r => r.flags?.get('iph')).map(r => r.employee_id)).size;

    const cardsEl = document.getElementById('flags-summary-cards');
    if (cardsEl) {
      cardsEl.innerHTML = [
        { label: 'Active Captains', value: totalActive, cls: '' },
        { label: 'Flagged Captains', value: flaggedCount, cls: 'flagged' },
        { label: 'Serial Slackers (2+)', value: serialCount, cls: 'serial' },
        { label: '📦 Picking Slackers', value: pickSlackers, cls: '' },
        { label: '📥 Putting Slackers', value: putSlackers, cls: '' },
      ].map(card => `
        <div class="summary-card ${card.cls}">
          <div class="card-value">${card.value}</div>
          <div class="card-label">${card.label}</div>
        </div>
      `).join('');
    }

    // Drill-down table — one row per flagged captain
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

    const tbody = document.getElementById('flags-table-body');
    if (!tbody) return;

    if (sortedFlagged.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#888;">
        No flagged captains on ${selectedDate}.
      </td></tr>`;
      return;
    }

    tbody.innerHTML = sortedFlagged.map(row => {
      const score = row.composite_slacker_score;
      const rowCls = score >= 2 ? 'row-serial' : 'row-flagged';
      const worstDev = row.worst_deviation !== null ? row.worst_deviation.toFixed(2) + ' SD' : '—';

      return `<tr class="${rowCls}">
        <td><strong>${_esc(row.employee_name)}</strong></td>
        <td>${_esc(row.employee_id)}</td>
        <td>${_esc(row.active_flows || '—')}</td>
        <td>${_esc(row.flagged_metrics_list || '—')}</td>
        <td>${worstDev}</td>
        <td><strong>${score}</strong></td>
      </tr>`;
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

    // Compute each captain's TOTAL active days across all data
    const activeDayMap = {};
    for (const row of data) {
      if (!row.employee_id || !row.dateStr) continue;
      if (!activeDayMap[row.employee_id]) activeDayMap[row.employee_id] = new Set();
      activeDayMap[row.employee_id].add(String(row.dateStr));
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
  }

  function _buildTiersHTML(stats, activeDayCounts) {
    const tiers = [
      { key: 'new',        label: '🟢 New',           sub: '< 30 active days',         color: '#4caf50' },
      { key: 'experienced',label: '🟡 Experienced',   sub: '30 – 120 active days',     color: '#ff9800' },
      { key: 'senior',     label: '🔵 Senior',        sub: '> 120 active days',        color: '#2196f3' },
      { key: 'blinkit',    label: '🟠 Blinkit Caps',  sub: 'GCEB (excl. GCEBOD)',      color: '#f97316' },
      { key: 'od',         label: '🔴 ODs',           sub: 'ID starts with GCEBOD',    color: '#e53935' },
    ];

    // Summary cards
    const cards = tiers.map(t => {
      const s = stats[t.key];
      return `<div class="summary-card" style="border-top:3px solid ${t.color};min-width:180px;">
        <div class="card-value" style="color:${t.color}">${s.captainCount}</div>
        <div class="card-label" style="font-size:15px;font-weight:600;">${t.label}</div>
        <div class="card-label" style="opacity:0.7;font-size:11px;">${t.sub}</div>
      </div>`;
    }).join('');

    // Helper: color-code a row of 3 values
    const colorCode = (vals, direction) => {
      const valid = vals.filter(v => v !== null);
      if (valid.length < 2) return ['', '', ''];
      const best  = direction === 'HIGH' ? Math.min(...valid) : Math.max(...valid);
      const worst = direction === 'HIGH' ? Math.max(...valid) : Math.min(...valid);
      return vals.map(v => {
        if (v === null) return '';
        if (v === best)  return 'cell-green';
        if (v === worst) return 'cell-red';
        return 'cell-yellow';
      });
    };

    const fmtDur = v => v !== null ? compute.formatDuration(v) : '—';
    const fmtNum = (v, d=1) => v !== null ? _fmt(v, d) : '—';

    const buildRow = (label, vals, direction, fmtFn) => {
      const cls = colorCode(vals, direction);
      return `<tr>
        <td style="font-weight:500">${label}</td>
        ${vals.map((v, i) => `<td class="${cls[i]}">${fmtFn(v)}</td>`).join('')}
      </tr>`;
    };

    const s = key => stats[key];

    // Ratio helper — shows "12,632 (29.4%)" for share-of-total metrics
    const withPct = (vals) => {
      const total = vals.reduce((a, v) => a + (v || 0), 0);
      return vals.map(v => v !== null && total > 0
        ? `${_fmt(v, 0)} <span style="opacity:0.65;font-size:11px;">(${((v/total)*100).toFixed(1)}%)</span>`
        : '—');
    };

    const buildRatioRow = (label, vals, direction) => {
      const cls      = colorCode(vals, direction);
      const fmtVals  = withPct(vals);
      return `<tr>
        <td style="font-weight:500">${label}</td>
        ${vals.map((v, i) => `<td class="${cls[i]}">${fmtVals[i]}</td>`).join('')}
      </tr>`;
    };

    const pickingRows = [
      buildRatioRow('Total Orders Picked', [s('new').totalOrders,   s('experienced').totalOrders,   s('senior').totalOrders,   s('blinkit').totalOrders,   s('od').totalOrders],  'LOW'),
      buildRow('Avg Picking Time/Order',[s('new').avgPickTime,      s('experienced').avgPickTime,      s('senior').avgPickTime,      s('blinkit').avgPickTime,      s('od').avgPickTime],      'HIGH', fmtDur),
      buildRow('Avg Delay to Start',    [s('new').avgDelayToStart,  s('experienced').avgDelayToStart,  s('senior').avgDelayToStart,  s('blinkit').avgDelayToStart,  s('od').avgDelayToStart],  'HIGH', fmtDur),
      buildRow('Avg Billing Time/Order',[s('new').avgBillingTime,   s('experienced').avgBillingTime,   s('senior').avgBillingTime,   s('blinkit').avgBillingTime,   s('od').avgBillingTime],   'HIGH', fmtDur),
      buildRow('Avg Total Time/Order',  [s('new').avgTotalTime,     s('experienced').avgTotalTime,     s('senior').avgTotalTime,     s('blinkit').avgTotalTime,     s('od').avgTotalTime],     'HIGH', fmtDur),
      buildRow('Avg PPI (sec/item)',     [s('new').avgPPI,           s('experienced').avgPPI,           s('senior').avgPPI,           s('blinkit').avgPPI,           s('od').avgPPI],           'HIGH', v => fmtNum(v, 2)),
    ].join('');

    const puttingRows = [
      buildRatioRow('Total Putaway Qty', [s('new').totalPutawayQty, s('experienced').totalPutawayQty, s('senior').totalPutawayQty, s('blinkit').totalPutawayQty, s('od').totalPutawayQty], 'LOW'),
      buildRow('Avg Items Put Away/Hr', [s('new').avgIPH,           s('experienced').avgIPH,           s('senior').avgIPH,           s('blinkit').avgIPH,           s('od').avgIPH],           'LOW',  v => fmtNum(v, 1)),
    ].join('');

    const overallRows = [
      buildRow('Avg Slacker Score',     [s('new').avgScore,         s('experienced').avgScore,         s('senior').avgScore,         s('blinkit').avgScore,         s('od').avgScore],         'HIGH', v => fmtNum(v, 2)),
    ].join('');

    const tableHead = `<thead><tr>
      <th>Metric</th>
      ${tiers.map(t => `<th style="color:${t.color}">${t.label}</th>`).join('')}
    </tr></thead>`;

    const section = (title, icon, rows) => `
      <div class="table-section" style="margin-bottom:24px;">
        <h3>${icon} ${title}</h3>
        <div class="table-wrapper"><table class="data-table">
          ${tableHead}<tbody>${rows}</tbody>
        </table></div>
      </div>`;

    return `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px;">${cards}</div>
      ${section('Picking Flow', '📦', pickingRows)}
      ${section('Putting Flow', '📥', puttingRows)}
      ${section('Overall Performance', '📊', overallRows)}
    `;
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

    container.innerHTML = `
      <div style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
        <strong style="font-size:16px;">${_esc(name)}</strong>
        <span style="color:#6c7a89;">ID: ${_esc(captainId)}</span>
        <span style="color:#6c7a89;">${totalDays} total active days</span>
        ${isFiltered ? `<span style="color:#4fc3f7;">Showing ${shownDays} days in range</span>` : ''}
        <span style="color:#e53935;">${flaggedDays} flagged days</span>
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
    const sheetEl = document.getElementById('config-sheet-id');
    if (sheetEl) sheetEl.textContent = CONFIG.SPREADSHEET_ID;

    const countEl = document.getElementById('config-row-count');
    if (countEl) countEl.textContent = sheets.getCached().length.toLocaleString();

    const tbody = document.getElementById('config-metrics-body');
    if (tbody) {
      tbody.innerHTML = CONFIG.METRICS.map(m => `<tr>
        <td>${m.label}</td>
        <td>${m.flow.charAt(0).toUpperCase() + m.flow.slice(1)}</td>
        <td>${m.direction === 'HIGH' ? '⬆ High = Bad' : '⬇ Low = Bad'}</td>
      </tr>`).join('');
    }

    const thresholdInput = document.getElementById('threshold-input');
    if (thresholdInput) thresholdInput.value = CONFIG.THRESHOLD;
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

  return {
    switchTab,
    renderStoreOverview,
    initDeepDivePeriods,
    renderDeepDive,
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

      // Compute stats pipeline
      _storeStats   = compute.computeStoreStats(raw);
      _personalAvgs = compute.computePersonalAvgs(raw);
      _flaggedData  = compute.flagSlackers(raw, _storeStats, _personalAvgs, CONFIG.THRESHOLD);

      // Update last-refreshed timestamp
      const ts = document.getElementById('last-refreshed');
      if (ts) ts.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;

      // Init dynamic dropdowns
      ui.initDeepDivePeriods();
      ui.initFlagsDate();
      ui.initCaptainDropdown();
      ui.initTiersView();

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
      _flaggedData = compute.flagSlackers(raw, _storeStats, _personalAvgs, CONFIG.THRESHOLD);
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
      case 'config-panel':      ui.renderConfigPanel(); break;
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
