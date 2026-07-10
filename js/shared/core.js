/**
 * core.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */


  // ── Sort State (persists across re-renders) ───────────────────────────
  let _sortState = { col: null, dir: 'desc' };

  // ── Captain Profile State ─────────────────────────────────────────────
  let _cpDateMode = false; // false = preset active, true = custom date range
  let _cpView = 'daily';   // 'daily' | 'weekly' | 'monthly'
  const _CAPTAIN_COLORS = ['#adc6ff', '#ffca28', '#4edea3', '#c084fc', '#f9a8d4', '#c6c6ca'];
  let _selectedCaptains = []; // [{ id, name, color }]

  function _colorAlpha(hex, a) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // ── Deep Dive Captain Filter ───────────────────────────────────────────
  // 'all' | 'flagged' | 'ok'
  let _ddFilter = 'all';
  let _ddTierMode = 'off'; // 'off' | 'shift' | 'experience'
  let _ddShowPickingBreakdown = false; // show/hide Delay/Pick/Bill time columns

  function setDDFilter(val) {
    _ddFilter = (_ddFilter === val) ? 'all' : val;   // toggle off if already active
    renderDeepDive();
  }

  function toggleDDTier() {
    _ddTierMode = _ddTierMode === 'off' ? 'shift'
      : _ddTierMode === 'shift' ? 'experience' : 'off';
    _updateDDTierBtn();
    renderDeepDive();
  }

  function togglePickingBreakdown() {
    _ddShowPickingBreakdown = !_ddShowPickingBreakdown;
    renderDeepDive();
  }
  function _updateDDTierBtn() {
    const btn = document.getElementById('dd-tier-toggle');
    if (!btn) return;
    if (_ddTierMode === 'off') {
      btn.textContent = 'Group: Off';
      btn.className = 'btn tier-mode-btn dd-tier-off';
    } else if (_ddTierMode === 'shift') {
      btn.textContent = 'Shift-Based';
      btn.className = 'btn tier-mode-btn';
    } else {
      btn.textContent = 'Experience-Based';
      btn.className = 'btn tier-mode-btn experience';
    }
  }

  // ── Flow SD Thresholds ───────────────────────────────────────────────
  const _FT_DEFAULTS = {
    picking: { critical: 0.5,  flagged: 0.25, borderline: 0.1  },
    putting: { critical: 0.25, flagged: 0.1,  borderline: 0.01 },
    audit:   { critical: 0.5,  flagged: 0.25, borderline: 0.1  },
    fnv:     { critical: 2,    flagged: 1,    borderline: 0.5  },
  };
  const _FT_FLOWS = ['picking', 'putting', 'audit', 'fnv'];

  // ── Productivity Weights ─────────────────────────────────────────────
  const _PW_DEFAULTS = { order: 6, putaway: 1, rack: 315 };

  function _getProductivityWeights() {
    const stored = JSON.parse(localStorage.getItem('productivityWeights') || '{}');
    return {
      order:   +(stored.order   ?? _PW_DEFAULTS.order),
      putaway: +(stored.putaway ?? _PW_DEFAULTS.putaway),
      rack:    +(stored.rack    ?? _PW_DEFAULTS.rack),
    };
  }

  function updateProductivityWeights() {
    const order   = parseFloat(document.getElementById('pw-order')?.value);
    const putaway = parseFloat(document.getElementById('pw-putaway')?.value);
    const rack    = parseFloat(document.getElementById('pw-rack')?.value);
    if ([order, putaway, rack].some(isNaN)) return;
    localStorage.setItem('productivityWeights', JSON.stringify({ order, putaway, rack }));
    const msg = document.getElementById('pw-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
    renderStoreOverview();
  }

  function resetProductivityWeights() {
    localStorage.removeItem('productivityWeights');
    renderConfigPanel();
    renderStoreOverview();
  }

  // ── Staff Availability divisor (orders ÷ X = required hours) ─────────
  const _STAFF_AVAIL_DEFAULT_DIVISOR = 6.8;

  function _getStaffAvailDivisor() {
    return parseFloat(localStorage.getItem('staffAvailDivisor') || _STAFF_AVAIL_DEFAULT_DIVISOR);
  }

  function updateStaffAvailDivisor(val) {
    const v = parseFloat(val);
    if (!isNaN(v) && v > 0) {
      localStorage.setItem('staffAvailDivisor', v);
      const msg = document.getElementById('staff-avail-saved-msg');
      if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
      renderStoreOverview();
    }
  }

  function resetStaffAvailDivisor() {
    localStorage.removeItem('staffAvailDivisor');
    renderConfigPanel();
    renderStoreOverview();
  }

  function _getFlowThresholds(flow) {
    const stored = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
    const defaults = _FT_DEFAULTS[flow] || { critical: 2, flagged: 1, borderline: 0.5 };
    return { ...defaults, ...(stored[flow] || {}) };
  }

  function _readFlowThresholdInputs() {
    const out = {};
    for (const flow of _FT_FLOWS) {
      const def = _FT_DEFAULTS[flow];
      out[flow] = {
        critical:   parseFloat(document.getElementById(`ft-${flow}-critical`)?.value)   || def.critical,
        flagged:    parseFloat(document.getElementById(`ft-${flow}-flagged`)?.value)    || def.flagged,
        borderline: parseFloat(document.getElementById(`ft-${flow}-borderline`)?.value) || def.borderline,
      };
    }
    return out;
  }

  function saveFlowThresholds() {
    const out = _readFlowThresholdInputs();
    localStorage.setItem('flowThresholds', JSON.stringify(out));
    const raw = sheets.getCached();
    if (raw.length > 0) {
      app.updateFlowThresholds(out, ui.filterSupervisors(raw));
    }
    const msg = document.getElementById('flow-thresholds-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
  }

  function resetFlowThresholds() {
    localStorage.removeItem('flowThresholds');
    renderConfigPanel();
    const raw = sheets.getCached();
    if (raw.length > 0) {
      app.updateFlowThresholds({}, ui.filterSupervisors(raw));
    }
  }

  // ── Supervisor Exclusion ─────────────────────────────────────────────
  let _excludeSupervisors = localStorage.getItem('excludeSupervisors') !== 'false'; // default true
  let _customExcludedIds  = new Set(JSON.parse(localStorage.getItem('customExcludedIds') || '[]'));

  function _supervisorFilter(rows) {
    if (!_excludeSupervisors) return rows;
    // Sheet Config `supervisorIds` replaces the hardcoded base list when set.
    const baseIds = cfg.get('supervisorIds', null) || CONFIG.SUPERVISOR_IDS || [];
    const s = new Set([...baseIds, ..._customExcludedIds]);
    return rows.filter(r => !s.has(r.employee_id));
  }

  function _updateSupervisorBtn() {
    const btn = document.getElementById('supervisor-toggle');
    if (!btn) return;
    btn.classList.toggle('active', _excludeSupervisors);
    btn.textContent = _excludeSupervisors ? 'Excl. Captains' : 'Incl. Captains';
  }

  function toggleSupervisors() {
    _excludeSupervisors = !_excludeSupervisors;
    localStorage.setItem('excludeSupervisors', String(_excludeSupervisors));
    _updateSupervisorBtn();
    app.refresh();
  }

  function addExcludedId() {
    const input = document.getElementById('excl-id-input');
    if (!input) return;
    const val = input.value.trim().toUpperCase();
    if (!val) return;
    _customExcludedIds.add(val);
    localStorage.setItem('customExcludedIds', JSON.stringify([..._customExcludedIds]));
    input.value = '';
    renderConfigPanel();
    if (_excludeSupervisors) app.refresh();
  }

  function removeExcludedId(id) {
    _customExcludedIds.delete(id);
    localStorage.setItem('customExcludedIds', JSON.stringify([..._customExcludedIds]));
    renderConfigPanel();
    if (_excludeSupervisors) app.refresh();
  }

  // ── Theme Toggle ─────────────────────────────────────────────────────
  function _initTheme() {
    const saved = localStorage.getItem('theme');
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }
  _initTheme();

  function toggleTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    }
    // Re-render current tab so charts pick up new theme colors
    try { app.renderCurrentTab?.(); } catch (_) {}
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

