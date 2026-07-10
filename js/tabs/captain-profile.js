/**
 * captain-profile.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      periods.setDayPair('profile-start', 'profile-end', periodVal === 't1' ? 1 : 2);
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

    // 360° summary — single-captain view only (SLA contribution, month-to-
    // date incentives, coaching signals). Compare mode keeps the lean layout.
    const c360HTML = isMulti ? '' : _build360Section(captainData[0], startMs, endMs);

    container.innerHTML = heroHTML + c360HTML + '<div class="profile-metric-grid" id="profile-metric-grid"></div>';

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


  // ── Captain 360° (Phase 2) ─────────────────────────────────────────────

  /**
   * Drill-through entry point: any captain name in the dashboard opens this
   * captain's profile with the 360° summary. Replaces the current selection.
   */
  function openCaptain360(empId) {
    const data = app.getFlaggedData() || [];
    const row = data.find(r => r.employee_id === empId);
    const name = row ? row.employee_name : empId;
    _selectedCaptains = [{ id: empId, name, color: _CAPTAIN_COLORS[0] }];
    _renderCaptainChips();
    app.switchTab('captain-profile');
  }

  /**
   * 360° summary for a single captain over the profile's date window:
   * in-store SLA contribution vs store, qualifying complaints + rate, PNA
   * involvement (fill rate), month-to-date incentives (calendar month —
   * policy), and coaching signals from the robust scorer.
   */
  function _build360Section(captain, startMs, endMs) {
    const id = captain.id;
    const inWin = r => r.date && r.date >= startMs && r.date <= endMs;

    // In-store SLA — captain vs store over the same window
    const instAll = _supervisorFilter(sheets.getInstoreCached() || []).filter(inWin);
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP, TH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const pop  = instAll.filter(r => r.ipo > 0 && r.ipo <= CAP);
    const mine = pop.filter(r => r.employee_id === id);
    const metOf = rows => rows.filter(r => r.instore_seconds > 0 && r.instore_seconds <= TH).length;
    const myMet = metOf(mine);
    const myPct = mine.length ? +(myMet / mine.length * 100).toFixed(1) : null;
    const storePct = pop.length ? +(metOf(pop) / pop.length * 100).toFixed(1) : null;

    // Qualifying complaints attributed to this captain
    const qCompl = _supervisorFilter(sheets.getComplaintsCached() || [])
      .filter(r => inWin(r) && _isQualifyingComplaint(r.complaint_category));
    const myCompl = qCompl.filter(r => r.employee_id === id).length;
    const myOrders = (app.getFlaggedData() || [])
      .filter(r => inWin(r) && r.employee_id === id)
      .reduce((s, r) => s + (r.checkout_orders || 0), 0);
    const complRate = myOrders > 0 ? +(myCompl / myOrders * 100).toFixed(2) : null;

    // PNA involvement (fill-rate)
    const myPna = _supervisorFilter(sheets.getPnaCached() || []).filter(r => inWin(r) && r.employee_id === id);
    const pnaOrders = new Set(myPna.map(r => r.order_id)).size;

    // Month-to-date incentives (calendar month, by policy)
    const _now = new Date();
    const monthKey = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}`;
    const flaggedAll = app.getFlaggedData() || [];
    const weekKeys = compute.getWeekKeysForMonth(flaggedAll, monthKey);
    const picking = compute.computePickingIncentives(flaggedAll, weekKeys, _getSlabOverride(monthKey)).get(id);
    const audit = compute.computeAuditIncentives(_supervisorFilter(sheets.getAuditCached() || []), monthKey).get(id);
    const bonus = compute.computeAttendanceBonus(sheets.getCached(), sheets.getRosterCached(), monthKey, _getAttendanceOverrides()).get(id);
    const inr = v => '₹' + (v || 0).toLocaleString('en-IN');
    const incTotal = (picking?.total || 0) + (audit?.amount || 0) + (bonus?.bonus_amount || 0);

    // Coaching signals over the window (robust, volume-gated)
    const winRows = flaggedAll.filter(inWin);
    const me = compute.computeCaptainScores(winRows, null, null, cfg.get('scoring', null) || {}).captains.get(id);

    const mini = (label, value, sub) => `
      <div class="p360-card">
        <div class="p360-label">${label}</div>
        <div class="p360-value">${value}</div>
        <div class="p360-sub">${sub}</div>
      </div>`;

    return `
      <div class="p360-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#60a5fa"></span>
          <h3 class="tiers-section-title">Captain 360°</h3>
          <span class="dd-coach-sub">selected window · incentives are month-to-date (${monthKey})</span></div>
        <div class="p360-grid">
          ${mini('In-Store SLA', myPct != null ? myPct + '%' : '—',
            mine.length ? `${_fmt(myMet)}/${_fmt(mine.length)} orders ≤ 2.5 min · store ${storePct != null ? storePct + '%' : '—'}` : 'no in-store orders in window')}
          ${mini('Complaints', myCompl,
            complRate != null ? `${complRate}% of ${_fmt(myOrders)} orders picked` : 'no orders in window')}
          ${mini('PNA Involvement', pnaOrders,
            `${myPna.length} PNA line${myPna.length === 1 ? '' : 's'} · counts against fill rate`)}
          ${mini('Incentives MTD', inr(incTotal),
            `picking ${inr(picking?.total)} · audit ${inr(audit?.amount)} · attendance ${inr(bonus?.bonus_amount)}${bonus && !bonus.eligible ? ` (${_esc(bonus.reason)})` : ''}`)}
        </div>
        ${me && me.composite >= 1.5 ? `
          <div class="p360-flags"><strong>Coaching signals (z ${me.composite.toFixed(1)}):</strong>
            <ul>${me.reasons.map(r => `<li>${_esc(r)}</li>`).join('')}</ul></div>` : ''}
      </div>`;
  }
