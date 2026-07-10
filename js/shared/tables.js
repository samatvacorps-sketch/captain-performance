/**
 * tables.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

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

  // Captain cells drill through to that captain's 360° page from any table.
  function _captainCell(name, id) {
    return `<td>
      <div class="captain-cell captain-cell-link" role="link" tabindex="0" title="Open Captain 360°"
           onclick="ui.openCaptain360('${_esc(id)}')"
           onkeydown="if(event.key==='Enter')ui.openCaptain360('${_esc(id)}')">
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

