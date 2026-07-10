/**
 * incentives.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      const slabOverride = _getSlabOverride(monthKey);
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
      ${_buildIncentiveNudges(picking, audit, monthKey)}
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


  // ── Near-miss nudges (Phase 3) ─────────────────────────────────────────
  // "Who is within reach of the next slab RIGHT NOW" — only rendered for the
  // current calendar month while its current week / month is still open.
  // This is the mid-week push list for supervisors.
  function _buildIncentiveNudges(picking, audit, monthKey) {
    const now = new Date();
    const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (monthKey !== curMonthKey) return '';

    const DAY = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // Effective slabs for the month (sheet/local override > defaults)
    const ov = _getSlabOverride(monthKey) || {};
    const slabs400 = ov.slabs400 || compute.PICKING_SLABS_400;
    const slabs800 = ov.slabs800 || compute.PICKING_SLABS_800;
    const th400 = ov.threshold400 || 400;
    const th800 = ov.threshold800 || 800;
    const slabAmount = (t, slabs) => { for (const s of slabs) if (t < s.maxTime) return s.amount; return 0; };

    // Current ISO week (if it belongs to this incentive month)
    let curWeek = null, weekDaysLeft = 0;
    for (const wk of compute.getWeekKeysForMonth([{ date: today }], monthKey).length
         ? compute.getWeekKeysForMonth([{ date: today }], monthKey) : []) {
      const mon = compute.weekStartFromKey(wk);
      const sun = new Date(mon.getTime() + 6 * DAY);
      if (today >= mon && today <= sun) {
        curWeek = wk;
        weekDaysLeft = Math.round((sun - today) / DAY) + 1;
      }
    }

    const nudges = [];

    if (curWeek) {
      for (const [empId, cap] of picking) {
        const w = cap.weeks.get(curWeek);
        if (!w || w.orders <= 0 || w.avgTime <= 0) continue;
        const t = w.avgTime;

        if (w.orders < th400) {
          // Not yet in the band — worth pushing only if their pace would pay
          const wouldEarn = slabAmount(t, slabs400);
          const need = th400 - w.orders;
          if (wouldEarn > 0 && need <= th400 * 0.5) {
            nudges.push({ empId, name: cap.employee_name, gain: wouldEarn,
              text: `${_fmt(need)} more orders this week (has ${_fmt(w.orders)}) unlocks ₹${wouldEarn} at current pace (${compute.formatDuration(t)}/order)` });
          }
          continue;
        }

        const slabs = w.orders >= th800 ? slabs800 : slabs400;
        const curAmt = slabAmount(t, slabs);
        // Next better slab: last slab whose maxTime is below (or at) current time
        const curIdx = slabs.findIndex(s => t < s.maxTime);
        const target = curIdx === -1 ? slabs[slabs.length - 1] : (curIdx > 0 ? slabs[curIdx - 1] : null);
        if (target) {
          const cutSec = Math.ceil(t - (target.maxTime - 1));
          if (cutSec > 0 && cutSec <= 15) {
            nudges.push({ empId, name: cap.employee_name, gain: target.amount - curAmt,
              text: `cut avg by ${cutSec}s (now ${compute.formatDuration(t)}/order, ${_fmt(w.orders)} orders) → ₹${target.amount}${curAmt ? ` instead of ₹${curAmt}` : ''}` });
          }
        }
        // 800-band upgrade
        if (w.orders >= th800 * 0.8 && w.orders < th800) {
          const upAmt = slabAmount(t, slabs800);
          if (upAmt > curAmt) {
            nudges.push({ empId, name: cap.employee_name, gain: upAmt - curAmt,
              text: `${_fmt(th800 - w.orders)} more orders reaches the ${_fmt(th800)}+ band → ₹${upAmt} instead of ₹${curAmt}` });
          }
        }
      }
    }

    // Audit tier nudges (month-to-date racks near the ₹40/₹50 boundaries)
    for (const [empId, aud] of audit) {
      const r = aud.totalRacks;
      if (r >= 100) continue;
      const boundary = r < 40 ? 40 : r < 80 ? 80 : null;
      if (!boundary) continue;
      const need = boundary - r;
      if (need <= 12 && r >= boundary - 15) {
        const rate = boundary === 40 ? 40 : 50;
        nudges.push({ empId, name: aud.employee_name, gain: rate * need,
          text: `${need} more rack${need === 1 ? '' : 's'} this month (has ${r}) moves them into the ₹${rate}/rack tier` });
      }
    }

    if (!nudges.length) return '';
    nudges.sort((a, b) => b.gain - a.gain);
    const rows = nudges.slice(0, 6).map(n => `
      <div class="inc-nudge-row">
        <button type="button" class="dd-coach-name" onclick="ui.openCaptain360('${_esc(n.empId)}')">${_esc(n.name)}</button>
        <span class="inc-nudge-text">${n.text}</span>
        <span class="inc-nudge-gain">+₹${_fmt(n.gain)}</span>
      </div>`).join('');
    return `
      <div class="inc-nudge-card">
        <div class="dd-coach-head"><span class="tiers-section-pip" style="background:#4edea3"></span>
          <h3 class="tiers-section-title">Nudges — within reach right now</h3>
          <span class="dd-coach-sub">${curWeek ? `current week · ${weekDaysLeft} day${weekDaysLeft === 1 ? '' : 's'} left` : 'month to date'} · tell them today</span></div>
        ${rows}
      </div>`;
  }

  // ── Payroll CSV export (Phase 3) ───────────────────────────────────────
  // Full payout register for the selected month: weekly picking, audit,
  // attendance bonus (with eligibility + reason), grand total per captain.
  function exportIncentivesCsv() {
    const monthKey = document.getElementById('incentive-month')?.value;
    if (!monthKey) return;
    if (!_incentiveCache) renderIncentives();
    if (!_incentiveCache) return;
    const { weekKeys, picking, audit } = _incentiveCache;
    const bonus = compute.computeAttendanceBonus(
      _supervisorFilter(sheets.getCached()), sheets.getRosterCached(), monthKey, _getAttendanceOverrides());

    const ids = [...new Set([...picking.keys(), ...audit.keys(), ...bonus.keys()])].sort();
    const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const header = ['employee_id', 'name',
      ...weekKeys.flatMap(wk => [`${wk}_orders`, `${wk}_avg_sec_per_order`, `${wk}_picking_inr`]),
      'picking_total_inr', 'audit_racks', 'audit_payable_racks', 'audit_inr',
      'attendance_bonus_inr', 'attendance_eligible', 'attendance_reason', 'grand_total_inr'];
    const lines = [header.join(',')];
    let gp = 0, ga = 0, gb = 0;
    for (const id of ids) {
      const p = picking.get(id), a = audit.get(id), b = bonus.get(id);
      const name = p?.employee_name || a?.employee_name || b?.employee_name || id;
      const weekCells = weekKeys.flatMap(wk => {
        const w = p?.weeks.get(wk);
        return w ? [w.orders, Math.round(w.avgTime), w.amount] : ['', '', ''];
      });
      const pT = p?.total || 0, aT = a?.amount || 0, bT = b?.bonus_amount || 0;
      gp += pT; ga += aT; gb += bT;
      lines.push([id, esc(name), ...weekCells, pT,
        a?.totalRacks ?? '', a?.payableRacks ?? '', aT,
        bT, b ? (b.eligible ? 'yes' : 'no') : '', esc(b?.reason || ''), pT + aT + bT].join(','));
    }
    lines.push(['TOTAL', '', ...weekKeys.flatMap(() => ['', '', '']), gp, '', '', ga, gb, '', '', gp + ga + gb].join(','));

    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = `incentives-${monthKey}.csv`;
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
