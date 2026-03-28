/**
 * charts.js — Chart.js chart builders
 *
 * All charts are destroyed and recreated on each render to handle
 * dynamic data updates cleanly.
 */

const charts = (() => {
  const _instances = {};

  // ── Colour Palette ────────────────────────────────────────────────────

  const COLORS = {
    navy:   '#0f1419',
    accent: '#adc6ff',   /* blue primary — matches Samatva bento design */
    teal:   '#4edea3',   /* green secondary */
    amber:  '#ffca28',
    red:    '#ff6b6b',
    green:  '#4edea3',
    purple: '#c084fc',
    pink:   '#f9a8d4',
    silver: '#c6c6ca',
  };

  const ALPHA = (hex, a) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${a})`;
  };

  // ── Common Chart Defaults ─────────────────────────────────────────────

  const GRID_COLOR  = 'rgba(63,73,85,0.25)';
  const TICK_COLOR  = '#a2acba';
  const LABEL_COLOR = '#dde6f5';

  const BASE_OPTS = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { font: { size: 11, family: 'Manrope' }, color: TICK_COLOR, padding: 14 },
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        backgroundColor: 'rgba(15,20,25,0.95)',
        borderColor: 'rgba(63,73,85,0.4)',
        borderWidth: 1,
        titleColor: LABEL_COLOR,
        bodyColor: TICK_COLOR,
      },
    },
    scales: {
      x: {
        grid: { color: GRID_COLOR },
        ticks: { font: { size: 11, family: 'Manrope' }, color: TICK_COLOR, maxRotation: 45 },
      },
      y: {
        grid: { color: GRID_COLOR },
        ticks: { font: { size: 11, family: 'Manrope' }, color: TICK_COLOR },
        beginAtZero: true,
      },
    },
  };

  function _destroy(id) {
    if (_instances[id]) {
      _instances[id].destroy();
      delete _instances[id];
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

    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Missing',
            data: aggregated.map(d => d.missing_complaints || 0),
            backgroundColor: ALPHA(COLORS.red, 0.8),
            stack: 'complaints',
          },
          {
            label: 'Wrong',
            data: aggregated.map(d => d.wrong_complaints || 0),
            backgroundColor: ALPHA(COLORS.amber, 0.8),
            stack: 'complaints',
          },
          {
            label: 'Other',
            data: aggregated.map(d => d.other_complaints || 0),
            backgroundColor: ALPHA(COLORS.purple, 0.7),
            stack: 'complaints',
          },
        ],
      },
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

  function renderSparkline(canvasId, labels, values, flagDays, color = COLORS.accent) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const pointColors = values.map((_, i) => flagDays[i] ? COLORS.red : ALPHA(color, 0.7));

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '',
          data: values,
          borderColor: color,
          backgroundColor: ALPHA(color, 0.08),
          fill: true,
          tension: 0.3,
          pointRadius: values.map((_, i) => flagDays[i] ? 5 : 3),
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false }, tooltip: { mode: 'index' } },
        scales: {
          x: { display: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { display: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 10 } }, beginAtZero: false },
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

    const labels   = aggregated.map(d => d.label || d.weekKey || d.monthKey);
    const racks    = aggregated.map(d => d.totalRacks || 0);
    const auditors = aggregated.map(d => d.totalCaptains || 0);

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
            label: 'Active Auditors',
            data: auditors,
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
          y2: { ...BASE_OPTS.scales.y, position: 'right', title: { display: true, text: 'Auditors', color: TICK_COLOR }, grid: { drawOnChartArea: false } },
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
  };
})();
