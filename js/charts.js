/**
 * charts.js — Chart.js chart builders
 *
 * All charts are destroyed and recreated on each render to handle
 * dynamic data updates cleanly.
 */

const charts = (() => {
  const _instances = {};

  // Register chartjs-plugin-zoom once (loaded via CDN in index.html).
  if (typeof window !== 'undefined' && window.Chart && window.ChartZoom) {
    window.Chart.register(window.ChartZoom);
  }

  // ── Colour Palette ────────────────────────────────────────────────────

  const _COLORS_DARK = {
    navy:   '#0f1419',
    accent: '#adc6ff',
    teal:   '#4edea3',
    amber:  '#ffca28',
    red:    '#ff6b6b',
    green:  '#4edea3',
    purple: '#c084fc',
    pink:   '#f9a8d4',
    silver: '#c6c6ca',
  };
  const _COLORS_LIGHT = {
    navy:   '#f8f9fc',
    accent: '#3b82f6',   /* deeper blue for white backgrounds */
    teal:   '#10b981',
    amber:  '#f59e0b',
    red:    '#ef4444',
    green:  '#10b981',
    purple: '#8b5cf6',
    pink:   '#ec4899',
    silver: '#9ca3af',
  };
  const COLORS = new Proxy({}, {
    get(_, prop) { return (_isLight() ? _COLORS_LIGHT : _COLORS_DARK)[prop]; }
  });

  const ALPHA = (hex, a) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  };

  const _RCA_STORE_DARK = ['#14b8a6', '#2dd4bf', '#34d399', '#4ade80', '#0d9488', '#10b981', '#5eead4', '#86efac'];
  const _RCA_EXTERNAL_DARK = ['#f97316', '#fb923c', '#f59e0b', '#fbbf24', '#ea580c', '#d97706', '#fdba74', '#facc15'];
  const _RCA_UNKNOWN_DARK = ['#ef4444'];
  const _RCA_STORE_LIGHT = ['#0f766e', '#0d9488', '#059669', '#16a34a', '#14b8a6', '#22c55e', '#2dd4bf', '#4ade80'];
  const _RCA_EXTERNAL_LIGHT = ['#c2410c', '#ea580c', '#d97706', '#f59e0b', '#f97316', '#b45309', '#fb923c', '#eab308'];
  const _RCA_UNKNOWN_LIGHT = ['#dc2626'];
  const _RCA_STORE_TERMS = ['picker', 'putter', 'auditor', 'supervisor', 'infra', 'grn', 'store', 'captain', 'packing', 'inventory'];
  const _RCA_GROUP_RANK = { store: 0, external: 1, unknown: 2 };

  function _rcaGroup(rca) {
    const text = String(rca || '').toLowerCase();
    if (!text || text === 'unknown') return 'unknown';
    return _RCA_STORE_TERMS.some(term => text.includes(term)) ? 'store' : 'external';
  }

  function _rcaPalette(group) {
    if (group === 'store') return _isLight() ? _RCA_STORE_LIGHT : _RCA_STORE_DARK;
    if (group === 'unknown') return _isLight() ? _RCA_UNKNOWN_LIGHT : _RCA_UNKNOWN_DARK;
    return _isLight() ? _RCA_EXTERNAL_LIGHT : _RCA_EXTERNAL_DARK;
  }

  // ── Theme-aware Chart Defaults ─────────────────────────────────────────

  function _isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  function _gridColor()  { return _isLight() ? 'rgba(0,0,0,0.06)'   : 'rgba(63,73,85,0.25)'; }
  function _tickColor()  { return _isLight() ? '#6b7280'             : '#a2acba'; }
  function _labelColor() { return _isLight() ? '#1a1f2e'             : '#dde6f5'; }
  function _tooltipBg()  { return _isLight() ? 'rgba(255,255,255,0.96)' : 'rgba(15,20,25,0.95)'; }
  function _tooltipBdr() { return _isLight() ? 'rgba(0,0,0,0.08)'   : 'rgba(63,73,85,0.4)'; }

  // Theme-aware color accessors — read current theme each time they're accessed.
  // All chart render functions call these at creation time, so charts
  // automatically pick up the current theme without a full page reload.
  const _themeColors = {};
  Object.defineProperties(_themeColors, {
    GRID:  { get: _gridColor },
    TICK:  { get: _tickColor },
    LABEL: { get: _labelColor },
  });
  // Legacy aliases used throughout — redirect to live getters
  let GRID_COLOR, TICK_COLOR, LABEL_COLOR;
  // Reassign before each chart build via _refreshThemeVars()
  function _refreshThemeVars() {
    GRID_COLOR  = _gridColor();
    TICK_COLOR  = _tickColor();
    LABEL_COLOR = _labelColor();
  }
  _refreshThemeVars();

  function _baseOpts() {
    const gc = _gridColor(), tc = _tickColor(), lc = _labelColor();
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { size: 11, family: 'Manrope' },
            color: tc,
            padding: 16,
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 8,
            boxHeight: 8,
          },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: _tooltipBg(),
          borderColor: _tooltipBdr(),
          borderWidth: 1,
          titleColor: lc,
          bodyColor: tc,
        },
        zoom: {
          zoom: {
            wheel: { enabled: true, speed: 0.1 },
            pinch: { enabled: true },
            mode: 'x',
          },
          limits: {
            x: { minRange: 2 },
          },
        },
      },
      scales: {
        x: {
          grid: { color: gc },
          ticks: { font: { size: 11, family: 'Manrope' }, color: tc, maxRotation: 45 },
        },
        y: {
          grid: { color: gc },
          ticks: { font: { size: 11, family: 'Manrope' }, color: tc },
          beginAtZero: true,
        },
      },
    };
  }

  // Dynamic BASE_OPTS — always reads current theme colors.
  // Proxy intercepts both property access (BASE_OPTS.scales.y) AND spread
  // (...BASE_OPTS) by implementing ownKeys + getOwnPropertyDescriptor.
  const BASE_OPTS = new Proxy({}, {
    get(_, prop) { return _baseOpts()[prop]; },
    ownKeys()    { return Object.keys(_baseOpts()); },
    getOwnPropertyDescriptor(_, prop) {
      const val = _baseOpts()[prop];
      return val !== undefined
        ? { value: val, enumerable: true, configurable: true, writable: true }
        : undefined;
    },
  });

  function _getProductivityWeights() {
    const stored = JSON.parse(localStorage.getItem('productivityWeights') || '{}');
    return {
      order:   +(stored.order   ?? CONFIG.PRODUCTIVITY_WEIGHTS.order),
      putaway: +(stored.putaway ?? CONFIG.PRODUCTIVITY_WEIGHTS.putaway),
      rack:    +(stored.rack    ?? CONFIG.PRODUCTIVITY_WEIGHTS.rack),
    };
  }

  function _destroy(id) {
    if (_instances[id]) {
      _instances[id].destroy();
      delete _instances[id];
    }
    _refreshThemeVars(); // pick up current theme colors for the new chart
    // Attach dblclick-to-reset-zoom once per canvas (idempotent).
    const canvas = document.getElementById(id);
    if (canvas && !canvas.dataset.zoomResetBound) {
      canvas.addEventListener('dblclick', () => {
        const inst = _instances[id];
        if (inst && typeof inst.resetZoom === 'function') inst.resetZoom();
      });
      canvas.dataset.zoomResetBound = '1';
    }
  }

  // ── Chart 1: Orders Picked (left) vs Picking Hours (right) ───────────

  function renderOrdersHoursChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const orders  = aggregated.map(d => d.total_orders_picked || 0);
    const hours   = aggregated.map(d => +(d.total_picking_hours || 0).toFixed(1));

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Orders Picked',
            data: orders,
            borderColor: COLORS.accent,
            backgroundColor: ALPHA(COLORS.accent, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Picking Hours',
            data: hours,
            borderColor: COLORS.amber,
            backgroundColor: ALPHA(COLORS.amber, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Orders' } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Hours' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ── Chart 2: Avg Time Metrics (grouped bar) ───────────────────────────

  function renderTimeMetricsChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);

    // Convert seconds to minutes for readability
    const toMin = v => +(v / 60).toFixed(2);

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Pick Time/Order (min)',
            data: aggregated.map(d => toMin(d.avg_picking_time_per_order || 0)),
            backgroundColor: ALPHA(COLORS.accent, 0.75),
          },
          {
            label: 'Delay to Start (min)',
            data: aggregated.map(d => toMin(d.avg_assigned_to_started || 0)),
            backgroundColor: ALPHA(COLORS.purple, 0.75),
          },
          {
            label: 'Billing Time (min)',
            data: aggregated.map(d => toMin(d.avg_billing_time || 0)),
            backgroundColor: ALPHA(COLORS.pink, 0.75),
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Minutes' } },
        },
      },
    });
  }

  // ── Chart 3: Avg IPH trend (line) ─────────────────────────────────────

  function renderIPHChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Avg IPH',
            data: aggregated.map(d => +(d.avg_iph || 0).toFixed(1)),
            borderColor: COLORS.teal,
            backgroundColor: ALPHA(COLORS.teal, 0.12),
            fill: true,
            tension: 0.3,
            pointRadius: 4,
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Items / Hour' } },
        },
      },
    });
  }

  // ── Chart 4: Complaints stacked bar ──────────────────────────────────

  function renderComplaintsChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);

    const catColors = {
      item_missing: COLORS.red,
      item_damaged: COLORS.amber,
      wrong_item:   '#facc15',
      item_expired: COLORS.purple,
      qng:          COLORS.silver,
      unknown:      COLORS.silver,
    };

    // Collect all categories across all periods
    const allCats = new Set();
    for (const d of aggregated) {
      for (const k of Object.keys(d.complaints_by_category || {})) allCats.add(k);
    }

    const datasets = [...allCats].map(cat => ({
      label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      data: aggregated.map(d => (d.complaints_by_category || {})[cat] || 0),
      backgroundColor: ALPHA(catColors[cat] || COLORS.silver, 0.8),
      stack: 'complaints',
    }));

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, stacked: true, title: { display: true, text: 'Count' } },
          x: { ...BASE_OPTS.scales.x, stacked: true },
        },
      },
    });
  }

  // ── Sparkline for Captain Profile ─────────────────────────────────────

  // series: [{ label, values, flagDays, color }]
  function renderSparkline(canvasId, labels, series) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const isMulti = series.length > 1;

    const datasets = series.map(({ label, values, flagDays, color }, idx) => {
      const pointColors = values.map((_, i) => flagDays[i] ? COLORS.red : ALPHA(color, 0.7));
      return {
        label,
        data: values,
        borderColor: color,
        backgroundColor: ALPHA(color, idx === 0 ? 0.08 : 0.04),
        fill: idx === 0,
        tension: 0.3,
        spanGaps: idx > 0,
        pointRadius: values.map((_, i) => flagDays[i] ? 5 : 3),
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
      };
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: isMulti
            ? { display: true, position: 'bottom',
                labels: { font: { size: 10, family: 'Manrope' }, color: TICK_COLOR, padding: 12,
                          usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8 } }
            : { display: false },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { display: true, grid: { display: false },
               ticks: { font: { size: 10 }, maxRotation: 45, color: TICK_COLOR } },
          y: { display: true, grid: { color: GRID_COLOR },
               ticks: { font: { size: 10 }, color: TICK_COLOR }, beginAtZero: false },
        },
      },
    });
  }

  // ── Chart 5: Putaway Qty (left) vs Putting Hours (right) ─────────────

  function renderPutawayChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels      = aggregated.map(d => d.label || d.week_key || d.month_key);
    const putawayQty  = aggregated.map(d => d.total_putaway_qty || 0);
    const puttingHrs  = aggregated.map(d => +(d.total_putting_hours || 0).toFixed(1));

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Putaway Qty',
            data: putawayQty,
            borderColor: COLORS.teal,
            backgroundColor: ALPHA(COLORS.teal, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Putting Hours',
            data: puttingHrs,
            borderColor: COLORS.purple,
            backgroundColor: ALPHA(COLORS.purple, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Qty' } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Hours' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ── Chart 6: Audit Volume (dual-axis bar + line) ────────────────────

  function renderAuditVolumeChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.weekKey || d.monthKey);
    const racks  = aggregated.map(d => d.totalRacks || 0);
    const hours  = aggregated.map(d => d.totalAuditHours || 0);

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Racks Audited',
            data: racks,
            backgroundColor: ALPHA(COLORS.accent, 0.7),
            borderColor: COLORS.accent,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Audit Hours',
            data: hours,
            type: 'line',
            borderColor: COLORS.teal,
            backgroundColor: ALPHA(COLORS.teal, 0.1),
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Racks', color: TICK_COLOR } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Hours', color: TICK_COLOR }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ── Chart 7: Audit Coverage (bar — unique rack codes) ──────────────

  function renderAuditCoverageChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.weekKey || d.monthKey);
    const codes  = aggregated.map(d => d.uniqueCodes || 0);

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Unique Rack Codes',
          data: codes,
          backgroundColor: ALPHA(COLORS.purple, 0.7),
          borderColor: COLORS.purple,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Unique Codes', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Chart 8: Captain Efficiency Scatter ─────────────────────────────

  function renderAuditScatterChart(canvasId, captainData) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const data = captainData
      .filter(c => c.totals.totalHours > 0)
      .map(c => ({
        x: c.totals.totalHours,
        y: c.totals.totalRacks,
        label: c.employee_name,
        days: c.totals.totalDays,
        rph: c.totals.avgRacksPerHour,
      }));

    // Average racks/hour line
    const totalR = data.reduce((s, d) => s + d.y, 0);
    const totalH = data.reduce((s, d) => s + d.x, 0);
    const avgRPH = totalH > 0 ? totalR / totalH : 0;
    const maxH = Math.max(...data.map(d => d.x), 1);

    _instances[canvasId] = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Captains',
            data,
            backgroundColor: ALPHA(COLORS.teal, 0.6),
            borderColor: COLORS.teal,
            borderWidth: 1,
            pointRadius: data.map(d => Math.max(5, Math.min(14, d.days * 1.2))),
            pointHoverRadius: data.map(d => Math.max(7, Math.min(16, d.days * 1.2 + 2))),
          },
          {
            label: `Avg (${avgRPH.toFixed(1)} racks/hr)`,
            data: [{ x: 0, y: 0 }, { x: maxH, y: +(avgRPH * maxH).toFixed(0) }],
            type: 'line',
            borderColor: ALPHA(COLORS.silver, 0.5),
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        plugins: {
          ...BASE_OPTS.plugins,
          tooltip: {
            ...BASE_OPTS.plugins.tooltip,
            mode: 'nearest',
            intersect: true,
            callbacks: {
              label: (ctx) => {
                const d = ctx.raw;
                if (!d.label) return '';
                return [
                  d.label,
                  `Hours: ${d.x.toFixed(1)}`,
                  `Racks: ${d.y}`,
                  `Efficiency: ${d.rph} racks/hr`,
                  `${d.days} audit days`,
                ];
              },
            },
          },
        },
        scales: {
          ...BASE_OPTS.scales,
          x: { ...BASE_OPTS.scales.x, title: { display: true, text: 'Audit Hours', color: TICK_COLOR } },
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Racks Audited', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Chart 9: Complaint Trend (dual-axis bar + line) ────────────────

  function renderComplaintTrendChart(canvasId, periodData) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels     = periodData.map(d => d.label || d.weekKey || d.monthKey);
    const complaints = periodData.map(d => d.totalComplaints || 0);
    const inStoreRate = periodData.map(d => {
      const total = d.totalComplaints || 0;
      return total > 0 ? +((d.inStoreYes / total) * 100).toFixed(1) : 0;
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Total Complaints',
            data: complaints,
            backgroundColor: ALPHA(COLORS.red, 0.7),
            borderColor: COLORS.red,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'In-Store Fault %',
            data: inStoreRate,
            type: 'line',
            borderColor: COLORS.amber,
            backgroundColor: ALPHA(COLORS.amber, 0.1),
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Complaints', color: TICK_COLOR } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'In-Store %', color: TICK_COLOR }, grid: { drawOnChartArea: false }, max: 100 },
        },
      },
    });
  }

  // ── Chart 10: Complaint Category Stacked Bar ──────────────────────

  function renderComplaintCategoryChart(canvasId, periodData, mode) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const _mode = mode || 'total';
    const catKey = _mode === 'instore' ? 'byCategoryInStore' : _mode === 'outstore' ? 'byCategoryOutStore' : 'byCategory';

    const labels = periodData.map(d => d.label || d.weekKey || d.monthKey);

    // Distinct colors per category — no shared hues
    const catColors = {
      item_missing: COLORS.red,
      item_damaged: COLORS.accent,   // blue — distinct from amber
      wrong_item:   COLORS.amber,
      item_expired: COLORS.purple,
      qng:          COLORS.silver,
    };

    // Collect all category keys across all periods
    const allCats = new Set();
    for (const d of periodData) {
      for (const k of Object.keys(d[catKey] || {})) allCats.add(k);
    }

    const datasets = [...allCats].map(cat => ({
      label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      data: periodData.map(d => {
        const count = (d[catKey] || {})[cat] || 0;
        const orders = d.totalOrdersPicked || 0;
        return orders > 0 ? +((count / orders) * 100).toFixed(3) : 0;
      }),
      _rawCounts: periodData.map(d => (d[catKey] || {})[cat] || 0),
      backgroundColor: ALPHA(catColors[cat] || COLORS.silver, 0.8),
      stack: 'complaints',
    }));

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        ...BASE_OPTS,
        plugins: {
          ...BASE_OPTS.plugins,
          tooltip: {
            ...BASE_OPTS.plugins?.tooltip,
            itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
            callbacks: {
              label(ctx) {
                const raw = ctx.dataset._rawCounts?.[ctx.dataIndex] ?? 0;
                return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%  (${raw})`;
              },
            },
          },
        },
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, stacked: true, title: { display: true, text: '% of Total Orders', color: TICK_COLOR } },
          x: { ...BASE_OPTS.scales.x, stacked: true },
        },
      },
    });
  }

  // ── Chart 11: Captain Complaint Scatter ────────────────────────────

  function renderCaptainComplaintScatter(canvasId, captainData) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const data = captainData
      .filter(c => c.totalOrdersPicked > 0)
      .map(c => ({
        x: c.totalOrdersPicked,
        y: c.inStoreYes,
        label: c.employee_name,
        rate: c.complaintRate,
        total: c.totalComplaints,
      }));

    // Average complaint rate reference line
    const totalY = data.reduce((s, d) => s + d.y, 0);
    const totalX = data.reduce((s, d) => s + d.x, 0);
    const avgRate = totalX > 0 ? totalY / totalX : 0;
    const maxX = Math.max(...data.map(d => d.x), 1);

    _instances[canvasId] = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Captains',
            data,
            backgroundColor: ALPHA(COLORS.red, 0.6),
            borderColor: COLORS.red,
            borderWidth: 1,
            pointRadius: data.map(d => Math.max(5, Math.min(14, d.rate * 8))),
            pointHoverRadius: data.map(d => Math.max(7, Math.min(16, d.rate * 8 + 2))),
          },
          {
            label: `Avg (${(avgRate * 100).toFixed(2)}%)`,
            data: [{ x: 0, y: 0 }, { x: maxX, y: +(avgRate * maxX).toFixed(0) }],
            type: 'line',
            borderColor: ALPHA(COLORS.silver, 0.5),
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        plugins: {
          ...BASE_OPTS.plugins,
          tooltip: {
            ...BASE_OPTS.plugins.tooltip,
            mode: 'nearest',
            intersect: true,
            callbacks: {
              label: (ctx) => {
                const d = ctx.raw;
                if (!d.label) return '';
                return [
                  d.label,
                  `Orders: ${d.x}`,
                  `In-Store Complaints: ${d.y}`,
                  `Rate: ${d.rate}%`,
                  `Total Complaints: ${d.total}`,
                ];
              },
            },
          },
        },
        scales: {
          ...BASE_OPTS.scales,
          x: { ...BASE_OPTS.scales.x, title: { display: true, text: 'Total Orders Picked', color: TICK_COLOR } },
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'In-Store Complaints', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Chart 12: RCA Stacked Bar Over Time ───────────────────────────

  function renderRCADonutChart(canvasId, periodData) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = periodData.map(d => d.label || d.weekKey || d.monthKey);

    // Collect all RCA keys across all periods, ordered by total count desc
    const rcaTotals = {};
    for (const d of periodData) {
      for (const [k, v] of Object.entries(d.byRCA || {})) {
        rcaTotals[k] = (rcaTotals[k] || 0) + v;
      }
    }
    const allRCAs = Object.keys(rcaTotals).sort((a, b) => {
      const groupDelta = _RCA_GROUP_RANK[_rcaGroup(a)] - _RCA_GROUP_RANK[_rcaGroup(b)];
      if (groupDelta !== 0) return groupDelta;
      return (rcaTotals[b] - rcaTotals[a]) || a.localeCompare(b);
    });

    const colorIdxByGroup = { store: 0, external: 0, unknown: 0 };
    const datasets = allRCAs.map((rca) => {
      const group = _rcaGroup(rca);
      const palette = _rcaPalette(group);
      const colorIdx = colorIdxByGroup[group]++;
      const color = palette[colorIdx % palette.length];

      return {
        label: rca,
        data: periodData.map(d => {
          const count = (d.byRCA || {})[rca] || 0;
          const orders = d.totalOrdersPicked || 0;
          return orders > 0 ? +((count / orders) * 100).toFixed(3) : 0;
        }),
        _rawCounts: periodData.map(d => (d.byRCA || {})[rca] || 0),
        _group: group,
        backgroundColor: ALPHA(color, 0.82),
        borderColor: ALPHA(color, 0.95),
        borderWidth: 0.5,
        stack: 'rca',
      };
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        ...BASE_OPTS,
        plugins: {
          ...BASE_OPTS.plugins,
          tooltip: {
            ...BASE_OPTS.plugins?.tooltip,
            itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
            filter: (item) => (item.dataset._rawCounts?.[item.dataIndex] ?? 0) > 0,
            callbacks: {
              label(ctx) {
                const raw = ctx.dataset._rawCounts?.[ctx.dataIndex] ?? 0;
                return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%  (${raw})`;
              },
            },
          },
        },
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, stacked: true, title: { display: true, text: '% of Total Orders', color: TICK_COLOR } },
          x: { ...BASE_OPTS.scales.x, stacked: true },
        },
      },
    });
  }

  // ── Chart 13: L0 Category Horizontal Bar ───────────────────────────

  function renderL0CategoryChart(canvasId, sortedL0) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const top10 = sortedL0.slice(0, 10);
    const labels = top10.map(c => c.category);
    const counts = top10.map(c => c.count);
    const bgColors = top10.map(c => {
      const pct = c.inStorePct;
      if (pct >= 60) return ALPHA(COLORS.red, 0.8);
      if (pct >= 40) return ALPHA(COLORS.amber, 0.8);
      return ALPHA(COLORS.teal, 0.8);
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Complaints',
          data: counts,
          backgroundColor: bgColors,
          borderRadius: 4,
        }],
      },
      options: {
        ...BASE_OPTS,
        indexAxis: 'y',
        scales: {
          ...BASE_OPTS.scales,
          x: { ...BASE_OPTS.scales.x, title: { display: true, text: 'Complaints', color: TICK_COLOR } },
          y: { ...BASE_OPTS.scales.y, ticks: { ...BASE_OPTS.scales.y.ticks, font: { size: 10, family: 'Manrope' } } },
        },
      },
    });
  }

  // ── Store Overview: Active Time vs Productivity (dual-axis line) ────

  function renderActiveTimeProductivityChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const activeTime = aggregated.map(d => +(d.total_active_time || 0).toFixed(1));

    const w = _getProductivityWeights();
    const productivity = aggregated.map(d =>
      Math.round((d.total_orders_picked || 0) * w.order
               + (d.total_putaway_qty || 0) * w.putaway
               + (d.total_racks_audited || 0) * w.rack)
    );

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Active Time (hrs)',
            data: activeTime,
            borderColor: COLORS.accent,
            backgroundColor: ALPHA(COLORS.accent, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y',
          },
          {
            label: 'Productivity (Item-Eq)',
            data: productivity,
            borderColor: COLORS.teal,
            backgroundColor: ALPHA(COLORS.teal, 0.1),
            fill: true,
            tension: 0.3,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Hours', color: TICK_COLOR } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Item-Equivalents', color: TICK_COLOR }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ── Store Overview: Rack Audit Volume (bar + line, dual-axis) ─────

  function renderStoreAuditVolumeChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const racks  = aggregated.map(d => d.total_racks_audited || 0);
    const hours  = aggregated.map(d => +(d.total_audit_hours || 0).toFixed(1));

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Racks Audited',
            data: racks,
            backgroundColor: ALPHA(COLORS.accent, 0.7),
            borderColor: COLORS.accent,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Audit Hours',
            data: hours,
            type: 'line',
            borderColor: COLORS.teal,
            backgroundColor: ALPHA(COLORS.teal, 0.1),
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y:  { ...BASE_OPTS.scales.y, position: 'left',  title: { display: true, text: 'Racks', color: TICK_COLOR } },
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Hours', color: TICK_COLOR }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ── Store Overview: Audit Efficiency — Hours per Rack (line) ──────

  function renderAuditEfficiencyChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const rph = aggregated.map(d => {
      const r = d.total_racks_audited || 0;
      const h = d.total_audit_hours || 0;
      return h > 0 ? +(r / h).toFixed(2) : null;
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Racks / Hour',
            data: rph,
            borderColor: COLORS.amber,
            backgroundColor: ALPHA(COLORS.amber, 0.12),
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            spanGaps: true,
          },
        ],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Racks / Hour', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Store Overview: Productivity Per Hour (line) ──────────────────
  function renderProductivityPerHourChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const w = _getProductivityWeights();
    const data = aggregated.map(d => {
      const hrs = d.total_active_time || 0;
      if (hrs === 0) return null;
      const prod = (d.total_orders_picked || 0) * w.order
                 + (d.total_putaway_qty    || 0) * w.putaway
                 + (d.total_racks_audited  || 0) * w.rack;
      return +((prod / hrs).toFixed(1));
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Item-Eq / Hour',
          data,
          borderColor: COLORS.purple,
          backgroundColor: ALPHA(COLORS.purple, 0.12),
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          spanGaps: true,
        }],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Item-Eq / Hr', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Store Overview: Orders Per Hour (line) ────────────────────────
  function renderOrdersPerHourChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const data = aggregated.map(d => {
      const hrs = d.total_picking_hours || 0;
      if (hrs === 0) return null;
      return +((d.total_orders_picked || 0) / hrs).toFixed(1);
    });

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Orders / Hr',
          data,
          borderColor: COLORS.accent,
          backgroundColor: ALPHA(COLORS.accent, 0.15),
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          spanGaps: true,
        }],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Orders / Hr', color: TICK_COLOR } },
        },
      },
    });
  }

  // ── Store Overview: Staff Availability — surplus/deficit (single line) ──
  function renderStaffAvailabilityChart(canvasId, aggregated) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const divisor = parseFloat(localStorage.getItem('staffAvailDivisor') || 6.8);
    const labels = aggregated.map(d => d.label || d.week_key || d.month_key);
    const data   = aggregated.map(d =>
      +((d.total_active_time || 0) - (d.total_orders_picked || 0) / divisor).toFixed(2)
    );

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Staff Availability',
          data,
          borderColor: COLORS.teal,
          backgroundColor: ALPHA(COLORS.teal, 0.12),
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          spanGaps: true,
        }],
      },
      options: {
        ...BASE_OPTS,
        scales: {
          ...BASE_OPTS.scales,
          y: { ...BASE_OPTS.scales.y, title: { display: true, text: 'Hours', color: TICK_COLOR } },
        },
      },
    });
  }

  return {
    renderOrdersHoursChart,
    renderTimeMetricsChart,
    renderIPHChart,
    renderComplaintsChart,
    renderPutawayChart,
    renderSparkline,
    renderAuditVolumeChart,
    renderAuditCoverageChart,
    renderAuditScatterChart,
    renderComplaintTrendChart,
    renderComplaintCategoryChart,
    renderCaptainComplaintScatter,
    renderRCADonutChart,
    renderL0CategoryChart,
    renderActiveTimeProductivityChart,
    renderStoreAuditVolumeChart,
    renderAuditEfficiencyChart,
    renderProductivityPerHourChart,
    renderOrdersPerHourChart,
    renderStaffAvailabilityChart,
  };
})();
