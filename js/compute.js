/**
 * compute.js — All statistical computation and flagging logic
 *
 * Pipeline:
 *  1. computeFlowFlags(row)         → is_picking, is_putting, is_audit, is_fnv
 *  2. computeFNVRate(row)           → fnv_audit_rate (audited_qty / fnv_active_hours)
 *  3. computeStoreStats(data)       → per-date, per-metric: { avg, sd }
 *  4. computePersonalAvgs(data)     → per-captain, per-metric: historical avg
 *  5. flagSlackers(data, ...)       → flag columns + composite_slacker_score
 *  6. aggregateWeekly(data)         → grouped by ISO week
 *  7. aggregateMonthly(data)        → grouped by year-month
 */

const compute = (() => {

  // ── 1. Flow Flags ────────────────────────────────────────────────────

  function computeFlowFlags(row) {
    return {
      is_picking: row.picker_active_time > 0,
      is_putting: row.putter_active_time > 0,
      is_audit:   row.auditor_active_time > 0,
      is_fnv:     row.fnv_active_time > 0,
    };
  }

  // ── 2. FNV Audit Rate ────────────────────────────────────────────────

  function computeFNVRate(row) {
    const hours = row.fnv_active_time / 3600;
    if (hours <= 0) return 0;
    return row.audited_qty / hours;
  }

  // ── 3. Store Statistics ──────────────────────────────────────────────

  /**
   * Computes per-date store averages and standard deviations for each metric.
   * Only includes captains who were active in the relevant flow for that date.
   *
   * Returns: Map<dateStr, Map<metricKey, { avg, sd, n }>>
   */
  function computeStoreStats(data) {
    // Group by date
    const byDate = _groupBy(data, 'dateStr');
    const result = new Map();

    for (const [dateStr, rows] of Object.entries(byDate)) {
      const metricMap = new Map();

      for (const metric of CONFIG.METRICS) {
        // Filter to rows active in the relevant flow
        const activeRows = rows.filter(r => _isActiveInFlow(r, metric.flow));
        if (activeRows.length < 2) {
          metricMap.set(metric.key, { avg: null, sd: null, n: activeRows.length });
          continue;
        }

        const values = activeRows.map(r => _getMetricValue(r, metric.key));
        const validValues = values.filter(v => v !== null && !isNaN(v));

        if (validValues.length < 2) {
          metricMap.set(metric.key, { avg: null, sd: null, n: validValues.length });
          continue;
        }

        const avg = _mean(validValues);
        const sd  = _stdDev(validValues, avg);
        metricMap.set(metric.key, { avg, sd, n: validValues.length });
      }

      result.set(dateStr, metricMap);
    }

    return result;
  }

  // ── 4. Personal Averages ─────────────────────────────────────────────

  /**
   * Computes rolling historical average per captain per metric,
   * using ALL rows up to (but not including) the current row.
   *
   * For simplicity, returns the overall historical average per captain
   * (using all data). Drill-down shows this as the captain's baseline.
   *
   * Returns: Map<employeeId, Map<metricKey, number>>
   */
  function computePersonalAvgs(data) {
    const byCaptain = _groupBy(data, 'employee_id');
    const result = new Map();

    for (const [empId, rows] of Object.entries(byCaptain)) {
      const metricMap = new Map();

      for (const metric of CONFIG.METRICS) {
        const activeRows = rows.filter(r => _isActiveInFlow(r, metric.flow));
        if (activeRows.length === 0) {
          metricMap.set(metric.key, null);
          continue;
        }
        const values = activeRows.map(r => _getMetricValue(r, metric.key))
                                  .filter(v => v !== null && !isNaN(v) && v > 0);
        metricMap.set(metric.key, values.length > 0 ? _mean(values) : null);
      }

      result.set(empId, metricMap);
    }

    return result;
  }

  // ── 5. Flag Slackers ─────────────────────────────────────────────────

  /**
   * Enriches each row with flag data.
   *
   * Adds to each row:
   *   - flows: { is_picking, is_putting, is_audit, is_fnv }
   *   - fnv_audit_rate: number
   *   - flags: Map<metricKey, boolean>
   *   - deviations: Map<metricKey, number>  (in SDs from store avg, positive = worse)
   *   - composite_slacker_score: number
   *   - active_flows: string (e.g. "Picking, Putting")
   *
   * @param {Array} data - parsed rows
   * @param {Map} storeStats - from computeStoreStats()
   * @param {Map} personalAvgs - from computePersonalAvgs()
   * @param {number} threshold - SD multiplier (default 1.0)
   */
  function flagSlackers(data, storeStats, personalAvgs, threshold = 1.0, thresholdMap = null) {
    return data.map(row => {
      const flows = computeFlowFlags(row);
      const fnvRate = computeFNVRate(row);
      const auditHPR = (row.auditor_active_time > 0 && row.racks_audited > 0)
        ? (row.auditor_active_time / 3600) / row.racks_audited
        : null;
      const enriched = { ...row, flows, fnv_audit_rate: fnvRate, audit_hours_per_rack: auditHPR };

      const flags = new Map();
      const deviations = new Map();
      const dateStats = storeStats.get(row.dateStr);
      const captainAvgs = personalAvgs.get(row.employee_id);

      for (const metric of CONFIG.METRICS) {
        // Skip if captain not active in this flow
        if (!_isActiveInFlow(row, metric.flow)) {
          flags.set(metric.key, false);
          deviations.set(metric.key, null);
          continue;
        }

        const value = _getMetricValue(enriched, metric.key);
        if (value === null || isNaN(value)) {
          flags.set(metric.key, false);
          deviations.set(metric.key, null);
          continue;
        }

        const stats = dateStats?.get(metric.key);
        if (!stats || stats.avg === null || stats.sd === null || stats.sd === 0) {
          flags.set(metric.key, false);
          deviations.set(metric.key, null);
          continue;
        }

        const personalAvg = captainAvgs?.get(metric.key) ?? null;

        // Deviation in SDs (positive = worse for HIGH=bad metrics)
        let devSD;
        if (metric.direction === 'HIGH') {
          devSD = (value - stats.avg) / stats.sd; // positive = worse
        } else {
          devSD = (stats.avg - value) / stats.sd; // positive = worse
        }

        deviations.set(metric.key, devSD);

        // Flag if BOTH: devSD > threshold AND worse than personal avg
        const flowThreshold = thresholdMap?.[metric.flow]?.borderline ?? threshold;
        const worseThanStore = devSD > flowThreshold;
        let worseThanPersonal = false;
        if (personalAvg !== null) {
          if (metric.direction === 'HIGH') {
            worseThanPersonal = value > personalAvg;
          } else {
            worseThanPersonal = value < personalAvg;
          }
        }

        flags.set(metric.key, worseThanStore && worseThanPersonal);
      }

      const compositeScore = [...flags.values()].filter(Boolean).length;

      // Active flows label
      const activeFlowsList = [];
      if (flows.is_picking) activeFlowsList.push('Picking');
      if (flows.is_putting) activeFlowsList.push('Putting');
      if (flows.is_audit)   activeFlowsList.push('Audit');
      if (flows.is_fnv)     activeFlowsList.push('FNV');

      // Flagged metrics list
      const flaggedMetricsList = CONFIG.METRICS
        .filter(m => flags.get(m.key))
        .map(m => m.label);

      // Worst deviation
      let worstDev = null;
      for (const [, dev] of deviations) {
        if (dev !== null && (worstDev === null || dev > worstDev)) worstDev = dev;
      }

      return {
        ...enriched,
        flags,
        deviations,
        composite_slacker_score: compositeScore,
        active_flows: activeFlowsList.join(', '),
        flagged_metrics_list: flaggedMetricsList.join(', '),
        worst_deviation: worstDev,
      };
    });
  }

  // ── 6. Weekly Aggregation ────────────────────────────────────────────

  /**
   * Returns array of weekly summary objects, sorted by week start date.
   * auditData and complaintsData are from sub-sheets and used as primary
   * sources for rack and complaint totals respectively.
   */
  function aggregateWeekly(data, auditData = [], complaintsData = []) {
    // Build rack totals by week from Audits sub-sheet
    const auditByWeek = {};
    for (const row of auditData) {
      if (!row.date) continue;
      const wk = _isoWeekKey(row.date);
      auditByWeek[wk] = (auditByWeek[wk] || 0) + row.audit_codes.length;
    }

    // Build complaint totals by week from Complaints sub-sheet
    const complByWeek = {};
    for (const row of complaintsData) {
      if (!row.date) continue;
      const wk = _isoWeekKey(row.date);
      if (!complByWeek[wk]) complByWeek[wk] = { total: 0, inStoreYes: 0, inStoreNo: 0, byCategory: {} };
      complByWeek[wk].total++;
      if (row.in_store) complByWeek[wk].inStoreYes++; else complByWeek[wk].inStoreNo++;
      const cat = row.complaint_category || 'unknown';
      complByWeek[wk].byCategory[cat] = (complByWeek[wk].byCategory[cat] || 0) + 1;
    }

    const byWeek = {};
    for (const row of data) {
      if (!row.date) continue;
      const weekKey = _isoWeekKey(row.date);
      if (!byWeek[weekKey]) {
        byWeek[weekKey] = { week_key: weekKey, week_start: _weekStart(row.date), rows: [] };
      }
      byWeek[weekKey].rows.push(row);
    }

    return Object.values(byWeek)
      .sort((a, b) => a.week_start - b.week_start)
      .map(g => _summarise(g, auditByWeek[g.week_key] || 0, complByWeek[g.week_key] || null));
  }

  // ── 7. Monthly Aggregation ───────────────────────────────────────────

  function aggregateMonthly(data, auditData = [], complaintsData = []) {
    // Build rack totals by month from Audits sub-sheet
    const auditByMonth = {};
    for (const row of auditData) {
      if (!row.date) continue;
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      auditByMonth[mk] = (auditByMonth[mk] || 0) + row.audit_codes.length;
    }

    // Build complaint totals by month from Complaints sub-sheet
    const complByMonth = {};
    for (const row of complaintsData) {
      if (!row.date) continue;
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (!complByMonth[mk]) complByMonth[mk] = { total: 0, inStoreYes: 0, inStoreNo: 0, byCategory: {} };
      complByMonth[mk].total++;
      if (row.in_store) complByMonth[mk].inStoreYes++; else complByMonth[mk].inStoreNo++;
      const cat = row.complaint_category || 'unknown';
      complByMonth[mk].byCategory[cat] = (complByMonth[mk].byCategory[cat] || 0) + 1;
    }

    const byMonth = {};
    for (const row of data) {
      if (!row.date) continue;
      const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) { byMonth[key] = { month_key: key, rows: [] }; }
      byMonth[key].rows.push(row);
    }

    return Object.values(byMonth)
      .sort((a, b) => a.month_key.localeCompare(b.month_key))
      .map(g => _summarise(g, auditByMonth[g.month_key] || 0, complByMonth[g.month_key] || null));
  }

  // ── 8b. Billing-cycle Monthly Aggregation ───────────────────────────
  // Groups rows by merchant billing cycle: 26th of month N-1 → 25th of month N.
  // A date on or after the 26th belongs to the NEXT calendar month's billing cycle.

  function _billingMonthKey(date) {
    let y = date.getFullYear();
    let m = date.getMonth() + 1; // 1-12
    if (date.getDate() >= 26) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  function _billingMonthLabel(monthKey) {
    const [y, mo] = monthKey.split('-').map(Number);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startDate = new Date(y, mo - 2, 26); // JS wraps mo-2 < 0 → Dec of y-1
    const endDate   = new Date(y, mo - 1, 25);
    return `${MONTHS[startDate.getMonth()]} 26 \u2013 ${MONTHS[endDate.getMonth()]} 25, ${endDate.getFullYear()}`;
  }

  function aggregateBillingMonthly(data, auditData = [], complaintsData = []) {
    const auditByMonth = {};
    for (const row of auditData) {
      if (!row.date) continue;
      const mk = _billingMonthKey(row.date);
      auditByMonth[mk] = (auditByMonth[mk] || 0) + row.audit_codes.length;
    }

    const complByMonth = {};
    for (const row of complaintsData) {
      if (!row.date) continue;
      const mk = _billingMonthKey(row.date);
      if (!complByMonth[mk]) complByMonth[mk] = { total: 0, inStoreYes: 0, inStoreNo: 0, byCategory: {} };
      complByMonth[mk].total++;
      if (row.in_store) complByMonth[mk].inStoreYes++; else complByMonth[mk].inStoreNo++;
      const cat = row.complaint_category || 'unknown';
      complByMonth[mk].byCategory[cat] = (complByMonth[mk].byCategory[cat] || 0) + 1;
    }

    const byMonth = {};
    for (const row of data) {
      if (!row.date) continue;
      const key = _billingMonthKey(row.date);
      if (!byMonth[key]) { byMonth[key] = { month_key: key, rows: [] }; }
      byMonth[key].rows.push(row);
    }

    return Object.values(byMonth)
      .sort((a, b) => a.month_key.localeCompare(b.month_key))
      .map(g => {
        const s = _summarise(g, auditByMonth[g.month_key] || 0, complByMonth[g.month_key] || null);
        s.label = _billingMonthLabel(g.month_key);
        return s;
      });
  }

  // ── 8. Daily Aggregation ─────────────────────────────────────────────

  function aggregateDaily(data, auditData = [], complaintsData = []) {
    const auditByDate = {};
    for (const row of auditData) {
      if (!row.date) continue;
      const dk = _dk(row.date);
      auditByDate[dk] = (auditByDate[dk] || 0) + row.audit_codes.length;
    }

    const complByDate = {};
    for (const row of complaintsData) {
      if (!row.date) continue;
      const dk = _dk(row.date);
      if (!complByDate[dk]) complByDate[dk] = { total: 0, inStoreYes: 0, inStoreNo: 0, byCategory: {} };
      complByDate[dk].total++;
      if (row.in_store) complByDate[dk].inStoreYes++; else complByDate[dk].inStoreNo++;
      const cat = row.complaint_category || 'unknown';
      complByDate[dk].byCategory[cat] = (complByDate[dk].byCategory[cat] || 0) + 1;
    }

    const byDate = {};
    for (const row of data) {
      if (!row.date) continue;
      const dk = _dk(row.date);
      if (!byDate[dk]) byDate[dk] = { date_key: dk, date: row.date, rows: [] };
      byDate[dk].rows.push(row);
    }

    return Object.values(byDate)
      .sort((a, b) => a.date - b.date)
      .map(g => ({
        ..._summarise(g, auditByDate[g.date_key] || 0, complByDate[g.date_key] || null),
        date_key: g.date_key,
        label: g.date_key,
      }));
  }

  function _dk(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  // ── Summary Helper ────────────────────────────────────────────────────

  /** Format a week start date as "Aug W1 2025" */
  function _weekLabel(weekStart) {
    if (!weekStart) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const weekEnd = new Date(weekStart.getTime() + 6 * 86400000); // Sunday
    const startStr = `${months[weekStart.getMonth()]} ${weekStart.getDate()}`;
    const endStr   = `${months[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
    return `${startStr} – ${endStr} (${weekEnd.getFullYear()})`;
  }

  function _summarise(group, subRacks = 0, subCompl = null) {
    const rows = group.rows;
    const n = rows.length;
    if (n === 0) return group;

    const sum = (key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
    const avg = (key, activeFilter) => {
      const active = activeFilter ? rows.filter(activeFilter) : rows;
      if (active.length === 0) return 0;
      return active.reduce((acc, r) => acc + (r[key] || 0), 0) / active.length;
    };
    const weightedAvg = (valueKey, weightKey, activeFilter) => {
      const active = activeFilter ? rows.filter(activeFilter) : rows;
      const totalWeight = active.reduce((acc, r) => acc + (r[weightKey] || 0), 0);
      if (totalWeight === 0) return 0;
      return active.reduce((acc, r) => acc + (r[valueKey] || 0) * (r[weightKey] || 0), 0) / totalWeight;
    };

    const fnvRows = rows.filter(r => r.flows?.is_fnv);

    const compl = subCompl || { total: 0, inStoreYes: 0, inStoreNo: 0, byCategory: {} };

    return {
      ...group,
      label: group.week_start ? _weekLabel(group.week_start) : (group.month_key || group.week_key),
      total_orders_picked:    sum('checkout_orders'),
      total_picking_hours:    sum('picker_active_time') / 3600,
      total_putting_hours:    sum('putter_active_time') / 3600,
      total_audit_hours:      sum('auditor_active_time') / 3600,
      total_active_time:      sum('total_active_time') / 3600,
      total_putaway_qty:      sum('putaway_qty'),
      total_racks_audited:    subRacks,
      total_complaints:       compl.total,
      complaints_instore_yes: compl.inStoreYes,
      complaints_instore_no:  compl.inStoreNo,
      complaints_instore_rate: compl.total > 0 ? +(compl.inStoreYes / compl.total * 100).toFixed(1) : 0,
      complaints_by_category: compl.byCategory,

      avg_ppi:                           avg('ppi', r => r.flows?.is_picking),
      avg_picking_time_per_order:        avg('picking_time_per_order', r => r.flows?.is_picking),
      avg_total_time_per_order:          weightedAvg('total_time_per_order', 'checkout_orders', r => r.flows?.is_picking),
      avg_assigned_to_started:           avg('assigned_to_started_per_order', r => r.flows?.is_picking),
      avg_billing_time:                  avg('billing_time_per_order', r => r.flows?.is_picking),
      avg_iph:                           avg('iph', r => r.flows?.is_putting),
      avg_fnv_audit_rate:                fnvRows.length > 0
                                           ? fnvRows.reduce((a, r) => a + (r.fnv_audit_rate || 0), 0) / fnvRows.length
                                           : 0,
      active_captains:        new Set(rows.map(r => r.employee_id)).size,
    };
  }

  // ── Utility Functions ─────────────────────────────────────────────────

  function _isActiveInFlow(row, flow) {
    switch (flow) {
      case 'picking': return row.picker_active_time > 0;
      case 'putting': return row.putter_active_time > 0;
      case 'audit':   return row.auditor_active_time > 0;
      case 'fnv':     return row.fnv_active_time > 0;
      default:        return false;
    }
  }

  function _getMetricValue(row, metricKey) {
    if (metricKey === 'fnv_audit_rate') return row.fnv_audit_rate ?? null;
    if (metricKey === 'audit_hours_per_rack') {
      return (row.auditor_active_time > 0 && row.racks_audited > 0)
        ? (row.auditor_active_time / 3600) / row.racks_audited
        : null;
    }
    const val = row[metricKey];
    return (val !== undefined && val !== null) ? val : null;
  }

  // Normalize raw RCA strings: trim, strip trailing punctuation, title-case.
  // Collapses "picker fault", "Picker fault ;", "PICKER FAULT" → "Picker Fault".
  function _normalizeRCA(raw) {
    if (!raw) return 'Unknown';
    return raw.trim()
      .replace(/[;:,.\s]+$/, '')   // strip trailing punctuation/whitespace
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
  }

  function _mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function _stdDev(arr, mean) {
    if (arr.length < 2) return 0;
    const variance = arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  function _groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key];
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    }, {});
  }

  /** Returns ISO week key like "2024-W22" */
  function _isoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  /** Returns the Monday of the week for a date. */
  function _weekStart(date) {
    const d = new Date(date);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Blinkit merchant cycle: starts 26th of prev month, ends 25th of this month.
   * A date on the 26th or later belongs to the NEXT calendar month's cycle.
   * Returns "YYYY-MM" of the cycle's end month.
   */
  function _merchantCycleKey(date) {
    const d = date.getDate();
    const m = date.getMonth(); // 0-based
    const y = date.getFullYear();
    if (d >= 26) {
      const nm = m + 1;
      return nm > 11 ? `${y + 1}-01` : `${y}-${String(nm + 1).padStart(2, '0')}`;
    }
    return `${y}-${String(m + 1).padStart(2, '0')}`;
  }

  function _merchantCycleLabel(cycleKey) {
    const [y, mo] = cycleKey.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const cycleMonth = mo - 1; // 0-based end month
    const prevMonth  = cycleMonth === 0 ? 11 : cycleMonth - 1;
    const prevYear   = cycleMonth === 0 ? y - 1 : y;
    return `${months[prevMonth]} 26 – ${months[cycleMonth]} 25, ${y}`;
  }

  // ── Public getters for UI ─────────────────────────────────────────────

  /** Format seconds to HH:MM:SS or MM:SS */
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '—';
    const s = Math.round(seconds);
    if (s === 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    }
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  /** Get CSS class based on deviation SDs */
  function deviationClass(devSD, thresholds = null) {
    if (devSD === null || devSD === undefined) return '';
    const c = thresholds?.critical   ?? 2;
    const f = thresholds?.flagged    ?? 1;
    const b = thresholds?.borderline ?? 0.5;
    if (devSD > c)  return 'cell-dark-red';
    if (devSD > f)  return 'cell-red';
    if (devSD > b)  return 'cell-yellow';
    if (devSD <= 0) return 'cell-green';
    return '';
  }

  // ── 8. Audit Aggregations ────────────────────────────────────────────

  /**
   * Computes audit-specific aggregations from the Audits sub-sheet,
   * joined with Daily Metrics data for auditor active hours.
   *
   * @param {Array} auditData  - parsed audit rows (from sheets.fetchAuditData)
   * @param {Array} dailyData  - parsed daily metrics rows (from sheets.fetchData)
   * @returns {{ volume, captainPerf, rackIntel }}
   */
  function computeAuditAggregations(auditData, dailyData) {
    if (!auditData || auditData.length === 0) return null;

    // Build lookup: (employee_id, YYYY-MM-DD) → daily metrics row
    const dailyLookup = new Map();
    for (const row of dailyData) {
      if (!row.date) continue;
      const key = `${row.employee_id}_${_dateKey(row.date)}`;
      dailyLookup.set(key, row);
    }

    // ── Audit hours from Daily Metrics (all captains, not just Audits sheet) ──
    // Keyed by YYYY-MM-DD date string → total seconds across all auditing captains
    const dailyAuditSeconds = new Map();
    for (const row of dailyData) {
      if (!row.date || !row.auditor_active_time) continue;
      const dk = _dateKey(row.date);
      dailyAuditSeconds.set(dk, (dailyAuditSeconds.get(dk) || 0) + row.auditor_active_time);
    }

    // ── Volume aggregation (rack counts from Audits sheet) ──────────
    const dailyMap = new Map();
    for (const row of auditData) {
      let entry = dailyMap.get(row.dateStr);
      if (!entry) {
        entry = { date: row.date, totalRacks: 0, captains: new Set(), codes: new Set() };
        dailyMap.set(row.dateStr, entry);
      }
      entry.totalRacks += row.audit_codes.length;
      entry.captains.add(row.employee_id);
      for (const c of row.audit_codes) entry.codes.add(c);
    }

    // Convert sets to counts for daily, pulling audit hours from Daily Metrics
    const daily = new Map();
    for (const [ds, v] of dailyMap) {
      const auditSec = dailyAuditSeconds.get(ds) || 0;
      daily.set(ds, { date: v.date, totalRacks: v.totalRacks, totalCaptains: v.captains.size, uniqueCodes: v.codes.size, totalAuditHours: +(auditSec / 3600).toFixed(2) });
    }

    // Weekly
    const weekBuckets = {};
    for (const [ds, v] of dailyMap) {
      const wk = _isoWeekKey(v.date);
      if (!weekBuckets[wk]) weekBuckets[wk] = { weekKey: wk, weekStart: _weekStart(v.date), totalRacks: 0, captains: new Set(), codes: new Set(), days: 0 };
      const b = weekBuckets[wk];
      b.totalRacks += v.totalRacks;
      for (const c of v.captains) b.captains.add(c);
      for (const c of v.codes) b.codes.add(c);
      b.days++;
    }
    // Pull audit hours for each week from Daily Metrics (iterate dailyData directly)
    const weekAuditSeconds = {};
    for (const row of dailyData) {
      if (!row.date || !row.auditor_active_time) continue;
      const wk = _isoWeekKey(row.date);
      if (weekBuckets[wk]) weekAuditSeconds[wk] = (weekAuditSeconds[wk] || 0) + row.auditor_active_time;
    }
    const weekly = Object.values(weekBuckets)
      .sort((a, b) => a.weekStart - b.weekStart)
      .map(b => ({
        weekKey: b.weekKey, label: _weekLabel(b.weekStart),
        totalRacks: b.totalRacks, totalCaptains: b.captains.size, uniqueCodes: b.codes.size,
        totalAuditHours: +((weekAuditSeconds[b.weekKey] || 0) / 3600).toFixed(1),
        avgRacksPerDay: b.days > 0 ? +(b.totalRacks / b.days).toFixed(1) : 0,
      }));

    // Monthly
    const monthBuckets = {};
    for (const [, v] of dailyMap) {
      const mk = `${v.date.getFullYear()}-${String(v.date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthBuckets[mk]) monthBuckets[mk] = { monthKey: mk, totalRacks: 0, captains: new Set(), codes: new Set(), days: 0 };
      const b = monthBuckets[mk];
      b.totalRacks += v.totalRacks;
      for (const c of v.captains) b.captains.add(c);
      for (const c of v.codes) b.codes.add(c);
      b.days++;
    }
    // Pull audit hours for each month from Daily Metrics
    const monthAuditSeconds = {};
    for (const row of dailyData) {
      if (!row.date || !row.auditor_active_time) continue;
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (monthBuckets[mk]) monthAuditSeconds[mk] = (monthAuditSeconds[mk] || 0) + row.auditor_active_time;
    }
    const monthly = Object.values(monthBuckets)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map(b => ({
        monthKey: b.monthKey, label: b.monthKey,
        totalRacks: b.totalRacks, totalCaptains: b.captains.size, uniqueCodes: b.codes.size,
        totalAuditHours: +((monthAuditSeconds[b.monthKey] || 0) / 3600).toFixed(1),
        avgRacksPerDay: b.days > 0 ? +(b.totalRacks / b.days).toFixed(1) : 0,
      }));

    const dailyArray = [...daily.entries()]
      .sort((a, b) => a[1].date - b[1].date)
      .map(([ds, v]) => ({ ...v, label: ds }));

    const volume = { daily, dailyArray, weekly, monthly };

    // ── Captain total audit hours from Daily Metrics (all audit days) ──
    // Keyed by employee_id → total auditor_active_time seconds across ALL days
    const captainAuditSeconds = new Map();
    const captainAuditDays = new Map();
    for (const row of dailyData) {
      if (!row.auditor_active_time || row.auditor_active_time <= 0) continue;
      captainAuditSeconds.set(row.employee_id, (captainAuditSeconds.get(row.employee_id) || 0) + row.auditor_active_time);
      captainAuditDays.set(row.employee_id, (captainAuditDays.get(row.employee_id) || 0) + 1);
    }

    // ── Captain audit performance ───────────────────────────────────
    const captainMap = new Map();
    for (const row of auditData) {
      let cap = captainMap.get(row.employee_id);
      if (!cap) {
        cap = { employee_id: row.employee_id, employee_name: row.employee_name, days: [] };
        captainMap.set(row.employee_id, cap);
      }

      const racksCount = row.audit_codes.length;
      cap.days.push({
        dateStr: row.dateStr,
        date: row.date,
        audit_codes: row.audit_codes,
        racks: racksCount,
      });
    }

    // Compute totals — hours from Daily Metrics, racks from Audits sheet
    for (const [empId, cap] of captainMap) {
      const totalRacks = cap.days.reduce((s, d) => s + d.racks, 0);
      const totalSeconds = captainAuditSeconds.get(empId) || 0;
      const totalHours = totalSeconds / 3600;
      const totalAuditDays = captainAuditDays.get(empId) || cap.days.length;
      cap.totals = {
        totalRacks,
        totalHours: +totalHours.toFixed(1),
        avgRacksPerHour: totalHours > 0 ? +(totalRacks / totalHours).toFixed(2) : null,
        hrPerRack: totalRacks > 0 ? +(totalHours / totalRacks).toFixed(2) : null,
        totalDays: totalAuditDays,
        rackDays: cap.days.length,
        avgRacksPerDay: cap.days.length > 0 ? +(totalRacks / cap.days.length).toFixed(1) : 0,
      };
    }

    // ── Add captains with audit hours but 0 racks in Audits sheet ──────
    for (const [empId, auditSec] of captainAuditSeconds) {
      if (captainMap.has(empId)) continue;
      const nameRow = dailyData.find(r => r.employee_id === empId);
      const empName = nameRow?.employee_name || empId;
      const totalHours = auditSec / 3600;
      captainMap.set(empId, {
        employee_id: empId,
        employee_name: empName,
        days: [],
        totals: {
          totalRacks: 0,
          totalHours: +totalHours.toFixed(1),
          avgRacksPerHour: null,
          hrPerRack: null,
          totalDays: captainAuditDays.get(empId) || 0,
          rackDays: 0,
          avgRacksPerDay: 0,
        },
      });
    }

    const captainPerf = captainMap;

    // ── Rack intelligence ───────────────────────────────────────────
    const rackFreq = new Map();
    for (const row of auditData) {
      for (const code of row.audit_codes) {
        let entry = rackFreq.get(code);
        if (!entry) {
          entry = { count: 0, dates: new Set(), captains: new Set() };
          rackFreq.set(code, entry);
        }
        entry.count++;
        entry.dates.add(row.dateStr);
        entry.captains.add(row.employee_id);
      }
    }

    const sorted = [...rackFreq.entries()]
      .map(([code, v]) => {
        const parsed = _parseRackCode(code);
        return {
          rackCode: code, count: v.count,
          uniqueDates: v.dates.size, uniqueCaptains: v.captains.size,
          lastAudited: [...v.dates].sort().pop() || '',
          floor: parsed.floor, aisle: parsed.aisle, position: parsed.position,
        };
      })
      .sort((a, b) => b.count - a.count);

    // Floor-aisle heatmap
    const floorAisleHeatmap = new Map();
    for (const rack of sorted) {
      if (!floorAisleHeatmap.has(rack.floor)) floorAisleHeatmap.set(rack.floor, new Map());
      const aisleMap = floorAisleHeatmap.get(rack.floor);
      aisleMap.set(rack.aisle, (aisleMap.get(rack.aisle) || 0) + rack.count);
    }

    const rackIntel = { rackFrequency: rackFreq, sorted, floorAisleHeatmap };

    return { volume, captainPerf, rackIntel };
  }

  // ── 9. Complaint Aggregations ──────────────────────────────────────

  function computeComplaintAggregations(complaintsData, dailyData) {
    if (!complaintsData || complaintsData.length === 0) return null;

    // ── Store Summary ──────────────────────────────────────────────
    const dailyMap = new Map();
    for (const row of complaintsData) {
      let entry = dailyMap.get(row.dateStr);
      if (!entry) {
        entry = {
          date: row.date, totalComplaints: 0, orders: new Set(),
          inStoreYes: 0, inStoreNo: 0,
          byCategory: {}, byCategoryInStore: {}, byCategoryOutStore: {}, byRCA: {},
        };
        dailyMap.set(row.dateStr, entry);
      }
      entry.totalComplaints++;
      entry.orders.add(row.order_id);
      if (row.in_store) entry.inStoreYes++; else entry.inStoreNo++;
      const cat = row.complaint_category || 'unknown';
      entry.byCategory[cat] = (entry.byCategory[cat] || 0) + 1;
      if (row.in_store) entry.byCategoryInStore[cat] = (entry.byCategoryInStore[cat] || 0) + 1;
      else              entry.byCategoryOutStore[cat] = (entry.byCategoryOutStore[cat] || 0) + 1;
      const rca = _normalizeRCA(row.rca);
      entry.byRCA[rca] = (entry.byRCA[rca] || 0) + 1;
    }

    const daily = new Map();
    for (const [ds, v] of dailyMap) {
      daily.set(ds, {
        date: v.date, totalComplaints: v.totalComplaints,
        uniqueOrders: v.orders.size, inStoreYes: v.inStoreYes, inStoreNo: v.inStoreNo,
        byCategory: v.byCategory, byCategoryInStore: v.byCategoryInStore, byCategoryOutStore: v.byCategoryOutStore, byRCA: v.byRCA,
      });
    }

    // Total orders from Daily Metrics per day
    const dailyOrders = new Map();
    for (const row of dailyData) {
      if (!row.date || !row.checkout_orders) continue;
      const dk = _dateKey(row.date);
      dailyOrders.set(dk, (dailyOrders.get(dk) || 0) + row.checkout_orders);
    }

    // Enrich daily entries with totalOrdersPicked
    for (const [ds, v] of daily) {
      v.totalOrdersPicked = dailyOrders.get(ds) || 0;
    }

    // Pre-compute missing-complaint unique order sets per period (item_missing, split by in_store)
    const weekMissingInStore  = {};
    const weekMissingOutStore = {};
    const monthMissingInStore  = {};
    const monthMissingOutStore = {};
    for (const row of complaintsData) {
      if (!row.date || (row.complaint_category || '').toLowerCase() !== 'item_missing') continue;
      const wk = _isoWeekKey(row.date);
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      const target = row.in_store
        ? { w: weekMissingInStore,  m: monthMissingInStore  }
        : { w: weekMissingOutStore, m: monthMissingOutStore };
      (target.w[wk] = target.w[wk] || new Set()).add(row.order_id);
      (target.m[mk] = target.m[mk] || new Set()).add(row.order_id);
    }

    // Weekly bucketing
    const weekBuckets = {};
    for (const [ds, v] of dailyMap) {
      const wk = _isoWeekKey(v.date);
      if (!weekBuckets[wk]) {
        weekBuckets[wk] = {
          weekKey: wk, weekStart: _weekStart(v.date),
          totalComplaints: 0, orders: new Set(), inStoreYes: 0, inStoreNo: 0,
          byCategory: {}, byCategoryInStore: {}, byCategoryOutStore: {}, byRCA: {}, days: 0,
        };
      }
      const b = weekBuckets[wk];
      b.totalComplaints += v.totalComplaints;
      for (const o of v.orders) b.orders.add(o);
      b.inStoreYes += v.inStoreYes;
      b.inStoreNo += v.inStoreNo;
      for (const [k, c] of Object.entries(v.byCategory)) b.byCategory[k] = (b.byCategory[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryInStore || {})) b.byCategoryInStore[k] = (b.byCategoryInStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryOutStore || {})) b.byCategoryOutStore[k] = (b.byCategoryOutStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byRCA)) b.byRCA[k] = (b.byRCA[k] || 0) + c;
      b.days++;
    }
    // Sum orders from Daily Metrics for each week
    const weekOrders = {};
    for (const row of dailyData) {
      if (!row.date || !row.checkout_orders) continue;
      const wk = _isoWeekKey(row.date);
      if (weekBuckets[wk]) weekOrders[wk] = (weekOrders[wk] || 0) + row.checkout_orders;
    }
    const weekly = Object.values(weekBuckets)
      .sort((a, b) => a.weekStart - b.weekStart)
      .map(b => ({
        weekKey: b.weekKey, label: _weekLabel(b.weekStart),
        totalComplaints: b.totalComplaints, uniqueOrders: b.orders.size,
        inStoreYes: b.inStoreYes, inStoreNo: b.inStoreNo,
        byCategory: b.byCategory, byCategoryInStore: b.byCategoryInStore, byCategoryOutStore: b.byCategoryOutStore, byRCA: b.byRCA,
        totalOrdersPicked: weekOrders[b.weekKey] || 0,
        avgPerDay: b.days > 0 ? +(b.totalComplaints / b.days).toFixed(1) : 0,
        missingInStore:  weekMissingInStore[b.weekKey]?.size  || 0,
        missingOutStore: weekMissingOutStore[b.weekKey]?.size || 0,
      }));

    // Monthly bucketing
    const monthBuckets = {};
    for (const [, v] of dailyMap) {
      const mk = `${v.date.getFullYear()}-${String(v.date.getMonth() + 1).padStart(2, '0')}`;
      if (!monthBuckets[mk]) {
        monthBuckets[mk] = {
          monthKey: mk, totalComplaints: 0, orders: new Set(),
          inStoreYes: 0, inStoreNo: 0, byCategory: {}, byCategoryInStore: {}, byCategoryOutStore: {}, byRCA: {}, days: 0,
        };
      }
      const b = monthBuckets[mk];
      b.totalComplaints += v.totalComplaints;
      for (const o of v.orders) b.orders.add(o);
      b.inStoreYes += v.inStoreYes;
      b.inStoreNo += v.inStoreNo;
      for (const [k, c] of Object.entries(v.byCategory)) b.byCategory[k] = (b.byCategory[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryInStore || {})) b.byCategoryInStore[k] = (b.byCategoryInStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryOutStore || {})) b.byCategoryOutStore[k] = (b.byCategoryOutStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byRCA)) b.byRCA[k] = (b.byRCA[k] || 0) + c;
      b.days++;
    }
    const monthOrders = {};
    for (const row of dailyData) {
      if (!row.date || !row.checkout_orders) continue;
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (monthBuckets[mk]) monthOrders[mk] = (monthOrders[mk] || 0) + row.checkout_orders;
    }
    const monthly = Object.values(monthBuckets)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map(b => ({
        monthKey: b.monthKey, label: b.monthKey,
        totalComplaints: b.totalComplaints, uniqueOrders: b.orders.size,
        inStoreYes: b.inStoreYes, inStoreNo: b.inStoreNo,
        byCategory: b.byCategory, byCategoryInStore: b.byCategoryInStore, byCategoryOutStore: b.byCategoryOutStore, byRCA: b.byRCA,
        totalOrdersPicked: monthOrders[b.monthKey] || 0,
        avgPerDay: b.days > 0 ? +(b.totalComplaints / b.days).toFixed(1) : 0,
        missingInStore:  monthMissingInStore[b.monthKey]?.size  || 0,
        missingOutStore: monthMissingOutStore[b.monthKey]?.size || 0,
      }));

    // Merchant cycle bucketing (26th prev month → 25th this month)
    const cycleBuckets = {};
    for (const [, v] of dailyMap) {
      const ck = _merchantCycleKey(v.date);
      if (!cycleBuckets[ck]) {
        cycleBuckets[ck] = {
          cycleKey: ck, totalComplaints: 0, orders: new Set(),
          inStoreYes: 0, inStoreNo: 0,
          byCategory: {}, byCategoryInStore: {}, byCategoryOutStore: {}, byRCA: {}, days: 0,
        };
      }
      const cb = cycleBuckets[ck];
      cb.totalComplaints += v.totalComplaints;
      for (const o of v.orders) cb.orders.add(o);
      cb.inStoreYes += v.inStoreYes;
      cb.inStoreNo  += v.inStoreNo;
      for (const [k, c] of Object.entries(v.byCategory || {})) cb.byCategory[k] = (cb.byCategory[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryInStore || {})) cb.byCategoryInStore[k] = (cb.byCategoryInStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byCategoryOutStore || {})) cb.byCategoryOutStore[k] = (cb.byCategoryOutStore[k] || 0) + c;
      for (const [k, c] of Object.entries(v.byRCA || {})) cb.byRCA[k] = (cb.byRCA[k] || 0) + c;
      cb.days++;
    }
    const cycleOrders = {};
    for (const row of dailyData) {
      if (!row.date || !row.checkout_orders) continue;
      const ck = _merchantCycleKey(row.date);
      if (cycleBuckets[ck]) cycleOrders[ck] = (cycleOrders[ck] || 0) + row.checkout_orders;
    }
    const cycleMissingInStore  = {};
    const cycleMissingOutStore = {};
    for (const row of complaintsData) {
      if (!row.date || (row.complaint_category || '').toLowerCase() !== 'item_missing') continue;
      const ck = _merchantCycleKey(row.date);
      const target = row.in_store ? cycleMissingInStore : cycleMissingOutStore;
      (target[ck] = target[ck] || new Set()).add(row.order_id);
    }
    const merchantCycle = Object.values(cycleBuckets)
      .sort((a, b) => a.cycleKey.localeCompare(b.cycleKey))
      .map(b => ({
        cycleKey: b.cycleKey,
        label: _merchantCycleLabel(b.cycleKey),
        totalComplaints: b.totalComplaints,
        uniqueOrders: b.orders.size,
        inStoreYes: b.inStoreYes,
        inStoreNo: b.inStoreNo,
        byCategory: b.byCategory, byCategoryInStore: b.byCategoryInStore, byCategoryOutStore: b.byCategoryOutStore, byRCA: b.byRCA,
        totalOrdersPicked: cycleOrders[b.cycleKey] || 0,
        missingInStore:  cycleMissingInStore[b.cycleKey]?.size  || 0,
        missingOutStore: cycleMissingOutStore[b.cycleKey]?.size || 0,
      }));

    // Overall totals
    const totalComplaints = complaintsData.length;
    const uniqueOrders = new Set(complaintsData.map(r => r.order_id)).size;
    const inStoreYes = complaintsData.filter(r => r.in_store).length;
    const inStoreNo = totalComplaints - inStoreYes;
    const totalOrdersPicked = [...dailyOrders.values()].reduce((s, v) => s + v, 0);

    const totalsByCategory = {};
    const totalsByRCA = {};
    for (const row of complaintsData) {
      const cat = row.complaint_category || 'unknown';
      totalsByCategory[cat] = (totalsByCategory[cat] || 0) + 1;
      const rca = _normalizeRCA(row.rca);
      totalsByRCA[rca] = (totalsByRCA[rca] || 0) + 1;
    }

    const missingInStoreTotal = new Set(
      complaintsData.filter(r => r.in_store && (r.complaint_category || '').toLowerCase() === 'item_missing')
        .map(r => r.order_id)
    ).size;
    const missingOutStoreTotal = new Set(
      complaintsData.filter(r => !r.in_store && (r.complaint_category || '').toLowerCase() === 'item_missing')
        .map(r => r.order_id)
    ).size;

    const dailyArray = [...daily.entries()]
      .sort((a, b) => a[1].date - b[1].date)
      .map(([ds, v]) => ({ ...v, label: ds }));

    const storeSummary = {
      daily, dailyArray, weekly, monthly, merchantCycle,
      totals: {
        totalComplaints, uniqueOrders, inStoreYes, inStoreNo,
        inStoreRate: totalComplaints > 0 ? +(inStoreYes / totalComplaints * 100).toFixed(1) : 0,
        totalOrdersPicked,
        missingInStore: missingInStoreTotal,
        missingOutStore: missingOutStoreTotal,
        byCategory: totalsByCategory, byRCA: totalsByRCA,
      },
    };

    // ── Captain Complaint Performance ─────────────────────────────
    // Total orders per captain from Daily Metrics
    const captainOrders = new Map();
    const captainNames = new Map();
    for (const row of dailyData) {
      if (!row.checkout_orders || row.checkout_orders <= 0) continue;
      captainOrders.set(row.employee_id, (captainOrders.get(row.employee_id) || 0) + row.checkout_orders);
      if (!captainNames.has(row.employee_id)) captainNames.set(row.employee_id, row.employee_name);
    }

    const captainMap = new Map();
    for (const row of complaintsData) {
      let cap = captainMap.get(row.employee_id);
      if (!cap) {
        cap = {
          employee_id: row.employee_id,
          employee_name: row.employee_id ? (captainNames.get(row.employee_id) || row.employee_id) : 'Unknown',
          totalComplaints: 0, inStoreYes: 0, inStoreNo: 0,
          pickerFaultMissingOrders: new Set(),
          byCategory: {}, days: new Map(),
        };
        captainMap.set(row.employee_id, cap);
      }
      cap.totalComplaints++;
      if (row.in_store) cap.inStoreYes++; else cap.inStoreNo++;
      // Picker Fault Missing: unique orders where category=item_missing AND in_store=Y
      if (row.in_store && (row.complaint_category || '').toLowerCase() === 'item_missing') {
        cap.pickerFaultMissingOrders.add(row.order_id);
      }
      const cat = row.complaint_category || 'unknown';
      cap.byCategory[cat] = (cap.byCategory[cat] || 0) + 1;
      const dayEntry = cap.days.get(row.dateStr) || { complaints: 0, inStoreYes: 0 };
      dayEntry.complaints++;
      if (row.in_store) dayEntry.inStoreYes++;
      cap.days.set(row.dateStr, dayEntry);
    }

    // Finalize captain performance
    const captainPerf = new Map();
    for (const [empId, cap] of captainMap) {
      const totalOrds = captainOrders.get(empId) || 0;
      const topCat = Object.entries(cap.byCategory).sort((a, b) => b[1] - a[1])[0];
      const pfm = cap.pickerFaultMissingOrders.size;
      captainPerf.set(empId, {
        employee_id: empId,
        employee_name: cap.employee_name,
        totalComplaints: cap.totalComplaints,
        inStoreYes: cap.inStoreYes,
        inStoreNo: cap.inStoreNo,
        pickerFaultMissing: pfm,
        pickerFaultMissingRate: totalOrds > 0 ? +(pfm / totalOrds * 100).toFixed(2) : 0,
        totalOrdersPicked: totalOrds,
        complaintRate: totalOrds > 0 ? +(cap.inStoreYes / totalOrds * 100).toFixed(2) : 0,
        byCategory: cap.byCategory,
        topCategory: topCat ? topCat[0] : '—',
        days: [...cap.days.entries()].map(([ds, d]) => ({ dateStr: ds, ...d })),
      });
    }

    // ── Category Intelligence ─────────────────────────────────────
    const byL0 = new Map();
    for (const row of complaintsData) {
      const cat = row.l0_category || 'Unknown';
      let entry = byL0.get(cat);
      if (!entry) {
        entry = { count: 0, inStoreYes: 0, products: {} };
        byL0.set(cat, entry);
      }
      entry.count++;
      if (row.in_store) entry.inStoreYes++;
      const pName = row.product_name || 'Unknown';
      entry.products[pName] = (entry.products[pName] || 0) + 1;
    }

    const byComplaintType = new Map();
    for (const row of complaintsData) {
      const cat = row.complaint_category || 'unknown';
      let entry = byComplaintType.get(cat);
      if (!entry) { entry = { count: 0, inStoreYes: 0 }; byComplaintType.set(cat, entry); }
      entry.count++;
      if (row.in_store) entry.inStoreYes++;
    }

    const byRCA = new Map();
    for (const row of complaintsData) {
      const rca = _normalizeRCA(row.rca);
      let entry = byRCA.get(rca);
      if (!entry) { entry = { count: 0 }; byRCA.set(rca, entry); }
      entry.count++;
    }

    // Build sorted arrays
    const sortedL0 = [...byL0.entries()]
      .map(([cat, v]) => {
        const topProducts = Object.entries(v.products).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const topRCAs = {};
        for (const row of complaintsData.filter(r => (r.l0_category || 'Unknown') === cat)) {
          const rca = row.rca || 'Unknown';
          topRCAs[rca] = (topRCAs[rca] || 0) + 1;
        }
        const topRCA = Object.entries(topRCAs).sort((a, b) => b[1] - a[1])[0];
        return {
          category: cat, count: v.count, inStoreYes: v.inStoreYes,
          inStorePct: v.count > 0 ? +(v.inStoreYes / v.count * 100).toFixed(1) : 0,
          topProduct: topProducts[0] ? topProducts[0][0] : '—',
          topRCA: topRCA ? topRCA[0] : '—',
        };
      })
      .sort((a, b) => b.count - a.count);

    const sortedComplaintType = [...byComplaintType.entries()]
      .map(([cat, v]) => ({
        category: cat, count: v.count, inStoreYes: v.inStoreYes,
        pct: totalComplaints > 0 ? +(v.count / totalComplaints * 100).toFixed(1) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const sortedRCA = [...byRCA.entries()]
      .map(([rca, v]) => ({
        rca, count: v.count,
        pct: totalComplaints > 0 ? +(v.count / totalComplaints * 100).toFixed(1) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const categoryIntel = {
      byL0, byComplaintType, byRCA,
      sorted: { l0: sortedL0, complaintType: sortedComplaintType, rca: sortedRCA },
    };

    return { storeSummary, captainPerf, categoryIntel };
  }

  function _dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function _parseRackCode(code) {
    const parts = code.split('-');
    return {
      floor: parts[0] || '',
      aisle: parts[1] || '',
      position: parts.slice(2).join('-') || '',
    };
  }

  // ── Incentive Calculation ──────────────────────────────────────────────

  const PICKING_SLABS_400 = [
    { maxTime: 70,  amount: 500 },   // <1:10
    { maxTime: 75,  amount: 400 },   // 1:10-1:15
    { maxTime: 80,  amount: 300 },   // 1:15-1:20
    { maxTime: 90,  amount: 250 },   // 1:20-1:30
    { maxTime: 110, amount: 125 },   // 1:30-1:50
  ];
  const PICKING_SLABS_800 = [
    { maxTime: 75,  amount: 500 },   // <1:15
    { maxTime: 80,  amount: 400 },   // 1:15-1:20
    { maxTime: 85,  amount: 300 },   // 1:20-1:25
    { maxTime: 95,  amount: 250 },   // 1:25-1:35
    { maxTime: 120, amount: 125 },   // 1:35-2:00
  ];

  function _pickingSlabAmount(avgTime, slabs) {
    for (const slab of slabs) {
      if (avgTime < slab.maxTime) return slab.amount;
    }
    return 0;
  }

  /**
   * Returns distinct ISO week keys that "belong" to a given month.
   * Assignment rule: a week belongs to the month containing its Thursday
   * (same ISO-8601 principle used for year assignment). This means:
   *  - W14 2026 (Mar 30–Apr 5): Thursday = Apr 2 → April  ✓
   *  - W9  2026 (Feb 23–Mar 1): Thursday = Feb 26 → February ✓ (won't bleed into March)
   * @param {Array} data - daily metric rows
   * @param {string} monthKey - "YYYY-MM"
   * @returns {string[]} sorted week keys
   */
  function getWeekKeysForMonth(data, monthKey) {
    const keys = new Set();
    for (const row of data) {
      if (!row.date) continue;
      const ws   = _weekStart(row.date);  // Monday
      const wsYm = `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, '0')}`;
      if (wsYm === monthKey) keys.add(_isoWeekKey(row.date));
    }
    return [...keys].sort();
  }

  /** Returns the Monday of a given ISO week key (e.g. "2026-W14"). */
  function weekStartFromKey(weekKey) {
    const [yearStr, wStr] = weekKey.split('-W');
    const year = +yearStr, week = +wStr;
    const jan4    = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const mon     = new Date(jan4.getTime() + (week - 1) * 7 * 86400000 - (jan4Day - 1) * 86400000);
    mon.setHours(0, 0, 0, 0);
    return mon;
  }

  /**
   * Compute weekly picking incentives per captain.
   * @param {Array} data - daily metric rows
   * @param {string[]} weekKeys - ISO week keys to include
   * @param {{ slabs400: Array, slabs800: Array }|null} slabOverride - optional per-month slab override
   * @returns {Map<string, { employee_name, weeks: Map, total }>}
   */
  function computePickingIncentives(data, weekKeys, slabOverride = null) {
    const slabs400     = (slabOverride && slabOverride.slabs400)     ? slabOverride.slabs400     : PICKING_SLABS_400;
    const slabs800     = (slabOverride && slabOverride.slabs800)     ? slabOverride.slabs800     : PICKING_SLABS_800;
    const threshold400 = (slabOverride && slabOverride.threshold400) ? slabOverride.threshold400 : 400;
    const threshold800 = (slabOverride && slabOverride.threshold800) ? slabOverride.threshold800 : 800;
    const wkSet = new Set(weekKeys);
    // Group by employee → week (only picking-flow rows)
    const empMap = new Map();

    for (const row of data) {
      if (!row.date || !row.flows?.is_picking) continue;
      if (!row.checkout_orders || row.checkout_orders <= 0) continue;
      const wk = _isoWeekKey(row.date);
      if (!wkSet.has(wk)) continue;

      let emp = empMap.get(row.employee_id);
      if (!emp) {
        emp = { employee_name: row.employee_name, weeks: new Map() };
        empMap.set(row.employee_id, emp);
      }
      let week = emp.weeks.get(wk);
      if (!week) {
        week = { orders: 0, timeSum: 0, orderSum: 0 };
        emp.weeks.set(wk, week);
      }
      week.orders += row.checkout_orders;
      // Weighted average: total_time_per_order × checkout_orders
      if (row.total_time_per_order > 0) {
        week.timeSum += row.total_time_per_order * row.checkout_orders;
        week.orderSum += row.checkout_orders;
      }
    }

    // Compute incentive per captain-week
    const result = new Map();
    for (const [empId, emp] of empMap) {
      const weekResults = new Map();
      let total = 0;
      for (const [wk, w] of emp.weeks) {
        const avgTime = w.orderSum > 0 ? w.timeSum / w.orderSum : 0;
        let amount = 0;
        if (w.orders >= threshold800) {
          amount = _pickingSlabAmount(avgTime, slabs800);
        } else if (w.orders >= threshold400) {
          amount = _pickingSlabAmount(avgTime, slabs400);
        }
        weekResults.set(wk, { orders: w.orders, avgTime, amount });
        total += amount;
      }
      result.set(empId, { employee_name: emp.employee_name, weeks: weekResults, total });
    }
    return result;
  }

  /**
   * Compute monthly audit incentives per captain (tiered pricing).
   * Uses the Audits sheet (auditData) for accurate rack counts via audit_codes.length.
   * @param {Array} auditData - rows from the Audits sheet (each has audit_codes array)
   * @param {string} monthKey - "YYYY-MM"
   * @returns {Map<string, { employee_name, totalRacks, amount, tier1, tier2, tier3 }>}
   */
  function computeAuditIncentives(auditData, monthKey) {
    const empMap = new Map();
    for (const row of auditData) {
      if (!row.date) continue;
      const ym = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (ym !== monthKey) continue;
      const racks = row.audit_codes ? row.audit_codes.length : 0;
      if (racks <= 0) continue;

      let emp = empMap.get(row.employee_id);
      if (!emp) {
        emp = { employee_name: row.employee_name, totalRacks: 0 };
        empMap.set(row.employee_id, emp);
      }
      emp.totalRacks += racks;
    }

    const result = new Map();
    for (const [empId, emp] of empMap) {
      const r = emp.totalRacks;
      const tier1Racks = Math.min(r, 40);
      const tier2Racks = Math.min(Math.max(r - 40, 0), 40);
      const tier3Racks = Math.max(r - 80, 0);
      const tier1 = tier1Racks * 30;
      const tier2 = tier2Racks * 40;
      const tier3 = tier3Racks * 50;
      result.set(empId, {
        employee_name: emp.employee_name,
        totalRacks: r,
        amount: tier1 + tier2 + tier3,
        tier1, tier1Racks,
        tier2, tier2Racks,
        tier3, tier3Racks,
      });
    }
    return result;
  }

  return {
    computeFlowFlags,
    computeFNVRate,
    computeStoreStats,
    computePersonalAvgs,
    flagSlackers,
    aggregateWeekly,
    aggregateMonthly,
    aggregateBillingMonthly,
    aggregateDaily,
    computeAuditAggregations,
    computeComplaintAggregations,
    formatDuration,
    deviationClass,
    getWeekKeysForMonth,
    weekStartFromKey,
    computePickingIncentives,
    computeAuditIncentives,
    PICKING_SLABS_400,
    PICKING_SLABS_800,
  };
})();
