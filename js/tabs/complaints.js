/**
 * complaints.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

  // ── Complaints Deep Dive ──────────────────────────────────────────

  let _complCache = null;
  let _complCacheKey = null;
  let _complIncludeQNG = true;
  let _complDateMode = false;
  let _complCatMode = 'total';
  let _complCatPeriodData = null;
  let _complDetailRows = [];
  let _complDetailCaptains = new Map();
  let _complPickerNames = new Map();
  let _complDetailPeriod = { start: '', end: '' };
  let _complDetailEscHandler = null;
  let _complCaptainRows = [];
  let _complCaptainCategory = 'all';

  function initComplaintsDeepDive() {
    const complData = sheets.getComplaintsCached();
    const sel = document.getElementById('compl-preset');
    if (!sel || !complData || complData.length === 0) return;

    const weekly  = compute.aggregateWeekly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));
    const monthly = compute.aggregateBillingMonthly(complData.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id })));

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

    // Default: full span of complaints data
    const sortedDates = complData.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (sortedDates.length > 0) {
      document.getElementById('compl-start').value = _isoDateStr(sortedDates[0]);
      document.getElementById('compl-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
    }

    _complDateMode = false;
    _complCache = null;
    _complCacheKey = null;
  }

  function onComplPeriodChange() {
    renderComplaintsDeepDive();
  }

  function onComplPresetChange() {
    _complDateMode = false;
    const complData = sheets.getComplaintsCached();
    if (!complData) return;
    const periodVal = document.getElementById('compl-preset')?.value;
    if (!periodVal) return;

    if (periodVal === 't1' || periodVal === 't2') {
      periods.setDayPair('compl-start', 'compl-end', periodVal === 't1' ? 1 : 2);
      _complDateMode = true;
      _complCache = null;
      _complCacheKey = null;
      renderComplaintsDeepDive();
      return;
    }

    if (periodVal === 'all') {
      const sortedDates = complData.map(r => r.date).filter(Boolean).sort((a, b) => a - b);
      if (sortedDates.length > 0) {
        document.getElementById('compl-start').value = _isoDateStr(sortedDates[0]);
        document.getElementById('compl-end').value   = _isoDateStr(sortedDates[sortedDates.length - 1]);
      }
    } else {
      const colonIdx   = periodVal.indexOf(':');
      const periodType = periodVal.slice(0, colonIdx);
      const periodKey  = periodVal.slice(colonIdx + 1);
      if (periodType === 'W') {
        const rows = complData.filter(row => row.date && compute.aggregateWeekly([{ date: row.date, dateStr: row.dateStr, employee_id: row.employee_id }]).some(w => w.week_key === periodKey));
        if (rows.length > 0) {
          const dates = rows.map(r => r.date).sort((a, b) => a - b);
          document.getElementById('compl-start').value = _isoDateStr(dates[0]);
          document.getElementById('compl-end').value   = _isoDateStr(dates[dates.length - 1]);
        }
      } else {
        _applyBillingMonthDates('compl-start', 'compl-end', periodKey);
      }
    }
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function onComplDateChange() {
    _complDateMode = true;
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function toggleComplQNG() {
    _complIncludeQNG = !_complIncludeQNG;
    const btn = document.getElementById('compl-qng-toggle');
    if (btn) {
      btn.textContent = _complIncludeQNG ? 'QNG Included' : 'QNG Excluded';
      btn.classList.toggle('active', _complIncludeQNG);
    }
    _complCache = null;
    _complCacheKey = null;
    renderComplaintsDeepDive();
  }

  function onComplCatModeChange(mode) {
    _complCatMode = mode;
    document.querySelectorAll('.compl-cat-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (_complCatPeriodData) {
      charts.renderComplaintCategoryChart('chart-compl-category', _complCatPeriodData, _complCatMode);
    }
  }

  function onComplCaptainCategoryChange(category) {
    _complCaptainCategory = category || 'all';
    _renderCaptainComplaintTable(_complCaptainRows);
  }

  function renderComplaintsDeepDive() {
    const container = document.getElementById('compl-content');
    if (!container) return;
    _closeComplaintDetail();

    const complData = _supervisorFilter(sheets.getComplaintsCached() || []);
    const dailyData = _supervisorFilter(sheets.getCached());
    _complPickerNames = new Map();
    dailyData.forEach(row => {
      if (row.employee_id && row.employee_name && !_complPickerNames.has(row.employee_id)) {
        _complPickerNames.set(row.employee_id, row.employee_name);
      }
    });

    if (!complData || complData.length === 0) {
      _complDetailRows = [];
      _complCaptainRows = [];
      container.innerHTML = '<p class="placeholder-text">No complaints data available. Ensure the "Complaints" sheet exists in the source spreadsheet.</p>';
      return;
    }

    // Filter by date range
    const startVal = document.getElementById('compl-start')?.value;
    const endVal   = document.getElementById('compl-end')?.value;
    const startMs  = startVal ? new Date(startVal).setHours(0,0,0,0)     : -Infinity;
    const endMs    = endVal   ? new Date(endVal).setHours(23,59,59,999)   : Infinity;
    let filteredCompl = complData.filter(r => r.date && r.date >= startMs && r.date <= endMs);
    let filteredDaily = dailyData.filter(r => r.date && r.date >= startMs && r.date <= endMs);

    // Exclude QNG if toggled off
    if (!_complIncludeQNG) {
      filteredCompl = filteredCompl.filter(r => (r.complaint_category || '').toLowerCase() !== 'qng');
    }
    _complDetailRows = filteredCompl;
    _complDetailPeriod = { start: startVal || '', end: endVal || '' };

    if (filteredCompl.length === 0) {
      _complDetailRows = [];
      _complCaptainRows = [];
      container.innerHTML = '<p class="placeholder-text">No complaints data for the selected period.</p>';
      return;
    }

    // Compute (or use cache)
    const cacheKey = `${startVal}_${endVal}_${complData.length}_${filteredDaily.length}_qng${_complIncludeQNG ? 1 : 0}`;
    if (_complCacheKey !== cacheKey) {
      _complCache = compute.computeComplaintAggregations(filteredCompl, filteredDaily);
      _complCacheKey = cacheKey;
    }
    const agg = _complCache;
    if (!agg) return;

    const period = document.getElementById('compl-period')?.value || 'weekly';
    const periodData = period === 'daily' ? agg.storeSummary.dailyArray : period === 'monthly' ? agg.storeSummary.merchantCycle : agg.storeSummary.weekly;
    const totals = agg.storeSummary.totals;

    // Build full HTML
    container.innerHTML = `
      <!-- Stat Cards -->
      <div class="stat-cards-row">
        ${_invStatCard(ICONS.alertTriangle, 'stat-icon-red', 'Total Complaints', _fmt(totals.totalComplaints))}
        ${_invStatCard(ICONS.box, 'stat-icon-orange', 'Orders Affected', _fmt(totals.uniqueOrders))}
        ${_invStatCard(ICONS.barChart, 'stat-icon-amber', 'In-Store Fault Rate', totals.inStoreRate + '%')}
        ${_invStatCard(ICONS.box, 'stat-icon-blue', 'Total Orders Picked', _fmt(totals.totalOrdersPicked))}
      </div>

      <!-- Period Summary Table -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#4edea3;"></span>
          <h3 class="tiers-section-title">Period Summary</h3>
        </div>
        <div id="compl-summary-table"></div>
      </div>

      <!-- Unusual days (control band) -->
      <div id="compl-unusual-days"></div>

      <!-- Zone 1: Trends -->
      <div class="compl-section">
        <div class="bento-grid">
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Trend</h3>
                <p class="bento-card-subtitle">Total complaints vs in-store fault rate</p>
              </div>
            </div>
            <canvas id="chart-compl-trend"></canvas>
          </div>
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">RCA Breakdown</h3>
                <p class="bento-card-subtitle">% of total orders · stacked by root cause</p>
              </div>
            </div>
            <canvas id="chart-compl-rca"></canvas>
          </div>
        </div>
      </div>

      <!-- Zone 2: Category Intelligence -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#fb923c;"></span>
          <h3 class="tiers-section-title">Category Intelligence</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Complaint Categories Over Time</h3>
                <p class="bento-card-subtitle">% of total orders picked · stacked by complaint type</p>
              </div>
              <div class="compl-cat-mode-toggle">
                <button class="compl-cat-mode-btn${_complCatMode === 'total'   ? ' active' : ''}" data-mode="total"   onclick="ui.onComplCatModeChange('total')">Total</button>
                <button class="compl-cat-mode-btn${_complCatMode === 'instore' ? ' active' : ''}" data-mode="instore" onclick="ui.onComplCatModeChange('instore')">In-Store</button>
                <button class="compl-cat-mode-btn${_complCatMode === 'outstore'? ' active' : ''}" data-mode="outstore" onclick="ui.onComplCatModeChange('outstore')">Out-Store</button>
              </div>
            </div>
            <canvas id="chart-compl-category"></canvas>
          </div>
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">L0 Category Table</h3>
                <p class="bento-card-subtitle">Category-level complaints, products, and RCA</p>
              </div>
            </div>
            <div id="compl-category-table-container"></div>
          </div>
        </div>
      </div>

      <!-- Zone 2b: Product Repeat Offenders -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#c084fc;"></span>
          <h3 class="tiers-section-title">Product Repeat Offenders</h3>
          <span class="dd-coach-sub">products with 2+ complaint items in this window — catalogue/stocking candidates, not picker faults</span>
        </div>
        <div id="compl-product-table"></div>
      </div>

      <!-- Zone 3: Captain Performance -->
      <div class="compl-section">
        <div class="tiers-section-header">
          <span class="tiers-section-pip" style="background:#ff6b6b;"></span>
          <h3 class="tiers-section-title">Captain Complaint Performance</h3>
        </div>
        <div class="bento-grid">
          <div class="bento-card bento-full">
            <div class="bento-card-header">
              <div>
                <h3 class="bento-card-title">Orders Picked vs In-Store Complaints</h3>
                <p class="bento-card-subtitle">Each dot is a captain — size = complaint rate</p>
              </div>
            </div>
            <canvas id="chart-compl-scatter"></canvas>
          </div>
        </div>
        <div id="compl-captain-table-container" style="margin-top:16px;"></div>
      </div>
    `;

    // Render period summary table (always uses merchant cycles regardless of weekly/monthly toggle)
    const summaryEl = document.getElementById('compl-summary-table');
    if (summaryEl) {
      summaryEl.innerHTML = _renderComplaintSummaryTable(agg.storeSummary.merchantCycle || []);
      _initTableSort(summaryEl.querySelector('.data-table'));
    }

    // Render charts
    _complCatPeriodData = periodData;
    charts.renderComplaintTrendChart('chart-compl-trend', periodData);
    charts.renderRCADonutChart('chart-compl-rca', periodData);
    charts.renderComplaintCategoryChart('chart-compl-category', periodData, _complCatMode);

    // Render captain scatter
    const captainArr = [...agg.captainPerf.values()].sort((a, b) => b.inStoreYes - a.inStoreYes);
    _complCaptainRows = captainArr;
    _complDetailCaptains = new Map(captainArr.map(c => [c.employee_id || '', c]));
    charts.renderCaptainComplaintScatter('chart-compl-scatter', captainArr);

    // Render captain table
    _renderCaptainComplaintTable(captainArr);

    // Render category table
    _renderCategoryTable(agg.categoryIntel.sorted.l0);

    // Unusual days + product repeat offenders (Phase 4)
    const unusualEl = document.getElementById('compl-unusual-days');
    if (unusualEl) unusualEl.innerHTML = _renderUnusualDaysCard(agg.storeSummary.dailyArray || []);
    const productEl = document.getElementById('compl-product-table');
    if (productEl) {
      productEl.innerHTML = _renderProductOffenderTable(filteredCompl);
      _initTableSort(productEl.querySelector('.data-table'));
    }
  }

  // ── Unusual days (Phase 4) ─────────────────────────────────────────────
  // Poisson-style control band over the window's daily counts: a day is
  // "unusual" when it exceeds mean + 2·√mean. Complaint counts wiggle —
  // only statistically unusual days deserve a root-cause hunt.
  function _renderUnusualDaysCard(dailyArray) {
    if (!dailyArray || dailyArray.length < 7) return '';
    const counts = dailyArray.map(d => d.totalComplaints);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const limit = mean + 2 * Math.sqrt(Math.max(mean, 1));
    const spikes = dailyArray
      .filter(d => d.totalComplaints > limit)
      .sort((a, b) => b.totalComplaints - a.totalComplaints);
    const band = `mean ${mean.toFixed(1)}/day · band limit ${limit.toFixed(1)}`;
    if (!spikes.length) {
      return `
        <div class="compl-section">
          <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#f59e0b;"></span>
            <h3 class="tiers-section-title">Unusual Days</h3><span class="dd-coach-sub">${band}</span></div>
          <p class="attendance-hint">No day in this window broke the control band — the wiggles are noise, not signal.</p>
        </div>`;
    }
    const rows = spikes.slice(0, 7).map(d => {
      const topCat = Object.entries(d.byCategory || {}).sort((a, b) => b[1] - a[1])[0];
      return `<div class="ov-exc-row ov-exc-warn" style="cursor:default">
        <span class="ov-exc-pip"></span>
        <span class="ov-exc-text"><strong>${_esc(d.label)}</strong> — ${d.totalComplaints} complaints (band limit ${limit.toFixed(1)})${topCat ? ` · mostly ${_esc(topCat[0])} (${topCat[1]})` : ''}</span>
      </div>`;
    }).join('');
    return `
      <div class="compl-section">
        <div class="tiers-section-header"><span class="tiers-section-pip" style="background:#f59e0b;"></span>
          <h3 class="tiers-section-title">Unusual Days</h3><span class="dd-coach-sub">${band} · these days deserve a root-cause look</span></div>
        ${rows}
      </div>`;
  }

  // ── Product repeat offenders (Phase 4) ─────────────────────────────────
  function _renderProductOffenderTable(rows) {
    const byProduct = new Map();
    for (const r of rows) {
      const p = r.product_name || 'Unknown';
      let e = byProduct.get(p);
      if (!e) { e = { items: 0, orders: new Set(), inStore: 0, cats: {}, l0: r.l0_category || '—' }; byProduct.set(p, e); }
      e.items++;
      if (r.order_id) e.orders.add(r.order_id);
      if (r.in_store) e.inStore++;
      const c = r.complaint_category || 'unknown';
      e.cats[c] = (e.cats[c] || 0) + 1;
    }
    const top = [...byProduct.entries()]
      .map(([name, e]) => ({
        name, l0: e.l0, items: e.items, orders: e.orders.size,
        inStorePct: e.items ? Math.round(e.inStore / e.items * 100) : 0,
        topCat: Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
      }))
      .filter(p => p.items >= 2 && p.name !== 'Unknown')
      .sort((a, b) => b.items - a.items)
      .slice(0, 15);
    if (!top.length) return '<p class="placeholder-text">No product with 2+ complaint items in this window.</p>';
    return `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th>Product</th><th>L0 Category</th><th>Complaint Items</th><th>Orders Affected</th><th>Top Complaint Type</th><th>In-Store %</th></tr></thead>
          <tbody>
            ${top.map(p => `<tr>
              <td><strong>${_esc(p.name)}</strong></td>
              <td>${_esc(p.l0)}</td>
              <td class="${p.items >= 5 ? 'cell-red' : 'cell-yellow'}">${p.items}</td>
              <td>${p.orders}</td>
              <td>${_esc(p.topCat)}</td>
              <td>${p.inStorePct}%</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function _renderComplaintSummaryTable(periodData) {
    const pct = (num, den, dp = 1) =>
      den > 0 ? _fmt(num / den * 100, dp) + '%' : '—';

    const rows = periodData.map(d => {
      const ord = d.totalOrdersPicked || 0;
      return `<tr>
        <td style="white-space:nowrap;">${_esc(d.label || d.weekKey || d.monthKey)}</td>
        <td>${_fmt(ord)}</td>
        <td>${_fmt(d.totalComplaints)}</td>
        <td>${_fmt(d.inStoreNo)}</td>
        <td>${_fmt(d.inStoreYes)}</td>
        <td>${pct(d.totalComplaints, ord, 2)}</td>
        <td>${pct(d.inStoreNo, ord, 2)}</td>
        <td>${pct(d.inStoreYes, ord, 2)}</td>
        <td>${_fmt(d.missingOutStore)}</td>
        <td>${_fmt(d.missingInStore)}</td>
        <td>${pct(d.missingInStore, ord, 2)}</td>
      </tr>`;
    }).join('');

    return `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Total Orders</th>
              <th>Total Complaints</th>
              <th>Out-Store Complaints</th>
              <th>In-Store Complaints</th>
              <th>Complaint %</th>
              <th>Out-Store Complaint %</th>
              <th>In-Store Complaint %</th>
              <th>Out-Store Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>In-Store Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>In-Store Missing %</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _renderCaptainComplaintRanking(captains) {
    const container = document.getElementById('compl-captain-ranking');
    if (!container) return;

    const top10 = captains.slice(0, 10);
    const maxVal = top10[0]?.inStoreYes || 1;

    container.innerHTML = top10.map((c, i) => {
      const initials = (c.employee_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const pct = Math.round((c.inStoreYes / maxVal) * 100);
      return `
        <div class="compl-ranking-item">
          <span class="compl-ranking-rank">${i + 1}</span>
          <span class="compl-ranking-avatar">${initials}</span>
          <div class="compl-ranking-info">
            <div class="compl-ranking-name">${_esc(c.employee_name)}</div>
            <div class="compl-ranking-sub">${c.complaintRate}% rate · ${_fmt(c.totalOrdersPicked)} orders</div>
          </div>
          <span class="compl-ranking-value">${c.inStoreYes}</span>
          <div class="compl-ranking-bar"><div class="compl-ranking-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  function _complCaptainCategoryOptions(captains) {
    const totals = new Map();
    captains.forEach(c => {
      Object.entries(c.byCategory || {}).forEach(([category, count]) => {
        const key = category || 'unknown';
        totals.set(key, (totals.get(key) || 0) + (Number(count) || 0));
      });
    });

    return [...totals.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([category, count]) => ({ category, count }));
  }

  function _renderCaptainComplaintTable(captains) {
    const container = document.getElementById('compl-captain-table-container');
    if (!container) return;

    const categoryOptions = _complCaptainCategoryOptions(captains);
    const activeExists = _complCaptainCategory === 'all' || categoryOptions.some(opt => opt.category === _complCaptainCategory);
    if (!activeExists) _complCaptainCategory = 'all';

    const activeCategory = _complCaptainCategory;
    const filteredCaptains = activeCategory === 'all'
      ? captains
      : captains.filter(c => ((c.byCategory || {})[activeCategory] || 0) > 0);
    const totalCategoryComplaints = categoryOptions.reduce((sum, opt) => sum + opt.count, 0);

    const categoryButtons = [
      `<button type="button" class="compl-category-filter-btn${activeCategory === 'all' ? ' active' : ''}" data-compl-captain-cat="all">All<span>${_fmt(totalCategoryComplaints)}</span></button>`,
      ...categoryOptions.map(opt => `
        <button type="button" class="compl-category-filter-btn${activeCategory === opt.category ? ' active' : ''}" data-compl-captain-cat="${_esc(opt.category)}">
          ${_esc(opt.category)}<span>${_fmt(opt.count)}</span>
        </button>`),
    ].join('');

    const rows = filteredCaptains.map(c => {
      const rateClass    = c.complaintRate >= 1        ? 'rate-high' : c.complaintRate >= 0.5        ? 'rate-medium' : 'rate-low';
      const pfmRateClass = c.pickerFaultMissingRate >= 1 ? 'rate-high' : c.pickerFaultMissingRate >= 0.5 ? 'rate-medium' : 'rate-low';
      const empId = c.employee_id || '';
      const captainLabel = c.employee_name || empId || 'Unknown Captain';
      const inStoreCell = _renderComplaintDrillCell(c.inStoreYes, empId, 'instore', `View in-store complaints for ${captainLabel}`, true);
      const pfmCell = _renderComplaintDrillCell(c.pickerFaultMissing, empId, 'pfm', `View picker fault missing complaints for ${captainLabel}`);
      const categoryCell = activeCategory === 'all'
        ? _esc(c.topCategory)
        : `<span class="compl-selected-category">
            <span>${_esc(activeCategory)}</span>
            <span class="compl-selected-category-count">${_fmt((c.byCategory || {})[activeCategory] || 0)} complaints</span>
          </span>`;
      return `<tr>
        <td style="font-weight:600;">${_esc(c.employee_name)}</td>
        <td>${_fmt(c.totalOrdersPicked)}</td>
        <td>${c.totalComplaints}</td>
        <td>${inStoreCell}</td>
        <td>${pfmCell}</td>
        <td><span class="compl-rate-badge ${pfmRateClass}">${c.pickerFaultMissingRate ?? 0}%</span></td>
        <td><span class="compl-rate-badge ${rateClass}">${c.complaintRate}%</span></td>
        <td>${categoryCell}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="compl-table-toolbar">
        <span class="compl-table-toolbar-label">Complaint Category</span>
        <div class="compl-category-filter-chips">${categoryButtons}</div>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Captain</th>
              <th>Total Orders</th>
              <th>Total Complaints</th>
              <th>In-Store Yes</th>
              <th>Picker Fault Missing<br><span style="font-size:9px;font-weight:500;opacity:0.65;text-transform:none;letter-spacing:0">(Order Level)</span></th>
              <th>Picker Fault Missing Rate</th>
              <th>Complaint Rate</th>
              <th>${activeCategory === 'all' ? 'Top Category' : 'Selected Category'}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _bindComplaintCaptainCategoryToggles(container);
    _initTableSort(container.querySelector('.data-table'));
    _bindComplaintDrilldowns(container);
  }

  function _bindComplaintCaptainCategoryToggles(container) {
    container.querySelectorAll('[data-compl-captain-cat]').forEach(btn => {
      btn.addEventListener('click', () => onComplCaptainCategoryChange(btn.dataset.complCaptainCat || 'all'));
    });
  }

  function _renderCategoryTable(sortedL0) {
    const container = document.getElementById('compl-category-table-container');
    if (!container) return;

    const rows = sortedL0.map(c => {
      const category = c.category || 'Unknown';
      const complaintsCell = _renderL0ComplaintDrillCell(c.count, category, 'all', `View all complaints for ${category}`);
      const inStoreCell = _renderL0ComplaintDrillCell(c.inStoreYes, category, 'instore', `View in-store complaints for ${category}`, true);
      return `<tr>
        <td style="font-weight:600;">${_esc(category)}</td>
        <td>${complaintsCell}</td>
        <td>${inStoreCell}</td>
        <td>${c.inStorePct}%</td>
        <td style="font-size:12px;">${_esc(c.topProduct)}</td>
        <td style="font-size:12px;">${_esc(c.topRCA)}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>L0 Category</th>
              <th>Complaints</th>
              <th>In-Store Yes</th>
              <th>In-Store %</th>
              <th>Top Product</th>
              <th>Top RCA</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    _initTableSort(container.querySelector('.data-table'));
    _bindComplaintDrilldowns(container);
  }

  function _renderComplaintDrillCell(count, empId, kind, label, danger = false) {
    const n = Number(count) || 0;
    const text = _fmt(n);
    if (n <= 0) {
      return `<span class="compl-drill-empty${danger ? ' compl-drill-danger-text' : ''}">${text}</span>`;
    }
    return `<button type="button"
      class="compl-drill-btn${danger ? ' compl-drill-danger' : ''}"
      data-compl-emp="${_esc(empId || '')}"
      data-compl-kind="${_esc(kind)}"
      aria-label="${_esc(label)}">${text}</button>`;
  }

  function _renderL0ComplaintDrillCell(count, l0Category, kind, label, danger = false) {
    const n = Number(count) || 0;
    const text = _fmt(n);
    if (n <= 0) {
      return `<span class="compl-drill-empty${danger ? ' compl-drill-danger-text' : ''}">${text}</span>`;
    }
    return `<button type="button"
      class="compl-drill-btn${danger ? ' compl-drill-danger' : ''}"
      data-compl-l0="${_esc(l0Category || 'Unknown')}"
      data-compl-kind="${_esc(kind)}"
      aria-label="${_esc(label)}">${text}</button>`;
  }

  function _bindComplaintDrilldowns(container) {
    container.querySelectorAll('.compl-drill-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.dataset.complL0 !== undefined) {
          _showL0ComplaintDetail(btn.dataset.complL0 || 'Unknown', btn.dataset.complKind || 'all');
        } else {
          _showComplaintDetail(btn.dataset.complEmp || '', btn.dataset.complKind || 'instore');
        }
      });
    });
  }

  function _showComplaintDetail(empId, kind) {
    const isPickerMissing = kind === 'pfm';
    const matchesKind = (row) => {
      if (!row.in_store) return false;
      if (!isPickerMissing) return true;
      return (row.complaint_category || '').toLowerCase() === 'item_missing';
    };
    const rows = _complDetailRows
      .filter(row => (row.employee_id || '') === empId && matchesKind(row))
      .slice();

    const captain = _complDetailCaptains.get(empId);
    const captainName = captain?.employee_name || empId || 'Unknown Captain';
    const title = isPickerMissing ? 'Picker Fault Missing' : 'In-Store Yes';
    _showComplaintRowsDetail(rows, title, captainName);
  }

  function _showL0ComplaintDetail(l0Category, kind) {
    const isInStoreOnly = kind === 'instore';
    const rows = _complDetailRows
      .filter(row => {
        const rowL0 = row.l0_category || 'Unknown';
        if (rowL0 !== l0Category) return false;
        return isInStoreOnly ? !!row.in_store : true;
      })
      .slice();
    const title = isInStoreOnly ? 'L0 In-Store Complaints' : 'L0 Complaints';
    _showComplaintRowsDetail(rows, title, l0Category || 'Unknown', { showPickerName: true });
  }

  function _complPickerName(row) {
    const empId = row.employee_id || '';
    return row.employee_name
      || _complDetailCaptains.get(empId)?.employee_name
      || _complPickerNames.get(empId)
      || empId
      || 'Unknown';
  }

  function _showComplaintRowsDetail(rows, title, heading, options = {}) {
    const showPickerName = !!options.showPickerName;
    const sortedRows = rows
      .slice()
      .sort((a, b) => (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0));

    _closeComplaintDetail();
    if (sortedRows.length === 0) return;

    const uniqueOrders = new Set(rows.map(r => r.order_id).filter(Boolean)).size;
    const periodText = _complDetailPeriod.start && _complDetailPeriod.end
      ? `${_complDetailPeriod.start} to ${_complDetailPeriod.end}`
      : 'Selected period';

    const bodyRows = sortedRows.map(r => `
      <tr>
        <td style="white-space:nowrap;">${_esc(r.dateStr || _isoDateStr(r.date))}</td>
        <td>${_esc(r.order_id || '—')}</td>
        ${showPickerName ? `<td>${_esc(_complPickerName(r))}</td>` : ''}
        <td class="compl-detail-product">${_esc(r.product_name || '—')}</td>
        <td>${_esc(r.complaint_category || 'unknown')}</td>
        <td class="compl-detail-rca">${_esc(r.rca || '—')}</td>
        <td>${_esc(r.l0_category || '—')}</td>
        <td>${_esc(r.l1_category || '—')}</td>
      </tr>
    `).join('');

    const modal = document.createElement('div');
    modal.id = 'compl-detail-modal';
    modal.className = 'compl-detail-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'compl-detail-title');
    modal.innerHTML = `
      <div class="compl-detail-modal">
        <div class="compl-detail-header">
          <div>
            <p class="compl-detail-kicker">${_esc(title)}</p>
            <h3 id="compl-detail-title">${_esc(heading)}</h3>
            <p class="compl-detail-subtitle">${_esc(periodText)}</p>
          </div>
          <button type="button" class="compl-detail-close" aria-label="Close complaint details">&times;</button>
        </div>
        <div class="compl-detail-summary">
          <span>${_fmt(uniqueOrders)} unique order${uniqueOrders === 1 ? '' : 's'}</span>
          <span>${_fmt(sortedRows.length)} complaint row${sortedRows.length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-wrapper compl-detail-table-wrapper">
          <table class="data-table compl-detail-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Order ID</th>
                ${showPickerName ? '<th>Picker Name</th>' : ''}
                <th>Product</th>
                <th>Complaint Category</th>
                <th>RCA</th>
                <th>L0</th>
                <th>L1</th>
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.querySelector('.compl-detail-close')?.addEventListener('click', _closeComplaintDetail);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) _closeComplaintDetail();
    });
    _complDetailEscHandler = (event) => {
      if (event.key === 'Escape') _closeComplaintDetail();
    };
    document.addEventListener('keydown', _complDetailEscHandler);
    _initTableSort(modal.querySelector('.data-table'));
    modal.querySelector('.compl-detail-close')?.focus();
  }

  function _closeComplaintDetail() {
    document.getElementById('compl-detail-modal')?.remove();
    if (_complDetailEscHandler) {
      document.removeEventListener('keydown', _complDetailEscHandler);
      _complDetailEscHandler = null;
    }
  }

