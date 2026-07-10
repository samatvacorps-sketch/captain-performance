/**
 * deep-dive.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      periods.setDayPair('deep-dive-start', 'deep-dive-end', periodVal === 't1' ? 1 : 2);
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

    // ── Coaching list — robust, volume-gated scores (independent of the
    // summary-card filter; trend vs the preceding window of equal length) ──
    let prevRows = [];
    if (filtered.length) {
      let wS = Infinity, wE = -Infinity;
      for (const r of filtered) { if (r.date) { const t = +r.date; if (t < wS) wS = t; if (t > wE) wE = t; } }
      if (isFinite(wS)) {
        const len = (wE - wS) + 86400000;
        prevRows = data.filter(r => r.date && r.date >= wS - len && r.date < wS);
      }
    }
    const scored = compute.computeCaptainScores(filtered, prevRows, captainAuditRacks, cfg.get('scoring', null) || {});
    container.insertAdjacentHTML('beforeend', _buildCoachingCard(scored));

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

  // ── Coaching list card ────────────────────────────────────────────────
  // Top offenders by robust composite (compute.computeCaptainScores) with
  // plain-language reasons — the thing a supervisor actually acts on.
  function _buildCoachingCard(scored) {
    const candidates = [...scored.captains.values()]
      .filter(c => c.composite >= 1.5)
      .sort((a, b) => b.composite - a.composite)
      .slice(0, 5);
    const TREND = {
      worse:  '<span class="dd-coach-trend dd-trend-worse" title="composite vs preceding period">▲ worsening</span>',
      better: '<span class="dd-coach-trend dd-trend-better" title="composite vs preceding period">▼ improving</span>',
      flat:   '<span class="dd-coach-trend dd-trend-flat" title="composite vs preceding period">• steady</span>',
      na: '',
    };
    const rows = candidates.map((c, i) => `
      <div class="dd-coach-row">
        <span class="dd-coach-rank">${i + 1}</span>
        <div class="dd-coach-main">
          <div class="dd-coach-who">
            <button type="button" class="dd-coach-name" onclick="ui.openCaptain360('${_esc(c.employee_id)}')">${_esc(c.employee_name)}</button>
            <span class="dd-coach-score" title="Sum of robust z across volume-gated flows">z ${c.composite.toFixed(1)}</span>
            ${TREND[c.trend] || ''}
          </div>
          <ul class="dd-coach-reasons">${c.reasons.slice(0, 3).map(r => `<li>${_esc(r)}</li>`).join('')}</ul>
        </div>
      </div>`).join('');
    return `
      <div class="dd-coach-card">
        <div class="dd-coach-head">
          <span class="tiers-section-pip" style="background:#f59e0b"></span>
          <h3 class="tiers-section-title">Coaching List</h3>
          <span class="dd-coach-sub">volume-gated robust scores vs store median · tap a name for their 360°</span>
        </div>
        ${candidates.length ? rows : '<div class="dd-coach-clear">No captain is meaningfully behind the store this period (all gated scores under +1.5 z).</div>'}
      </div>`;
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

