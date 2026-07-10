/**
 * store-overview.js — Morning Briefing (Phase 1 rebuild).
 *
 * Layout top→bottom: SLA band with cycle pace lines → KPI cards (pooled,
 * delta chips, sparklines) → exceptions feed ("Needs attention", always
 * T-1/cycle-based regardless of the date filter) → collapsible Explore
 * charts (lazily rendered) → summary table.
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js.
 */

  // ── Store Overview ─────────────────────────────────────────────────────

  let _overviewDateMode = false;
  // Charts are visible by default (the original bento grid); the toggle only
  // hides them for users who opt out (persisted per browser).
  let _ovChartsOpen = localStorage.getItem('overviewChartsOpen') !== 'false';
  let _ovAggregated = null; // last aggregation, for lazy chart rendering

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
    periods.setFullSpan('overview-start', 'overview-end', data);
    _overviewDateMode = false;
  }

  function onOverviewPresetChange() {
    _overviewDateMode = false;
    const data = app.getFlaggedData();
    if (!data) return;
    const periodVal = document.getElementById('overview-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      periods.setDayPair('overview-start', 'overview-end', periodVal === 't1' ? 1 : 2);
      _overviewDateMode = true;
      renderStoreOverview();
      return;
    }

    if (periodVal === 'all') {
      periods.setFullSpan('overview-start', 'overview-end', data);
    } else {
      const { type, key } = periods.parsePreset(periodVal);
      if (type === 'W') {
        const rows = data.filter(row => row.date && compute.aggregateWeekly([row]).some(w => w.week_key === key));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('overview-start').value = _isoDateStr(dates[0]);
          document.getElementById('overview-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('overview-start', 'overview-end', key);
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
  // Each card carries a pace line (projected finish + the next actionable
  // step) computed via compute.projectCyclePace — same math as KM Cycle Pace.
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

    // Cycle-day bookkeeping for pace projections
    const totalDays = Math.round((new Date(cy, cm - 1, 25).setHours(0, 0, 0, 0) - new Date(cy, cm - 2, 26).setHours(0, 0, 0, 0)) / DAY) + 1;
    const elapsed = Math.min(totalDays, Math.max(0, Math.round((today.getTime() - cycleStart) / DAY)));
    const left = totalDays - elapsed;
    const canPace = elapsed >= 1 && left >= 1;
    const recent = canPace ? _kmSnapshot(Math.max(cycleStart, today.getTime() - 7 * DAY), today.getTime() - 1) : null;
    const TIER_LBL = { baseline: 'Baseline', sla1: 'SLA 1', sla2: 'SLA 2' };
    const BEST_FIRST = ['sla2', 'sla1', 'baseline'];

    // Pace line: projected finish + the best still-reachable tier's ask.
    // hintFn(tierPct, denomPlusFuture) → { ok, locked, text } for one tier.
    const paceLine = (num, den, recentPct, tiers, dir, hintFn) => {
      if (!canPace) return '';
      const p = compute.projectCyclePace(num, den, recentPct, elapsed, left);
      if (!p) return '';
      const projTier = _kmTierReached(p.projected, tiers, dir);
      let hint = '';
      for (const tk of BEST_FIRST) {
        const h = hintFn(tiers[tk], den + p.future, num, p.future);
        if (h.locked) { hint = `${TIER_LBL[tk]} locked ✓`; break; }
        if (h.ok)     { hint = `${h.text} → ${TIER_LBL[tk]}`; break; }
      }
      if (!hint) hint = 'Baseline out of reach';
      return `<div class="ov-sla-pace">Proj. <strong>${p.projected}%</strong> (${projTier.label}) · ${hint}</div>`;
    };

    const instPace = paceLine(snap.instore.met, snap.instore.denom,
      recent ? recent.instore.pct : null, targets.instore, 'high',
      (t, denFut, met, future) => {
        const reqPct = ((t / 100) * denFut - met) / future * 100;
        if (reqPct <= 0)  return { locked: true };
        if (reqPct > 100) return { ok: false };
        return { ok: true, text: `needs ≥${reqPct.toFixed(1)}%/day` };
      });
    const complPace = paceLine(snap.compl.items, snap.compl.orders,
      recent ? recent.compl.pct : null, targets.complaints, 'low',
      (t, denFut, items) => {
        const allowed = Math.floor((t / 100) * denFut - items);
        if (allowed < 0) return { ok: false };
        return { ok: true, text: `room for ${_fmt(allowed)} more` };
      });
    const fillPace = (snap.fill && snap.fill.checkoutOrders > 0)
      ? paceLine(snap.fill.inFull, snap.fill.checkoutOrders,
          recent && recent.fill ? recent.fill.pct : null, targets.fillrate, 'high',
          (t, denFut) => {
            const allowed = Math.floor((1 - t / 100) * denFut - snap.fill.affected);
            if (allowed < 0) return { ok: false };
            return { ok: true, text: `room for ${_fmt(allowed)} shorts` };
          })
      : '';

    const card = (title, value, tiers, direction, ydayPct, foot, paceHtml) => {
      const r = _kmTierReached(value, tiers, direction);
      return `
        <button type="button" class="ov-sla-card ${r.cls}" onclick="app.switchTab('key-metrics')">
          <div class="ov-sla-head"><span class="ov-sla-title">${title}</span><span class="km-score-badge">${r.label}</span></div>
          <div class="ov-sla-value">${value != null ? value + '%' : '—'}</div>
          <div class="ov-sla-foot">${foot}</div>
          ${paceHtml || ''}
          <div class="ov-sla-yday">T-1: <strong>${ydayPct != null ? ydayPct + '%' : '—'}</strong> · SLA 2 at ${tiers.sla2}%</div>
        </button>`;
    };

    el.innerHTML = `
      <div class="ov-sla-band-head">
        <span class="ov-sla-band-title">SLA Position — ${_billingMonthLabel(cycleKey)}${canPace ? ` · day ${elapsed} of ${totalDays}` : ''}</span>
        <span class="ov-sla-band-hint">cycle to date · tap a card for the full breakdown</span>
      </div>
      <div class="ov-sla-grid">
        ${card('In-Store Time', snap.instore.pct, targets.instore, 'high', yday.instore.pct,
          `${_fmt(snap.instore.met)} / ${_fmt(snap.instore.denom)} orders ≤ 2.5 min (IPO ≤ 6)`, instPace)}
        ${card('Complaints', snap.compl.pct, targets.complaints, 'low', yday.compl.pct,
          `${_fmt(snap.compl.items)} qualifying items · ${_fmt(snap.compl.orders)} orders`, complPace)}
        ${_ovFillRateCard(card, snap, yday, targets, fillPace)}
      </div>`;
  }

  // Fill Rate card for the Store Overview SLA band. Uses the shared `card`
  // builder when PNA / missing data exists for the cycle, else a placeholder.
  function _ovFillRateCard(card, snap, yday, targets, paceHtml = '') {
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
      `${_fmt(fill.inFull)} / ${_fmt(fill.checkoutOrders)} in full · ${_fmt(fill.affected)} short`, paceHtml);
  }

  // ── KPI cards ──────────────────────────────────────────────────────
  // Pooled window values (computeWindowKpis) with delta chips vs the
  // preceding window of equal length and inline SVG sparklines by day.

  // Generic delta chip for counts/durations (the KM one is %-specific).
  function _ovDeltaChip(cur, prev, direction, fmtFn) {
    if (cur == null || prev == null || isNaN(cur) || isNaN(prev) || prev === 0) return '';
    const d = cur - prev;
    if (Math.abs(d) < 1e-9) return `<span class="km-delta-chip km-delta-flat">• 0</span>`;
    const improved = direction === 'high' ? d > 0 : d < 0;
    const cls = improved ? 'km-delta-good' : 'km-delta-bad';
    const arrow = d > 0 ? '▲' : '▼';
    return `<span class="km-delta-chip ${cls}" title="vs preceding period: ${fmtFn(prev)}">${arrow} ${fmtFn(Math.abs(d))}</span>`;
  }

  // Inline SVG sparkline (no Chart.js instance). Hidden under 3 points.
  function _svgSparkline(values, color) {
    const pts = (values || []).filter(v => v != null && !isNaN(v));
    if (pts.length < 3) return '';
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const W = 96, H = 26, PAD = 2;
    const step = (W - PAD * 2) / (pts.length - 1);
    const xy = pts.map((v, i) => [PAD + i * step, H - PAD - ((v - min) / span) * (H - PAD * 2)]);
    const line = xy.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const last = xy[xy.length - 1];
    return `<svg class="stat-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2" fill="${color}"/>
    </svg>`;
  }

  function _renderOverviewKpis(filtered, allRows, startMs, endMs, filteredCompl, allCompl) {
    const el = document.getElementById('overview-kpi-row');
    if (!el) return;

    const kpis = compute.computeWindowKpis(filtered);
    const complaints = filteredCompl.length;

    // Preceding window of equal length
    let prevKpis = null, prevCompl = null;
    if (isFinite(startMs) && isFinite(endMs)) {
      const len = endMs - startMs + 1;
      const pS = startMs - len, pE = startMs - 1;
      prevKpis = compute.computeWindowKpis(allRows.filter(r => r.date && r.date >= pS && r.date <= pE));
      prevCompl = allCompl.filter(r => r.date && r.date >= pS && r.date <= pE).length;
    }

    // Daily series for sparklines (last 30 days of the window)
    const byDay = new Map(); // iso → { orders, tSum, tOrd, qty, putSec, compl }
    for (const r of filtered) {
      if (!r.dateIsoStr) continue;
      let e = byDay.get(r.dateIsoStr);
      if (!e) { e = { orders: 0, tSum: 0, tOrd: 0, qty: 0, putSec: 0, compl: 0 }; byDay.set(r.dateIsoStr, e); }
      e.orders += r.checkout_orders || 0;
      if (r.picker_active_time > 0 && r.total_time_per_order > 0 && r.checkout_orders > 0) {
        e.tSum += r.total_time_per_order * r.checkout_orders;
        e.tOrd += r.checkout_orders;
      }
      if (r.putter_active_time > 0) { e.qty += r.putaway_qty || 0; e.putSec += r.putter_active_time; }
    }
    for (const r of filteredCompl) {
      if (!r.dateStr) continue;
      const e = byDay.get(r.dateStr);
      if (e) e.compl++;
    }
    const days = [...byDay.keys()].sort().slice(-30);
    const series = {
      orders: days.map(k => byDay.get(k).orders),
      time:   days.map(k => (byDay.get(k).tOrd > 0 ? byDay.get(k).tSum / byDay.get(k).tOrd : null)),
      iph:    days.map(k => (byDay.get(k).putSec > 0 ? byDay.get(k).qty / (byDay.get(k).putSec / 3600) : null)),
      compl:  days.map(k => byDay.get(k).compl),
    };

    const fmtInt = v => Math.round(v).toLocaleString();
    const fmtDur = v => compute.formatDuration(v);
    const fmt1   = v => (+v).toFixed(1);

    const cardHtml = (iconSvg, iconCls, label, value, delta, spark) => `
      <div class="stat-card">
        <div class="stat-icon ${iconCls}">${iconSvg}</div>
        <div class="stat-body">
          <p class="stat-label">${label}</p>
          <p class="stat-value">${value}${delta ? ` ${delta}` : ''}</p>
          ${spark}
        </div>
      </div>`;

    const I = {
      box: '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5L8 2l6 3.5v6L8 14 2 11.5z"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="5.5" x2="14" y2="5.5"/></svg>',
      clock: '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10.5,10"/></svg>',
      bars: '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="9" width="3" height="6" rx="0.5"/><rect x="6.5" y="5" width="3" height="10" rx="0.5"/><rect x="11.5" y="2" width="3" height="13" rx="0.5"/></svg>',
      warn: '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L1.5 13.5h13z"/><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>',
    };

    el.innerHTML = [
      cardHtml(I.box, 'stat-icon-blue', 'Total Orders Picked',
        kpis.totalOrders.toLocaleString(),
        _ovDeltaChip(kpis.totalOrders, prevKpis ? prevKpis.totalOrders : null, 'high', fmtInt),
        _svgSparkline(series.orders, '#60a5fa')),
      cardHtml(I.clock, 'stat-icon-green', 'Avg Total Time / Order',
        compute.formatDuration(kpis.avgTotalTimePerOrder),
        _ovDeltaChip(kpis.avgTotalTimePerOrder, prevKpis ? prevKpis.avgTotalTimePerOrder : null, 'low', fmtDur),
        _svgSparkline(series.time, '#4edea3')),
      cardHtml(I.bars, 'stat-icon-teal', 'Items Put Away / Hr',
        kpis.pooledIph.toFixed(1),
        _ovDeltaChip(kpis.pooledIph, prevKpis ? prevKpis.pooledIph : null, 'high', fmt1),
        _svgSparkline(series.iph, '#2dd4bf')),
      cardHtml(I.warn, 'stat-icon-red', 'Complaints',
        complaints.toLocaleString(),
        _ovDeltaChip(complaints, prevCompl, 'low', fmtInt),
        _svgSparkline(series.compl, '#ff6b6b')),
    ].join('');
  }

  // ── Exceptions feed ────────────────────────────────────────────────
  // "Needs attention" — always computed from T-1 and the current cycle,
  // independent of the tab's date filter. Every row click-throughs to the
  // tab where the problem can be worked.
  function _renderOverviewExceptions() {
    const el = document.getElementById('overview-exceptions');
    if (!el) return;
    const exc = [];
    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yS = today.getTime() - DAY, yE = today.getTime() - 1;
    const ydayIso = _isoDateStr(new Date(yS));
    const cycleKey = _billingCycleKeyOf(new Date());
    const targets = _getSlaTargets(cycleKey);

    // 1. Cycle pace risks (below baseline = critical; slipping a tier = warn)
    const [cy, cm] = cycleKey.split('-').map(Number);
    const cycleStart = new Date(cy, cm - 2, 26).getTime();
    const totalDays = Math.round((new Date(cy, cm - 1, 25).setHours(0, 0, 0, 0) - new Date(cy, cm - 2, 26).setHours(0, 0, 0, 0)) / DAY) + 1;
    const elapsed = Math.min(totalDays, Math.max(0, Math.round((today.getTime() - cycleStart) / DAY)));
    const left = totalDays - elapsed;
    if (elapsed >= 2 && left >= 1) {
      const snap = _kmSnapshot(cycleStart, Date.now());
      const recent = _kmSnapshot(Math.max(cycleStart, today.getTime() - 7 * DAY), today.getTime() - 1);
      const RANK = { below: 0, baseline: 1, sla1: 2, sla2: 3, na: -1 };
      const checks = [
        ['In-Store Time', snap.instore.met, snap.instore.denom, recent.instore.pct, targets.instore, 'high'],
        ['Complaints', snap.compl.items, snap.compl.orders, recent.compl.pct, targets.complaints, 'low'],
        ['Fill Rate', snap.fill ? snap.fill.inFull : 0, snap.fill ? snap.fill.checkoutOrders : 0,
          recent.fill ? recent.fill.pct : null, targets.fillrate, 'high'],
      ];
      for (const [name, num, den, recentPct, tiers, dir] of checks) {
        if (!den) continue;
        const p = compute.projectCyclePace(num, den, recentPct, elapsed, left);
        if (!p) continue;
        const projTier = _kmTierReached(p.projected, tiers, dir);
        const curTier = _kmTierReached(+(num / den * 100).toFixed(2), tiers, dir);
        if (projTier.tier === 'below') {
          exc.push({ sev: 'crit', tab: 'key-metrics', html: `<strong>${name}</strong> pacing below Baseline — projected ${p.projected}% at last-7-day form (${p.recentPct}%)` });
        } else if (RANK[projTier.tier] < RANK[curTier.tier]) {
          exc.push({ sev: 'warn', tab: 'key-metrics', html: `<strong>${name}</strong> on pace to slip from ${curTier.label} to ${projTier.label} — projected ${p.projected}%` });
        }
      }
    }

    // 2. Worst hour yesterday (in-store SLA population, ≥10 orders in the hour)
    const inst = _supervisorFilter(sheets.getInstoreCached() || []);
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP, TH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const yRows = inst.filter(r => r.date >= yS && r.date <= yE && r.ipo > 0 && r.ipo <= CAP);
    if (yRows.length) {
      const byHour = new Map();
      for (const r of yRows) {
        if (r.hour === null || r.hour === undefined) continue;
        const e = byHour.get(r.hour) || { d: 0, m: 0 };
        e.d++;
        if (r.instore_seconds > 0 && r.instore_seconds <= TH) e.m++;
        byHour.set(r.hour, e);
      }
      let worst = null;
      for (const [h, e] of byHour) {
        if (e.d < 10) continue;
        const pct = e.m / e.d * 100;
        if (!worst || pct < worst.pct) worst = { h, pct, d: e.d };
      }
      if (worst && worst.pct < targets.instore.baseline) {
        exc.push({ sev: 'warn', tab: 'key-metrics', html: `Worst hour yesterday: <strong>${String(worst.h).padStart(2, '0')}:00</strong> — ${worst.pct.toFixed(0)}% of ${worst.d} orders within 2.5 min (baseline ${targets.instore.baseline}%)` });
      }
    }

    // 3. Complaint spike yesterday vs trailing 14-day average (Poisson-ish band)
    const qCompl = _supervisorFilter(sheets.getComplaintsCached() || []).filter(r => _isQualifyingComplaint(r.complaint_category));
    const trailPerDay = qCompl.filter(r => r.date >= yS - 14 * DAY && r.date < yS).length / 14;
    const yCompl = qCompl.filter(r => r.date >= yS && r.date <= yE).length;
    if (yCompl >= 3 && yCompl > trailPerDay + 2 * Math.sqrt(Math.max(trailPerDay, 1))) {
      exc.push({ sev: yCompl > trailPerDay * 2 ? 'crit' : 'warn', tab: 'complaints-deep-dive', html: `Complaint spike yesterday: <strong>${yCompl}</strong> qualifying items vs ~${trailPerDay.toFixed(1)}/day trailing average` });
    }

    // 4. Captains flagged yesterday (2+ metrics)
    const flaggedY = (app.getFlaggedData() || [])
      .filter(r => r.dateIsoStr === ydayIso && r.composite_slacker_score >= 2)
      .sort((a, b) => b.composite_slacker_score - a.composite_slacker_score);
    if (flaggedY.length) {
      const names = flaggedY.slice(0, 3).map(r => `${_esc(r.employee_name)} (${r.composite_slacker_score})`).join(', ');
      exc.push({ sev: 'warn', tab: 'captain-deep-dive', t1: true, html: `${flaggedY.length} captain${flaggedY.length === 1 ? '' : 's'} flagged yesterday: ${names}` });
    }

    // 5. Zero-output shifts yesterday (≥30 min logged, nothing produced)
    const zeroY = (app.getFlaggedData() || []).filter(r => r.dateIsoStr === ydayIso && (
      (r.putter_active_time > 1800 && !r.putaway_qty) ||
      (r.auditor_active_time > 1800 && !r.racks_audited)));
    if (zeroY.length) {
      const names = zeroY.slice(0, 3).map(r => _esc(r.employee_name)).join(', ');
      exc.push({ sev: 'info', tab: 'captain-deep-dive', t1: true, html: `${zeroY.length} shift${zeroY.length === 1 ? '' : 's'} yesterday logged time with zero output: ${names}` });
    }

    const SEV_CLS = { crit: 'ov-exc-crit', warn: 'ov-exc-warn', info: 'ov-exc-info' };
    el.innerHTML = `
      <div class="ov-exc-head">Needs attention</div>
      ${exc.length
        ? exc.map((e, i) => `<button type="button" class="ov-exc-row ${SEV_CLS[e.sev]}" data-exc="${i}"><span class="ov-exc-pip"></span><span class="ov-exc-text">${e.html}</span><span class="ov-exc-go">›</span></button>`).join('')
        : '<div class="ov-exc-clear">All clear — nothing unusual in yesterday’s data or the cycle pace.</div>'}
    `;
    el.querySelectorAll('.ov-exc-row').forEach(btn => btn.addEventListener('click', () => {
      const e = exc[+btn.dataset.exc];
      if (!e) return;
      if (e.t1 && e.tab === 'captain-deep-dive') jumpDeepDiveT1();
      else app.switchTab(e.tab);
    }));
  }

  /** Open Captain Deep Dive pinned to yesterday (used by exception rows). */
  function jumpDeepDiveT1() {
    app.switchTab('captain-deep-dive');
    const sel = document.getElementById('deep-dive-period');
    if (sel) {
      sel.value = 't1';
      onDeepDivePresetChange();
    }
  }

  // ── Explore charts (collapsible, lazily rendered) ──────────────────

  function toggleOverviewCharts() {
    _ovChartsOpen = !_ovChartsOpen;
    localStorage.setItem('overviewChartsOpen', String(_ovChartsOpen));
    _syncOverviewChartsUI();
    if (_ovChartsOpen && _ovAggregated) _renderOverviewCharts(_ovAggregated);
  }

  function _syncOverviewChartsUI() {
    const wrap = document.getElementById('overview-charts-wrap');
    const btn = document.getElementById('overview-charts-toggle');
    if (wrap) wrap.classList.toggle('hidden', !_ovChartsOpen);
    if (btn) btn.textContent = _ovChartsOpen ? 'Hide charts ▾' : 'Show charts ▸';
  }

  function _renderOverviewCharts(aggregated) {
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
    _ovAggregated = aggregated;

    // KPI cards + exceptions feed
    _renderOverviewKpis(filtered, data, startMs, endMs, filteredCompl, complaintsData);
    _renderOverviewExceptions();

    // Charts render only while the Explore section is open
    _syncOverviewChartsUI();
    if (_ovChartsOpen) _renderOverviewCharts(aggregated);

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
