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

  function renderSparkline(canvasId, labels, values, flagDays, color = COLORS.accent, opts = {}) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const { labelA = '', valuesB = null, flagDaysB = null, labelB = '' } = opts;
    const isComparison = !!valuesB;

    const pointColorsA = values.map((_, i) => flagDays[i] ? COLORS.red : ALPHA(color, 0.7));
    const datasets = [{
      label: labelA,
      data: values,
      borderColor: color,
      backgroundColor: ALPHA(color, 0.08),
      fill: true,
      tension: 0.3,
      pointRadius: values.map((_, i) => flagDays[i] ? 5 : 3),
      pointBackgroundColor: pointColorsA,
      pointBorderColor: pointColorsA,
    }];

    if (isComparison) {
      const colB = COLORS.amber;
      const pointColorsB = valuesB.map((_, i) => (flagDaysB?.[i]) ? COLORS.red : ALPHA(colB, 0.7));
      datasets.push({
        label: labelB,
        data: valuesB,
        borderColor: colB,
        backgroundColor: ALPHA(colB, 0.06),
        fill: false,
        tension: 0.3,
        spanGaps: true,
        pointRadius: valuesB.map((_, i) => (flagDaysB?.[i]) ? 5 : 3),
        pointBackgroundColor: pointColorsB,
        pointBorderColor: pointColorsB,
      });
    }

    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: isComparison
            ? { display: true, position: 'bottom',
                labels: { font: { size: 10, family: 'Manrope' }, color: TICK_COLOR, padding: 10 } }
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

  function renderComplaintCategoryChart(canvasId, periodData) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = periodData.map(d => d.label || d.weekKey || d.monthKey);
    const catColors = {
      item_missing: COLORS.red,
      item_damaged: COLORS.amber,
      wrong_item:   '#facc15',
      item_expired: COLORS.purple,
      qng:          COLORS.silver,
    };

    // Collect all category keys across all periods
    const allCats = new Set();
    for (const d of periodData) {
      for (const k of Object.keys(d.byCategory || {})) allCats.add(k);
    }

    const datasets = [...allCats].map(cat => ({
      label: cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      data: periodData.map(d => (d.byCategory || {})[cat] || 0),
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
          y: { ...BASE_OPTS.scales.y, stacked: true, title: { display: true, text: 'Count', color: TICK_COLOR } },
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

  // ── Chart 12: RCA Donut ────────────────────────────────────────────

  function renderRCADonutChart(canvasId, sortedRCA) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const rcaColors = [COLORS.red, COLORS.amber, '#facc15', COLORS.purple, COLORS.teal, COLORS.pink, COLORS.silver];
    const labels = sortedRCA.map(r => r.rca);
    const data   = sortedRCA.map(r => r.count);
    const total  = data.reduce((s, v) => s + v, 0);

    _instances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: sortedRCA.map((_, i) => ALPHA(rcaColors[i % rcaColors.length], 0.8)),
          borderColor: 'rgba(0,0,0,0.3)',
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 11, family: 'Manrope' }, color: TICK_COLOR, padding: 10 },
          },
          tooltip: {
            ...BASE_OPTS.plugins.tooltip,
            callbacks: {
              label: (ctx) => `${ctx.label}: ${ctx.raw} (${total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0}%)`,
            },
          },
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
  };
})();
