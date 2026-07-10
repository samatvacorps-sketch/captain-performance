/**
 * tier-analysis.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      periods.setDayPair('tiers-start', 'tiers-end', periodVal === 't1' ? 1 : 2);
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

