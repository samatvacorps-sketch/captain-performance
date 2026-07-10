/**
 * inventory-health.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      periods.setDayPair('inv-start', 'inv-end', periodVal === 't1' ? 1 : 2);
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

      <!-- Coverage vs master rack list + stale-rack queue (Phase 4) -->
      <div id="inv-coverage"></div>

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

      // Coverage vs master rack list + stale-rack queue
      _renderRackCoverage(filteredAudit, auditData);
    }, 0);
  }

  // ── Coverage & staleness vs the master rack list (Phase 4) ────────────
  // Master list = `Racks` tab (col A) in the main sheet. Coverage uses the
  // selected window; staleness uses ALL audit history (a rack audited before
  // the window isn't "never audited", just stale).
  function _renderRackCoverage(filteredAudit, allAudit) {
    const el = document.getElementById('inv-coverage');
    if (!el) return;
    const master = sheets.getRackListCached();
    if (!master || master.length === 0) {
      el.innerHTML = `<p class="config-hint" style="margin:-6px 0 16px">Add a <strong>Racks</strong> tab to the main sheet (column A = every rack code, header <code>rack_code</code>) to unlock true coverage % and the stale-rack queue.</p>`;
      return;
    }

    const DAY = 86400000;
    const staleDays = cfg.get('inventory.staleDays', 30);
    const masterSet = new Set(master);

    // Window coverage
    const auditedWin = new Set();
    for (const r of filteredAudit) {
      for (const c of r.audit_codes) {
        const u = String(c).trim().toUpperCase();
        if (masterSet.has(u)) auditedWin.add(u);
      }
    }
    const coveragePct = (auditedWin.size / master.length * 100).toFixed(1);

    // All-time last-audited per master rack
    const last = new Map();
    for (const r of allAudit) {
      if (!r.date) continue;
      for (const c of r.audit_codes) {
        const u = String(c).trim().toUpperCase();
        if (!masterSet.has(u)) continue;
        const cur = last.get(u);
        if (!cur || r.date > cur) last.set(u, r.date);
      }
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const NEVER = 999999;
    const staleList = master
      .map(code => {
        const d = last.get(code) || null;
        const days = d ? Math.floor((today - d) / DAY) : NEVER;
        return { code, last: d, days };
      })
      .filter(r => r.days >= staleDays)
      .sort((a, b) => b.days - a.days);
    const never = staleList.filter(r => r.days === NEVER).length;
    const stale = staleList.length - never;

    const queueRows = staleList.slice(0, 30).map(r => {
      const parts = r.code.split('-');
      return `<tr>
        <td><strong>${_esc(r.code)}</strong></td>
        <td>${_esc(parts[0] || '—')}</td>
        <td>${_esc(parts[1] || '—')}</td>
        <td>${r.last ? _isoDateStr(r.last) : '<span class="cell-red">never</span>'}</td>
        <td class="${r.days === NEVER ? 'cell-dark-red' : r.days >= staleDays * 2 ? 'cell-red' : 'cell-yellow'}">${r.days === NEVER ? '—' : r.days + 'd'}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="inv-section" style="margin-bottom:20px;">
        <div class="tiers-section-header" style="margin-bottom:14px;">
          <div class="tiers-section-pip" style="background:#f59e0b"></div>
          <h3 class="tiers-section-title">Coverage vs Master List</h3>
          <span class="dd-coach-sub">${_fmt(master.length)} racks on the master list · stale = ${staleDays}+ days since last audit</span>
        </div>
        <div class="stat-cards-row">
          ${_invStatCard(ICONS.check, coveragePct >= 80 ? 'stat-icon-green' : 'stat-icon-amber', 'Window Coverage', coveragePct + '%')}
          ${_invStatCard(ICONS.alertTriangle, 'stat-icon-red', `Stale (${staleDays}+ days)`, _fmt(stale))}
          ${_invStatCard(ICONS.layers, 'stat-icon-purple', 'Never Audited', _fmt(never))}
          ${_invStatCard(ICONS.flowAudit, 'stat-icon-blue', 'Audited This Window', _fmt(auditedWin.size))}
        </div>
        ${staleList.length ? `
          <div class="table-wrapper" style="margin-top:4px;">
            <table class="data-table">
              <thead><tr><th>Rack</th><th>Floor</th><th>Aisle</th><th>Last Audited</th><th>Age</th></tr></thead>
              <tbody>${queueRows}</tbody>
            </table>
          </div>
          ${staleList.length > 30 ? `<p class="attendance-hint" style="margin-top:8px">…and ${_fmt(staleList.length - 30)} more stale racks. This queue is tomorrow's audit plan.</p>` : ''}
        ` : '<p class="attendance-hint">Every master rack audited within the stale window — clean sheet.</p>'}
      </div>`;
    _initTableSort(el.querySelector('.data-table'));
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

