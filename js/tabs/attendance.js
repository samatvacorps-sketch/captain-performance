/**
 * attendance.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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
      _renderShiftAdherence(monthKey);
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
      _renderShiftAdherence(monthKey);
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
          <td class="attendance-total-cell attendance-reason-col ${row.bonus?.eligible ? 'attendance-bonus-ok' : 'attendance-bonus-blocked'}"
              title="${row.bonus ? _esc(`Offs ${row.bonus.actual_offs} of ${row.bonus.allowed_offs} allowed · FT ${row.bonus.ft_days}d / PT ${row.bonus.pt_days}d · active ${row.bonus.active_days}d${row.bonus.missing_type_days ? ` · ${row.bonus.missing_type_days}d missing FT/PT type` : ''}`) : ''}">${_esc(row.bonus?.reason || '—')}</td>
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
    _renderShiftAdherence(monthKey);
  }

  // ── Shift adherence (Phase 3) ─────────────────────────────────────────
  // Rostered start time (Roster col E) vs first in-store activity per
  // captain-day. Measures pickers only (in-store feed); days without picks
  // and ±6h outliers (probable shift-record mismatches) are excluded.

  function _adherenceShiftStartMin(value) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim();
    if (/^-?\d*\.?\d+$/.test(s)) {
      const n = parseFloat(s);
      if (isNaN(n) || n < 0) return null;
      return Math.round((n % 1) * 1440); // day fraction (works for full serials too)
    }
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) return (+m[1]) * 60 + (+m[2]);
    return null;
  }

  function _adherenceRosterEntry(rows, date) {
    // Most recent effective-dated roster row on/before `date` (same rule as
    // compute's attendance logic; effective date lives in the `start` field).
    const target = _dateOnly(date).getTime();
    let best = null, bestStart = -Infinity;
    for (const row of rows || []) {
      const start = _rosterDate(row.start);
      if (!start) continue;
      const startMs = _dateOnly(start).getTime();
      if (startMs > target) continue;
      const end = _rosterDate(row.end);
      if (end && _dateOnly(end).getTime() < target) continue;
      if (startMs >= bestStart) { best = row; bestStart = startMs; }
    }
    return best;
  }

  function _renderShiftAdherence(monthKey) {
    const el = document.getElementById('attendance-adherence');
    if (!el) return;
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) { el.innerHTML = ''; return; }

    const inst = _supervisorFilter(sheets.getInstoreCached() || []);
    const rosterBy = _attendanceRosterByCaptain(sheets.getRosterCached() || []);
    const graceMin = cfg.get('adherence.graceMin', 30);

    // Earliest activity per captain-day within the month
    const first = new Map(); // `${empId}|${iso}` → ms
    for (const r of inst) {
      if (!r.act_ms || !r.date) continue;
      if (r.date.getFullYear() !== year || r.date.getMonth() !== month - 1) continue;
      const empId = _cleanAttendanceId(r.employee_id);
      if (!empId) continue;
      const key = `${empId}|${r.dateIsoStr}`;
      const cur = first.get(key);
      if (!cur || r.act_ms < cur) first.set(key, r.act_ms);
    }
    if (!first.size) { el.innerHTML = ''; return; }

    // Names from Daily Metrics
    const names = new Map();
    for (const r of sheets.getCached()) {
      if (r.employee_id && r.employee_name) names.set(_cleanAttendanceId(r.employee_id), r.employee_name);
    }

    const stats = new Map(); // empId → { days, onTime, lateDays, lateSum, worst }
    for (const [key, ms] of first) {
      const sep = key.indexOf('|');
      const empId = key.slice(0, sep), iso = key.slice(sep + 1);
      const rosterRows = rosterBy.get(empId);
      if (!rosterRows) continue;
      const date = new Date(`${iso}T00:00:00`);
      const entry = _adherenceRosterEntry(rosterRows, date);
      const startMin = _adherenceShiftStartMin(entry?.shift_start);
      if (startMin === null) continue;
      const act = new Date(ms);
      let lateMin = act.getHours() * 60 + act.getMinutes() - startMin;
      if (lateMin < -720) lateMin += 1440; // overnight shift wrap
      if (Math.abs(lateMin) > 360) continue; // unattributable — likely shift-record mismatch
      let s = stats.get(empId);
      if (!s) { s = { days: 0, onTime: 0, lateDays: 0, lateSum: 0, worst: 0 }; stats.set(empId, s); }
      s.days++;
      if (lateMin > graceMin) { s.lateDays++; s.lateSum += lateMin; s.worst = Math.max(s.worst, lateMin); }
      else s.onTime++;
    }
    if (!stats.size) { el.innerHTML = ''; return; }

    const rows = [...stats.entries()]
      .map(([empId, s]) => ({ empId, name: names.get(empId) || empId, ...s,
        avgLate: s.lateDays ? Math.round(s.lateSum / s.lateDays) : 0 }))
      .sort((a, b) => b.lateDays - a.lateDays || b.avgLate - a.avgLate);
    const lateTotal = rows.reduce((n, r) => n + r.lateDays, 0);

    const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    el.innerHTML = `
      <div class="inv-section" style="margin-bottom:18px">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#c084fc"></span>
          <h3 class="tiers-section-title">Shift Adherence — ${_esc(_attendanceMonthLabel(monthKey))}</h3>
          <span class="dd-coach-sub">first in-store pick vs rostered start · grace ${graceMin}m · pickers only, ±6h outliers excluded</span></div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead><tr><th>Captain</th><th>Days Measured</th><th>On Time</th><th>Late (&gt;${graceMin}m)</th><th>Avg Late</th><th>Worst</th></tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                ${_captainCell(r.name, r.empId)}
                <td>${r.days}</td>
                <td class="cell-green">${r.onTime}</td>
                <td class="${r.lateDays >= 3 ? 'cell-red' : r.lateDays > 0 ? 'cell-yellow' : ''}">${r.lateDays}</td>
                <td>${r.lateDays ? fmtMin(r.avgLate) : '—'}</td>
                <td>${r.lateDays ? fmtMin(r.worst) : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="attendance-hint" style="margin-top:8px">${lateTotal} late start${lateTotal === 1 ? '' : 's'} beyond the ${graceMin}-minute grace this month.</p>
      </div>`;
    _initTableSort(el.querySelector('.data-table'));
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

