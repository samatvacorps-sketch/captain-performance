/**
 * config-panel.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

  // ── Config Panel ───────────────────────────────────────────────────────

  // ── Slab Config Helpers ───────────────────────────────────────────────

  function _secsToMmss(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function _mmssToSecs(str) {
    const parts = String(str).split(':');
    const m = parseInt(parts[0]) || 0;
    const s = parseInt(parts[1]) || 0;
    return m * 60 + s;
  }

  function _populateSlabTable(tableId, slabs) {
    const tbody = document.getElementById(tableId)?.querySelector('tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    slabs.forEach((slab, i) => {
      if (!rows[i]) return;
      rows[i].querySelector('.slab-time').value   = _secsToMmss(slab.maxTime);
      rows[i].querySelector('.slab-amount').value = slab.amount;
    });
  }

  function _readSlabTable(tableId) {
    const tbody = document.getElementById(tableId)?.querySelector('tbody');
    if (!tbody) return [];
    return [...tbody.querySelectorAll('tr')].map(row => ({
      maxTime: _mmssToSecs(row.querySelector('.slab-time').value),
      amount:  parseInt(row.querySelector('.slab-amount').value) || 0,
    }));
  }

  /**
   * Effective slab override for a month: sheet Config `incentiveSlabs.<month>`
   * wins over the localStorage editor, which wins over the code defaults
   * (null = defaults). Both the Config panel and renderIncentives use this.
   */
  function _getSlabOverride(monthKey) {
    const sheetOv = cfg.get(`incentiveSlabs.${monthKey}`, null);
    if (sheetOv && typeof sheetOv === 'object') return { ...sheetOv, _source: 'sheet' };
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    return overrides[monthKey] || null;
  }

  function loadSlabMonth() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const ov = _getSlabOverride(monthKey);
    const fromSheet = ov?._source === 'sheet';
    const slabs400 = ov?.slabs400 || compute.PICKING_SLABS_400;
    const slabs800 = ov?.slabs800 || compute.PICKING_SLABS_800;
    _populateSlabTable('slab-table-400', slabs400);
    _populateSlabTable('slab-table-800', slabs800);
    const t400Input = document.getElementById('order-threshold-400');
    const t800Input = document.getElementById('order-threshold-800');
    if (t400Input) t400Input.value = ov?.threshold400 ?? 400;
    if (t800Input) t800Input.value = ov?.threshold800 ?? 800;
    const resetBtn = document.getElementById('slab-reset-btn');
    if (resetBtn) resetBtn.style.display = (ov && !fromSheet) ? '' : 'none';
    const savedMsg = document.getElementById('slab-saved-msg');
    if (savedMsg) savedMsg.style.display = 'none';
    const noteEl = document.getElementById('slab-override-note');
    if (noteEl) {
      noteEl.textContent = fromSheet
        ? `Set in the Google Sheet Config tab for ${monthKey} — sheet values override this panel`
        : ov ? `Custom criteria active for ${monthKey}` : `Using default criteria for ${monthKey}`;
    }
  }

  function saveSlabOverrides() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const slabs400     = _readSlabTable('slab-table-400');
    const slabs800     = _readSlabTable('slab-table-800');
    const threshold400 = parseInt(document.getElementById('order-threshold-400')?.value) || 400;
    const threshold800 = parseInt(document.getElementById('order-threshold-800')?.value) || 800;
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    overrides[monthKey] = { slabs400, slabs800, threshold400, threshold800 };
    localStorage.setItem('incentiveSlabOverrides', JSON.stringify(overrides));
    _incentiveCache    = null;
    _incentiveCacheKey = null;
    const resetBtn = document.getElementById('slab-reset-btn');
    if (resetBtn) resetBtn.style.display = '';
    const noteEl = document.getElementById('slab-override-note');
    if (noteEl) noteEl.textContent = `Custom criteria active for ${monthKey}`;
    const savedMsg = document.getElementById('slab-saved-msg');
    if (savedMsg) {
      savedMsg.style.display = '';
      setTimeout(() => { savedMsg.style.display = 'none'; }, 2000);
    }
  }

  function resetSlabOverrides() {
    const monthKey = document.getElementById('slab-month-picker')?.value;
    if (!monthKey) return;
    const overrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    delete overrides[monthKey];
    localStorage.setItem('incentiveSlabOverrides', JSON.stringify(overrides));
    _incentiveCache    = null;
    _incentiveCacheKey = null;
    loadSlabMonth();
  }

  // ── SLA Targets config helpers ────────────────────────────────────
  function _slaTargetRow(label, metric, tiers, arrow) {
    const step = metric === 'complaints' ? '0.01' : '0.1';
    const cell = tier => `<td><input class="slab-threshold-input" id="sla-${metric}-${tier}" type="number" min="0" max="100" step="${step}" value="${tiers[tier]}" /></td>`;
    return `<tr>
      <td style="font-weight:600">${label} <span style="color:var(--text-muted)">${arrow}</span></td>
      ${cell('baseline')}${cell('sla1')}${cell('sla2')}
    </tr>`;
  }

  function loadSlaTargetCycle() {
    const cycle = document.getElementById('sla-target-cycle')?.value;
    if (!cycle) return;
    const t = _getSlaTargets(cycle);
    for (const m of _KM_METRICS) for (const tier of _KM_TIERS) {
      const el = document.getElementById(`sla-${m}-${tier}`);
      if (el) el.value = t[m][tier];
    }
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const note = document.getElementById('sla-target-note');
    if (note) {
      note.textContent = cfg.has(`slaTargets.${cycle}`)
        ? 'Targets set in the Google Sheet Config tab — sheet values override this panel'
        : all[cycle] ? 'Custom targets set for this cycle (this browser only)' : 'Using default targets';
    }
  }

  function updateSlaTarget() {
    const cycle = document.getElementById('sla-target-cycle')?.value;
    if (!cycle) return;
    const all = JSON.parse(localStorage.getItem('slaTargets') || '{}');
    const obj = {};
    for (const m of _KM_METRICS) {
      obj[m] = {};
      for (const tier of _KM_TIERS) {
        const v = parseFloat(document.getElementById(`sla-${m}-${tier}`)?.value);
        obj[m][tier] = isNaN(v) ? undefined : v;
      }
    }
    all[cycle] = obj;
    localStorage.setItem('slaTargets', JSON.stringify(all));
    const note = document.getElementById('sla-target-note');
    if (note) note.textContent = 'Custom targets set for this cycle';
    const msg = document.getElementById('sla-target-saved-msg');
    if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
  }

  function toggleComplaintSlaCategory() {
    const boxes = document.querySelectorAll('.km-cat-checklist input[type="checkbox"]');
    const checked = [...boxes].filter(b => b.checked).map(b => b.dataset.cat);
    localStorage.setItem('complaintSlaCategories', JSON.stringify(checked));
  }

  function renderConfigPanel() {
    const container = document.getElementById('config-content');
    if (!container) return;

    const rowCount = sheets.getCached().length.toLocaleString();

    const metricsRows = CONFIG.METRICS.map(m => `<tr>
      <td>${m.label}</td>
      <td><span class="config-flow-tag">${m.flow.charAt(0).toUpperCase() + m.flow.slice(1)}</span></td>
      <td>${m.direction === 'HIGH'
        ? `${ICONS.arrowUp} <span style="vertical-align:middle">High = Bad</span>`
        : `${ICONS.arrowDown} <span style="vertical-align:middle">Low = Bad</span>`}</td>
    </tr>`).join('');

    const exclTags = [..._customExcludedIds].map(id => `
      <span class="config-excl-tag">
        ${_esc(id)}
        <button class="config-excl-tag-remove" onclick="ui.removeExcludedId('${_esc(id)}')" title="Remove">&times;</button>
      </span>`).join('');

    const defaultSlabs400 = compute.PICKING_SLABS_400;
    const defaultSlabs800 = compute.PICKING_SLABS_800;
    const slabRows = (slabs) => slabs.map(s => `
      <tr>
        <td><input class="slab-time" type="text" value="${_secsToMmss(s.maxTime)}" placeholder="m:ss" /></td>
        <td><input class="slab-amount" type="number" value="${s.amount}" min="0" step="25" /></td>
      </tr>`).join('');

    const curMonth = new Date().toISOString().slice(0, 7);
    const existingOverrides = JSON.parse(localStorage.getItem('incentiveSlabOverrides') || '{}');
    const hasOverride = !!existingOverrides[curMonth];

    // ── SLA Targets card data ──
    const _slaDaily = sheets.getCached();
    const slaCycleList = (_slaDaily && _slaDaily.length)
      ? compute.aggregateBillingMonthly(_slaDaily.map(r => ({ date: r.date, dateStr: r.dateStr, employee_id: r.employee_id }))).map(d => d.month_key)
      : [];
    const slaTargetCycle = (_kmCycleKey && slaCycleList.includes(_kmCycleKey))
      ? _kmCycleKey
      : (slaCycleList[slaCycleList.length - 1] || curMonth);
    const slaT = _getSlaTargets(slaTargetCycle);
    const slaCycleOptions = (slaCycleList.length ? slaCycleList : [curMonth]).slice().reverse()
      .map(k => `<option value="${k}"${k === slaTargetCycle ? ' selected' : ''}>${_billingMonthLabel(k)}</option>`).join('');
    const complCats = [...new Set((sheets.getComplaintsCached() || []).map(r => r.complaint_category).filter(Boolean))].sort();
    const _savedCatSet = _getComplaintSlaCategorySet();
    const catChecks = complCats.map(cat => {
      const checked = _savedCatSet ? _savedCatSet.has(cat.toLowerCase()) : !_KM_EXCLUDE_RE.test(cat.toLowerCase());
      return `<label class="km-cat-check"><input type="checkbox" data-cat="${_esc(cat)}" ${checked ? 'checked' : ''} onchange="ui.toggleComplaintSlaCategory()"> ${_esc(cat)}</label>`;
    }).join('');

    const sheetCfgCard = cfg.hasSheetConfig() ? `
      <div class="config-card" style="grid-column: 1 / -1;">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-green">${ICONS.layers}</div>
          <h3>Sheet Config Active</h3>
        </div>
        <p class="config-desc">${cfg.keyCount()} setting${cfg.keyCount() === 1 ? '' : 's'} loaded from the <strong>Config</strong> tab of the main spreadsheet. Sheet values override anything saved in this panel, so every device sees the same numbers. Edit them in the sheet and hit Refresh.</p>
        <div class="config-excl-list">${cfg.keys().map(k => `<span class="config-excl-tag">${_esc(k)}</span>`).join('')}</div>
      </div>` : `
      <div class="config-card" style="grid-column: 1 / -1;">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-purple">${ICONS.layers}</div>
          <h3>Sheet Config Not Set Up</h3>
        </div>
        <p class="config-desc">No <strong>Config</strong> tab found in the main spreadsheet, so settings below are saved per browser (your phone and laptop can disagree). Run <code class="config-code">setupConfigTab()</code> from <code class="config-code">google-apps-script/config-setup.gs</code> in the sheet's Apps Script editor to create it pre-filled with the current defaults.</p>
      </div>`;

    container.innerHTML = `
      ${sheetCfgCard}
      ${_buildDataHealthCard()}
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-teal">${ICONS.layers}</div>
          <h3>Data Source</h3>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Spreadsheet</span>
          <code class="config-code">${CONFIG.SPREADSHEET_ID}</code>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Sheet</span>
          <span class="config-detail-value">Daily Metrics (A:V) · Audits · Complaints · Roster · PNAs · In-store Time (separate book)</span>
        </div>
        <div class="config-detail-row">
          <span class="dd-control-label">Rows loaded</span>
          <span class="config-detail-value">${rowCount}</span>
        </div>
      </div>
      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-purple">${ICONS.person}</div>
          <h3>Excluded Captains</h3>
        </div>
        <p class="config-desc">Captain IDs excluded from all calculations when "Excl. Captains" is active.</p>
        <div class="config-excl-input-row">
          <input type="text" id="excl-id-input" placeholder="e.g. DLES123456"
                 onkeydown="if(event.key==='Enter')ui.addExcludedId()" />
          <button class="btn" onclick="ui.addExcludedId()">Add</button>
        </div>
        <div class="config-excl-list">
          ${exclTags || '<span class="config-hint">No custom IDs added yet.</span>'}
        </div>
        <p class="config-hint" style="margin-top:8px">Fixed supervisor IDs (${(CONFIG.SUPERVISOR_IDS || []).join(', ')}) are always included in the toggle.</p>
      </div>
      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-green">${ICONS.barChart}</div>
          <h3>Metric Definitions</h3>
        </div>
        <div class="table-wrapper">
          <table class="data-table config-table">
            <thead><tr><th>Metric</th><th>Flow</th><th>Direction</th></tr></thead>
            <tbody>${metricsRows}</tbody>
          </table>
        </div>
      </div>
      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-amber">${ICONS.flag}</div>
          <h3>Picking Incentive Criteria</h3>
        </div>
        <p class="config-desc">Configure time-based picking incentive slabs per month. Changes apply to the Incentives tab for the selected month.</p>
        <div class="config-month-row">
          <span class="dd-control-label">Month</span>
          <input type="month" id="slab-month-picker" value="${curMonth}" onchange="ui.loadSlabMonth()" />
          <span id="slab-override-note" class="config-hint" style="margin-left:8px">${hasOverride ? `Custom criteria active for ${curMonth}` : `Using default criteria for ${curMonth}`}</span>
        </div>
        <div class="slab-tables-grid">
          <div>
            <div class="slab-threshold-row">
              <input class="slab-threshold-input" id="order-threshold-400" type="number" min="1" step="50"
                     value="${existingOverrides[curMonth]?.threshold400 ?? 400}" />
              <span class="config-hint" style="opacity:1;font-weight:600">+ Orders / Week</span>
            </div>
            <table class="slab-editor-table" id="slab-table-400">
              <thead><tr><th>Max Time (m:ss)</th><th>Amount (&#8377;)</th></tr></thead>
              <tbody>${slabRows(existingOverrides[curMonth]?.slabs400 || defaultSlabs400)}</tbody>
            </table>
          </div>
          <div>
            <div class="slab-threshold-row">
              <input class="slab-threshold-input" id="order-threshold-800" type="number" min="1" step="50"
                     value="${existingOverrides[curMonth]?.threshold800 ?? 800}" />
              <span class="config-hint" style="opacity:1;font-weight:600">+ Orders / Week</span>
            </div>
            <table class="slab-editor-table" id="slab-table-800">
              <thead><tr><th>Max Time (m:ss)</th><th>Amount (&#8377;)</th></tr></thead>
              <tbody>${slabRows(existingOverrides[curMonth]?.slabs800 || defaultSlabs800)}</tbody>
            </table>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.saveSlabOverrides()">Save for Month</button>
          <button class="btn" id="slab-reset-btn" onclick="ui.resetSlabOverrides()" style="${hasOverride ? '' : 'display:none'}">Reset to Default</button>
          <span id="slab-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <p class="config-hint" style="margin-top:6px">Time is the upper bound (exclusive). Rows without a match earn &#8377;0.</p>
      </div>

      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-blue">${ICONS.barChart}</div>
          <h3>SLA Targets (Key Metrics)</h3>
        </div>
        <p class="config-desc">Three-tiered per-cycle targets (Baseline / SLA 1 / SLA 2) shown on the Key Metrics tab. In-store &amp; fill-rate are "higher is better"; complaints is "lower is better".</p>
        <div class="config-month-row">
          <span class="dd-control-label">Cycle</span>
          <select id="sla-target-cycle" onchange="ui.loadSlaTargetCycle()">${slaCycleOptions}</select>
          <span id="sla-target-note" class="config-hint" style="margin-left:8px"></span>
        </div>
        <table class="slab-editor-table sla-target-table" style="margin-top:14px">
          <thead><tr><th>Metric</th><th>Baseline (%)</th><th>SLA 1 (%)</th><th>SLA 2 (%)</th></tr></thead>
          <tbody>
            ${_slaTargetRow('In-Store Time', 'instore', slaT.instore, '↑')}
            ${_slaTargetRow('Complaints', 'complaints', slaT.complaints, '↓')}
            ${_slaTargetRow('Fill Rate', 'fillrate', slaT.fillrate, '↑')}
          </tbody>
        </table>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.updateSlaTarget()">Save Targets</button>
          <span id="sla-target-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <div style="margin-top:18px">
          <span class="dd-control-label">Qualifying Complaint Categories</span>
          <p class="config-hint" style="margin:4px 0 8px">Checked categories count toward the Complaints SLA. MDND, Poor-Quality and QNG are excluded by default.</p>
          <div class="km-cat-checklist">
            ${complCats.length ? catChecks : '<span class="config-hint">No complaint categories loaded yet.</span>'}
          </div>
        </div>
      </div>

      <div class="config-card config-card-wide">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-red">${ICONS.flag}</div>
          <h3>Flow SD Thresholds</h3>
        </div>
        <p class="config-desc">Per-flow SD thresholds for cell coloring and flagging. Borderline SD also determines when a captain is flagged in weekly/monthly view.</p>
        <table class="slab-editor-table flow-threshold-table">
          <thead><tr><th>Flow</th><th>Critical SD</th><th>Flagged SD</th><th>Borderline SD</th></tr></thead>
          <tbody>
            ${_FT_FLOWS.map(flow => {
              const ft = _getFlowThresholds(flow);
              const label = flow.charAt(0).toUpperCase() + flow.slice(1);
              return `<tr>
                <td style="font-weight:600">${label}</td>
                <td><input class="slab-threshold-input" id="ft-${flow}-critical"   type="number" value="${ft.critical}"   min="0.1" step="0.1" /></td>
                <td><input class="slab-threshold-input" id="ft-${flow}-flagged"    type="number" value="${ft.flagged}"    min="0.1" step="0.1" /></td>
                <td><input class="slab-threshold-input" id="ft-${flow}-borderline" type="number" value="${ft.borderline}" min="0.1" step="0.1" /></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="config-row" style="margin-top:16px;gap:24px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">SD Multiplier</span>
            <input type="number" id="threshold-input" min="0.5" max="3" step="0.1" value="${CONFIG.THRESHOLD}"
                   style="width:90px" onchange="app.updateThreshold(this.value)" />
            <span class="config-hint" style="margin-top:2px">Daily flag threshold. Default 1.0.</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Floor Deviation</span>
            <input type="number" id="floor-deviation-input" min="0.05" max="0.95" step="0.05"
                   value="${CONFIG.FLOOR_DEVIATION ?? 0.30}" style="width:90px"
                   onchange="app.updateFloorDeviation(this.value)" />
            <span class="config-hint" style="margin-top:2px">Flag if &gt;${Math.round((CONFIG.FLOOR_DEVIATION ?? 0.30) * 100)}% worse than mean. Default 0.30.</span>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.saveFlowThresholds()">Save</button>
          <button class="btn" onclick="ui.resetFlowThresholds()">Reset to Default</button>
          <span id="flow-thresholds-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
        <p class="config-hint" style="margin-top:6px">Defaults — Picking/Audit: 0.5 · 0.25 · 0.1 &nbsp;|&nbsp; Putting: 0.25 · 0.1 · 0.01 &nbsp;|&nbsp; FNV: 2.0 · 1.0 · 0.5</p>
      </div>

      <div class="config-card">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-teal">${ICONS.barChart}</div>
          <h3>Productivity Weights</h3>
        </div>
        <p class="config-hint" style="margin-bottom:12px">Each activity is converted to <strong>item-equivalents</strong> using these multipliers, then summed to compute the Productivity and IPH charts.<br><br><code>Productivity = (Orders × W<sub>order</sub>) + (Putaway Items × W<sub>putaway</sub>) + (Racks Audited × W<sub>rack</sub>)</code></p>
        <div class="config-row" style="align-items:flex-end;gap:24px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Order Weight (W<sub>order</sub>)</span>
            <input type="number" id="pw-order" min="0.1" step="0.5"
                   value="${_getProductivityWeights().order}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per order picked. Default: ${_PW_DEFAULTS.order}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Putaway Weight (W<sub>putaway</sub>)</span>
            <input type="number" id="pw-putaway" min="0.1" step="0.1"
                   value="${_getProductivityWeights().putaway}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per putaway item. Default: ${_PW_DEFAULTS.putaway}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Rack Weight (W<sub>rack</sub>)</span>
            <input type="number" id="pw-rack" min="1" step="5"
                   value="${_getProductivityWeights().rack}" style="width:100px" />
            <span class="config-hint" style="margin-top:2px">Item-eq per rack audited. Default: ${_PW_DEFAULTS.rack}</span>
          </div>
        </div>
        <div class="config-row" style="margin-top:14px;gap:8px">
          <button class="btn active" onclick="ui.updateProductivityWeights()">Save</button>
          <button class="btn" onclick="ui.resetProductivityWeights()">Reset to Default</button>
          <span id="pw-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
        </div>
      </div>

      <div class="config-card">
        <h3 class="config-card-title">Staff Availability</h3>
        <p class="config-hint" style="margin-bottom:12px">Controls the divisor in the formula: <strong>Active Hours − (Orders ÷ X)</strong>. Adjust X to reflect how many orders one captain-hour of capacity should handle.</p>
        <div class="config-row" style="align-items:flex-end;gap:16px">
          <div style="display:flex;flex-direction:column;gap:4px">
            <span class="dd-control-label">Orders per Captain-Hour (X)</span>
            <input type="number" id="staff-avail-divisor-input" min="0.1" step="0.1"
                   value="${_getStaffAvailDivisor()}" style="width:100px"
                   onchange="ui.updateStaffAvailDivisor(this.value)" />
            <span class="config-hint" style="margin-top:2px">Default: ${_STAFF_AVAIL_DEFAULT_DIVISOR}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn" onclick="ui.resetStaffAvailDivisor()">Reset to Default</button>
            <span id="staff-avail-saved-msg" class="slab-saved-msg" style="display:none">Saved!</span>
          </div>
        </div>
      </div>
    `;
    container.querySelectorAll('.config-table').forEach(t => _initTableSort(t));
  }


  // ── Data Health (Phase 5) ──────────────────────────────────────────────
  // Surfaces what the parsers silently do: rows dropped on parse, IDs that
  // don't join across sheets, and calendar days with no Daily Metrics rows.
  function _buildDataHealthCard() {
    const daily = sheets.getCached();
    if (!daily || daily.length === 0) return '';

    const stats = sheets.getParseStats();
    const DATASETS = [
      ['daily', 'Daily Metrics'], ['audits', 'Audits'], ['complaints', 'Complaints'],
      ['instore', 'In-store Time'], ['pna', 'PNAs'], ['roster', 'Roster'],
    ];
    const parseRows = DATASETS.map(([key, label]) => {
      const s = stats[key];
      if (!s) return `<tr><td>${label}</td><td colspan="3" style="color:var(--text-muted)">served from session cache — refresh for live counts</td></tr>`;
      const dropped = s.fetched - s.parsed;
      return `<tr>
        <td>${label}</td>
        <td>${_fmt(s.fetched)}</td>
        <td>${_fmt(s.parsed)}</td>
        <td class="${dropped > 0 ? 'cell-yellow' : ''}">${_fmt(dropped)}</td>
      </tr>`;
    }).join('');

    // Cross-sheet ID joins (normalized the same way attendance does)
    const norm = id => _cleanAttendanceId(id);
    const dailyIds = new Set(daily.map(r => norm(r.employee_id)).filter(Boolean));
    const orphanCount = (rows, field) => {
      const bad = new Set();
      for (const r of rows) {
        const id = norm(r[field]);
        if (id && !dailyIds.has(id)) bad.add(id);
      }
      return bad;
    };
    const instOrphans = orphanCount(sheets.getInstoreCached() || [], 'employee_id');
    const complOrphans = orphanCount((sheets.getComplaintsCached() || []).filter(r => r.employee_id), 'employee_id');
    const rosterOrphans = orphanCount(sheets.getRosterCached() || [], 'employee_id');
    const pnaOrphans = orphanCount((sheets.getPnaCached() || []).filter(r => r.employee_id), 'employee_id');
    const orphanRow = (label, set) => `<tr>
      <td>${label}</td>
      <td class="${set.size > 0 ? 'cell-yellow' : 'cell-green'}">${set.size}</td>
      <td style="color:var(--text-muted)">${set.size ? _esc([...set].slice(0, 3).join(', ')) + (set.size > 3 ? ' …' : '') : 'all IDs match Daily Metrics'}</td>
    </tr>`;

    // Missing days inside the daily span
    const DAY = 86400000;
    const isoDays = new Set(daily.map(r => r.dateIsoStr).filter(Boolean));
    let missingDays = [];
    if (isoDays.size > 1) {
      const sorted = [...isoDays].sort();
      const start = new Date(`${sorted[0]}T00:00:00`);
      const end = new Date(`${sorted[sorted.length - 1]}T00:00:00`);
      for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
        const iso = _isoDateStr(new Date(t));
        if (!isoDays.has(iso)) missingDays.push(iso);
      }
    }

    // Duplicate in-store order rows
    const instRows = sheets.getInstoreCached() || [];
    const seenOrders = new Set();
    let dupOrders = 0;
    for (const r of instRows) {
      if (!r.order_id) continue;
      if (seenOrders.has(r.order_id)) dupOrders++;
      else seenOrders.add(r.order_id);
    }

    return `
      <div class="config-card" style="grid-column: 1 / -1;">
        <div class="config-card-header">
          <div class="config-card-icon stat-icon-amber">${ICONS.alertTriangle || ICONS.layers}</div>
          <h3>Data Health</h3>
        </div>
        <div class="table-wrapper" style="margin-bottom:12px;">
          <table class="data-table">
            <thead><tr><th>Sheet</th><th>Rows Fetched</th><th>Parsed</th><th>Dropped</th></tr></thead>
            <tbody>${parseRows}</tbody>
          </table>
        </div>
        <div class="table-wrapper" style="margin-bottom:12px;">
          <table class="data-table">
            <thead><tr><th>Cross-sheet Join</th><th>Unmatched IDs</th><th>Sample</th></tr></thead>
            <tbody>
              ${orphanRow('In-store picker_id → Daily Metrics', instOrphans)}
              ${orphanRow('Complaints employee_id → Daily Metrics', complOrphans)}
              ${orphanRow('Roster employee_id → Daily Metrics', rosterOrphans)}
              ${orphanRow('PNA picker_id → Daily Metrics', pnaOrphans)}
            </tbody>
          </table>
        </div>
        <p class="config-desc">
          <strong>${missingDays.length}</strong> day${missingDays.length === 1 ? '' : 's'} missing inside the Daily Metrics span${missingDays.length ? ` (${_esc(missingDays.slice(0, 8).join(', '))}${missingDays.length > 8 ? ' …' : ''})` : ''} ·
          <strong>${_fmt(dupOrders)}</strong> duplicate order rows in the in-store feed ·
          durations ≥ 10 days are silently zeroed by the parser (by design).
        </p>
      </div>`;
  }
