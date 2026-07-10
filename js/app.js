

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

    // Cache-first startup: render instantly from the previous session's
    // data (IndexedDB), then refresh from the network in the background.
    let cached = null;
    try { cached = await sheets.loadFromCache(); } catch (e) { cached = null; }
    if (cached) {
      _recompute();
      _initTabs();
      _renderCurrentTab();
      _showStaleBanner(cached.ts);
      refresh({ background: true });
    } else {
      await refresh();
    }
  }

  async function refresh(opts = {}) {
    const background = opts && opts.background === true;
    if (!background) _setLoading(true);
    try {
      // All ranges fetch in parallel; auth.getToken shares one
      // in-flight token request across concurrent callers.
      const [raw] = await Promise.all([
        sheets.fetchData(true),
        sheets.fetchAuditData(true),
        sheets.fetchComplaintsData(true),
        sheets.fetchInstoreData(true),
        sheets.fetchPnaData(true),
        sheets.fetchRosterData(true),
        sheets.fetchConfigData(true),
        sheets.fetchRackListData(true),
      ]);

      _recompute(raw);

      // Update last-refreshed timestamp
      const ts = document.getElementById('last-refreshed');
      if (ts) ts.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;

      _initTabs();
      _renderCurrentTab();
      _hideStaleBanner();

      // Update config row count
      const countEl = document.getElementById('config-row-count');
      if (countEl) countEl.textContent = raw.length.toLocaleString();

    } catch (err) {
      console.error('Dashboard load error:', err);
      _showError(`Failed to load data: ${err.message}`);
      // On a failed background refresh, keep serving the cached render
      // but stop claiming a refresh is underway.
      const banner = document.getElementById('stale-data-banner');
      if (banner) banner.textContent = 'Refresh failed — showing cached data';
    } finally {
      if (!background) _setLoading(false);
    }
  }

  /** Stats pipeline: supervisor filter → store stats → personal avgs → flags. */
  function _recompute(raw = null) {
    const rows = raw || sheets.getCached();
    const filteredRaw = ui.filterSupervisors(rows);
    _storeStats   = compute.computeStoreStats(filteredRaw);
    _personalAvgs = compute.computePersonalAvgs(filteredRaw);
    const storedThresholds = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
    _flaggedData  = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, storedThresholds);
  }

  /** (Re)initialise per-tab dropdowns and presets after data lands. */
  function _initTabs() {
    ui.updateSupervisorBtn();
    ui.initDeepDivePeriods();
    ui.initAttendance();
    ui.initCaptainDropdown();
    ui.initCaptainProfilePeriods();
    ui.initOverviewPeriods();
    ui.initTiersView();
    ui.initInventoryHealth();
    ui.initComplaintsDeepDive();
    ui.initKeyMetrics();
    ui.initIncentivePeriods();
  }

  // ── Cached-data freshness banner ──────────────────────────────────
  function _showStaleBanner(ts) {
    _hideStaleBanner();
    const el = document.createElement('div');
    el.id = 'stale-data-banner';
    el.className = 'stale-banner';
    el.setAttribute('role', 'status');
    const when = new Date(ts);
    const sameDay = when.toDateString() === new Date().toDateString();
    const label = sameDay
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    el.textContent = `Showing data from ${label} — refreshing…`;
    document.body.appendChild(el);
  }

  function _hideStaleBanner() {
    document.getElementById('stale-data-banner')?.remove();
  }

  // Non-blocking error toast (replaces alert(), which froze the UI and
  // looked broken on mobile). Auto-dismisses; click to dismiss early.
  function _showError(msg) {
    document.getElementById('app-error-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'app-error-toast';
    el.className = 'error-toast';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<span>${String(msg).replace(/</g, '&lt;')}</span><button type="button" aria-label="Dismiss">&times;</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 12000);
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
      const filteredRaw = ui.filterSupervisors(raw);
      const storedThresholds = JSON.parse(localStorage.getItem('flowThresholds') || '{}');
      _flaggedData = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, storedThresholds);
      _renderCurrentTab();
    }
  }

  function updateFloorDeviation(val) {
    CONFIG.FLOOR_DEVIATION = parseFloat(val) ?? 0.30;
    _renderCurrentTab();
  }

  function updateFlowThresholds(thresholdMap, filteredRaw) {
    _flaggedData = compute.flagSlackers(filteredRaw, _storeStats, _personalAvgs, CONFIG.THRESHOLD, thresholdMap);
    _renderCurrentTab();
  }

  function _renderCurrentTab() {
    switch (_currentTab) {
      case 'store-overview':    ui.renderStoreOverview(); break;
      case 'captain-deep-dive': ui.renderDeepDive(); break;
      case 'attendance':         ui.renderAttendance(); break;
      case 'captain-profile':   ui.renderCaptainProfile(); break;
      case 'tier-analysis':     ui.renderTiersView(); break;
      case 'inventory-health':       ui.renderInventoryHealth(); break;
      case 'key-metrics':            ui.renderKeyMetrics(); break;
      case 'complaints-deep-dive':   ui.renderComplaintsDeepDive(); break;
      case 'incentives':             ui.renderIncentives(); break;
      case 'config-panel':           ui.renderConfigPanel(); break;
    }
  }

  function _setLoading(show) {
    const el = document.getElementById('loading-overlay');
    if (el) el.classList.toggle('hidden', !show);
  }

  function getFlaggedData()  { return _flaggedData; }
  function getStoreStats()   { return _storeStats; }
  function getPersonalAvgs() { return _personalAvgs; }

  return { init, refresh, switchTab, updateThreshold, updateFloorDeviation, updateFlowThresholds, getFlaggedData, getStoreStats, getPersonalAvgs, renderCurrentTab: _renderCurrentTab };
})();

// Explicit window binding: `const app` is a global lexical, not a window
// property, and auth.js bootstraps via `if (window.app) app.init()`.
window.app = app;
