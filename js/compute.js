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
  function aggregateWeekly(data, auditData = [], complaintsData = [], instoreData = []) {
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

    const readyByWeek = {};
    for (const row of instoreData) {
      if (!row.date) continue;
      const wk = _isoWeekKey(row.date);
      _addReadyBucket(readyByWeek, wk, row);
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
      .map(g => _summarise(g, auditByWeek[g.week_key] || 0, complByWeek[g.week_key] || null, _readyBucketAvg(readyByWeek[g.week_key])));
  }

  // ── 7. Monthly Aggregation ───────────────────────────────────────────

  function aggregateMonthly(data, auditData = [], complaintsData = [], instoreData = []) {
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

    const readyByMonth = {};
    for (const row of instoreData) {
      if (!row.date) continue;
      const mk = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      _addReadyBucket(readyByMonth, mk, row);
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
      .map(g => _summarise(g, auditByMonth[g.month_key] || 0, complByMonth[g.month_key] || null, _readyBucketAvg(readyByMonth[g.month_key])));
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

  function aggregateBillingMonthly(data, auditData = [], complaintsData = [], instoreData = []) {
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

    const readyByMonth = {};
    for (const row of instoreData) {
      if (!row.date) continue;
      const mk = _billingMonthKey(row.date);
      _addReadyBucket(readyByMonth, mk, row);
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
        const s = _summarise(g, auditByMonth[g.month_key] || 0, complByMonth[g.month_key] || null, _readyBucketAvg(readyByMonth[g.month_key]));
        s.label = _billingMonthLabel(g.month_key);
        return s;
      });
  }

  // ── 8. Daily Aggregation ─────────────────────────────────────────────

  function aggregateDaily(data, auditData = [], complaintsData = [], instoreData = []) {
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

    const readyByDate = {};
    for (const row of instoreData) {
      if (!row.date) continue;
      _addReadyBucket(readyByDate, _dk(row.date), row);
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
        ..._summarise(g, auditByDate[g.date_key] || 0, complByDate[g.date_key] || null, _readyBucketAvg(readyByDate[g.date_key])),
        date_key: g.date_key,
        label: g.date_key,
      }));
  }

  function _dk(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  function _addReadyBucket(buckets, key, row) {
    const v = row.wait_sec;
    if (v === null || v === undefined || isNaN(v)) return;
    if (!buckets[key]) buckets[key] = { sum: 0, n: 0 };
    buckets[key].sum += v;
    buckets[key].n++;
  }

  function _readyBucketAvg(bucket) {
    return bucket && bucket.n > 0 ? bucket.sum / bucket.n : 0;
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

  function _summarise(group, subRacks = 0, subCompl = null, subReadyToAssign = 0) {
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
    const avgReadyToAssign = subReadyToAssign;
    const avgPickingTime = weightedAvg('picking_time_per_order', 'checkout_orders', r => r.flows?.is_picking);
    const avgAssignedToStarted = weightedAvg('assigned_to_started_per_order', 'checkout_orders', r => r.flows?.is_picking);
    const avgBillingTime = weightedAvg('billing_time_per_order', 'checkout_orders', r => r.flows?.is_picking);

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
      avg_ready_to_assign:               avgReadyToAssign,
      avg_picking_time_per_order:        avgPickingTime,
      avg_total_time_per_order:          avgReadyToAssign + avgAssignedToStarted + avgPickingTime + avgBillingTime,
      avg_assigned_to_started:           avgAssignedToStarted,
      avg_billing_time:                  avgBillingTime,
      avg_iph:                           avg('iph', r => r.flows?.is_putting),
      avg_fnv_audit_rate:                fnvRows.length > 0
                                           ? fnvRows.reduce((a, r) => a + (r.fnv_audit_rate || 0), 0) / fnvRows.length
                                           : 0,
      active_captains:        new Set(rows.map(r => r.employee_id)).size,
    };
  }

  // ── Robust Captain Scoring (Phase 2) ─────────────────────────────────
  // Replaces per-day mean/SD z-scores with window-level, volume-gated,
  // median/MAD-based scores. Captains below a flow's volume gate are not
  // scored in that flow (a picker with 3 orders can't be "Critical").
  // Composite = Σ max(0, robust z) over gated flows — severity-weighted,
  // unlike the old count-of-flags.

  const SCORING_GATES = { minOrders: 20, minPutQty: 50, minAuditRacks: 5, minFnvQty: 50, minCohort: 4 };

  function _median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function _madScale(arr, med) {
    // 1.4826 × MAD ≈ SD for normal data; robust to outliers.
    const dev = arr.map(v => Math.abs(v - med));
    const mad = _median(dev);
    return mad ? mad * 1.4826 : 0;
  }

  /**
   * Scores one window of daily rows. Returns:
   *   { captains: Map<empId, { employee_name, flows, composite, reasons }>,
   *     flowStats: { picking|putting|audit|fnv: { median, scale, n } } }
   *
   * flows[flow] = { value, volume, gated, z, pctWorse } — z is direction-
   * adjusted (positive = worse) and capped at ±4.
   *
   * captainAuditRacks (optional Map empId→racks from the Audits sheet) is
   * preferred over summing Daily Metrics col H, matching the Deep Dive /
   * Inventory Health convention.
   */
  function _scoreWindow(rows, captainAuditRacks, g) {
    const acc = new Map();
    for (const r of rows || []) {
      let a = acc.get(r.employee_id);
      if (!a) {
        a = { employee_name: r.employee_name, orders: 0, timeSum: 0, timeOrders: 0,
              putQty: 0, putSec: 0, auditSec: 0, rackSum: 0, fnvQty: 0, fnvSec: 0 };
        acc.set(r.employee_id, a);
      }
      if (r.picker_active_time > 0 && r.checkout_orders > 0) {
        a.orders += r.checkout_orders;
        if (r.total_time_per_order > 0) {
          a.timeSum += r.total_time_per_order * r.checkout_orders;
          a.timeOrders += r.checkout_orders;
        }
      }
      if (r.putter_active_time > 0) { a.putQty += r.putaway_qty || 0; a.putSec += r.putter_active_time; }
      if (r.auditor_active_time > 0) { a.auditSec += r.auditor_active_time; a.rackSum += r.racks_audited || 0; }
      if (r.fnv_active_time > 0) { a.fnvQty += r.audited_qty || 0; a.fnvSec += r.fnv_active_time; }
    }

    // Per-captain flow values + volume gates
    const captains = new Map();
    for (const [id, a] of acc) {
      const racks = captainAuditRacks?.get(id) ?? a.rackSum;
      const flows = {
        picking: {
          value: a.timeOrders > 0 ? a.timeSum / a.timeOrders : null,     // sec/order, HIGH bad
          volume: a.orders, gated: a.orders >= g.minOrders && a.timeOrders > 0,
        },
        putting: {
          value: a.putSec > 0 ? a.putQty / (a.putSec / 3600) : null,     // items/hr, LOW bad
          volume: a.putQty, gated: a.putQty >= g.minPutQty && a.putSec > 0,
        },
        audit: {
          value: (racks > 0 && a.auditSec > 0) ? (a.auditSec / 3600) / racks : null, // hr/rack, HIGH bad
          volume: racks, gated: racks >= g.minAuditRacks && a.auditSec > 0,
        },
        fnv: {
          value: a.fnvSec > 0 ? a.fnvQty / (a.fnvSec / 3600) : null,     // qty/hr, LOW bad
          volume: a.fnvQty, gated: a.fnvQty >= g.minFnvQty && a.fnvSec > 0,
        },
      };
      captains.set(id, { employee_id: id, employee_name: a.employee_name, flows, composite: 0, reasons: [] });
    }

    // Store-level robust stats per flow over gated captains
    const FLOW_DIR = { picking: 'HIGH', putting: 'LOW', audit: 'HIGH', fnv: 'LOW' };
    const flowStats = {};
    for (const flow of Object.keys(FLOW_DIR)) {
      const vals = [...captains.values()]
        .map(c => c.flows[flow])
        .filter(f => f.gated && f.value !== null && !isNaN(f.value))
        .map(f => f.value);
      const med = vals.length >= g.minCohort ? _median(vals) : null;
      flowStats[flow] = { median: med, scale: med !== null ? _madScale(vals, med) : 0, n: vals.length };
    }

    // Robust z + percentile + reasons
    for (const c of captains.values()) {
      for (const [flow, dir] of Object.entries(FLOW_DIR)) {
        const f = c.flows[flow];
        const st = flowStats[flow];
        f.z = null; f.pctWorse = null;
        if (!f.gated || f.value === null || st.median === null) continue;
        if (st.scale > 0) {
          const raw = dir === 'HIGH' ? (f.value - st.median) / st.scale : (st.median - f.value) / st.scale;
          f.z = Math.max(-4, Math.min(4, +raw.toFixed(2)));
        } else {
          f.z = 0;
        }
        // Share of the gated cohort performing better than this captain
        const peers = [...captains.values()].map(o => o.flows[flow]).filter(o => o.gated && o.value !== null);
        if (peers.length > 1) {
          const better = peers.filter(o => dir === 'HIGH' ? o.value < f.value : o.value > f.value).length;
          f.pctWorse = Math.round(better / (peers.length - 1) * 100);
        }
        if (f.z > 0) c.composite += f.z;
      }
      c.composite = +c.composite.toFixed(2);

      // Plain-language reasons for flows at z ≥ 1
      const R = [];
      const fk = c.flows;
      const st = flowStats;
      if (fk.picking.z >= 1) R.push(`Picking ${formatDuration(fk.picking.value)}/order vs store median ${formatDuration(st.picking.median)} — slower than ${fk.picking.pctWorse}% of pickers (${fk.picking.volume.toLocaleString()} orders)`);
      if (fk.putting.z >= 1) R.push(`Putaway ${Math.round(fk.putting.value)}/hr vs median ${Math.round(st.putting.median)} — below ${fk.putting.pctWorse}% of putters (${fk.putting.volume.toLocaleString()} items)`);
      if (fk.audit.z >= 1)   R.push(`Audit ${Math.round(fk.audit.value * 60)} min/rack vs median ${Math.round(st.audit.median * 60)} — slower than ${fk.audit.pctWorse}% of auditors (${fk.audit.volume} racks)`);
      if (fk.fnv.z >= 1)     R.push(`FNV audit ${Math.round(fk.fnv.value)}/hr vs median ${Math.round(st.fnv.median)} (${fk.fnv.volume.toLocaleString()} qty)`);
      c.reasons = R;
    }

    return { captains, flowStats };
  }

  /**
   * Robust, volume-gated captain scores for a window, with an optional
   * trend vs the preceding window (same gates). See _scoreWindow.
   */
  function computeCaptainScores(rows, prevRows = null, captainAuditRacks = null, gates = {}) {
    const g = { ...SCORING_GATES, ...(gates || {}) };
    const cur = _scoreWindow(rows, captainAuditRacks, g);
    const prev = (prevRows && prevRows.length) ? _scoreWindow(prevRows, null, g) : null;
    for (const c of cur.captains.values()) {
      const p = prev ? prev.captains.get(c.employee_id) : null;
      c.prevComposite = p ? p.composite : null;
      c.trend = p == null ? 'na'
        : c.composite - p.composite > 0.5 ? 'worse'
        : p.composite - c.composite > 0.5 ? 'better'
        : 'flat';
    }
    return cur;
  }

  // ── Cycle Pace Projection ────────────────────────────────────────────

  /**
   * Projects a rate metric to the end of an open window, assuming the
   * remaining days carry the window's average daily volume and perform at
   * `recentPct` (typically last-7-day form). Works for both directions —
   * pass the numerator that matches the pct definition (met orders,
   * complaint items, in-full orders...).
   *
   * Returns { projected, future, recentPct } or null when not projectable.
   * Shared by the Key Metrics pace card and the Store Overview SLA band —
   * keep both flowing through here so their numbers agree.
   */
  function projectCyclePace(numerator, denom, recentPct, elapsedDays, daysLeft) {
    if (!denom || denom <= 0 || elapsedDays < 1 || daysLeft < 1) return null;
    const future = (denom / elapsedDays) * daysLeft;
    const rp = (recentPct !== null && recentPct !== undefined)
      ? recentPct
      : +(numerator / denom * 100).toFixed(2);
    const projected = +(((numerator + rp / 100 * future) / (denom + future)) * 100).toFixed(2);
    return { projected, future, recentPct: +(+rp).toFixed(2) };
  }

  // ── Pooled Window KPIs ───────────────────────────────────────────────

  /**
   * Pooled KPIs over raw daily rows for a date window — weighted by volume
   * rather than averaged across period buckets, so a 200-order week doesn't
   * count the same as a 6,000-order week. Single source for headline cards.
   *
   * avgTotalTimePerOrder uses the weighted average of col Q by checkout
   * orders over picking-active rows — the same definition as
   * computePickingIncentives and the Deep Dive summary.
   * pooledIph = total putaway qty ÷ total putter hours (true store rate).
   */
  function computeWindowKpis(rows) {
    let orders = 0, timeSum = 0, timeOrders = 0;
    let putawayQty = 0, putterSec = 0, pickerSec = 0;
    for (const r of rows || []) {
      orders += r.checkout_orders || 0;
      if (r.picker_active_time > 0 && r.total_time_per_order > 0 && r.checkout_orders > 0) {
        timeSum    += r.total_time_per_order * r.checkout_orders;
        timeOrders += r.checkout_orders;
      }
      if (r.putter_active_time > 0) {
        putawayQty += r.putaway_qty || 0;
        putterSec  += r.putter_active_time;
      }
      pickerSec += r.picker_active_time || 0;
    }
    return {
      totalOrders:          orders,
      avgTotalTimePerOrder: timeOrders > 0 ? timeSum / timeOrders : 0, // seconds
      pooledIph:            putterSec > 0 ? putawayQty / (putterSec / 3600) : 0,
      totalPickingHours:    pickerSec / 3600,
      totalPutawayQty:      putawayQty,
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
  // Purely numeric values (e.g. order IDs accidentally in rca column) → "Unknown".
  function _normalizeRCA(raw) {
    if (!raw) return 'Unknown';
    const trimmed = raw.trim().replace(/[;:,.\s]+$/, '');
    if (!trimmed || /^\d+$/.test(trimmed)) return 'Unknown';
    return trimmed.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
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
  const AUDIT_INCENTIVE_RACK_CAP = 100;

  function _pickingSlabAmount(avgTime, slabs) {
    for (const slab of slabs) {
      if (avgTime < slab.maxTime) return slab.amount;
    }
    return 0;
  }

  /**
   * Returns distinct ISO week keys that "belong" to a given month.
   * Assignment rule: a week belongs to the month its MONDAY falls in
   * (see CLAUDE.md — weeks straddling month boundaries go to the month
   * of their Monday). E.g. W14 2026 (Mon Mar 30 – Sun Apr 5) → March.
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
   * @returns {Map<string, { employee_name, totalRacks, payableRacks, rackCap, amount, tier1, tier2, tier3 }>}
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
      const payableRacks = Math.min(r, AUDIT_INCENTIVE_RACK_CAP);
      const tier1Racks = Math.min(payableRacks, 40);
      const tier2Racks = Math.min(Math.max(payableRacks - 40, 0), 40);
      const tier3Racks = Math.max(payableRacks - 80, 0);
      const tier1 = tier1Racks * 30;
      const tier2 = tier2Racks * 40;
      const tier3 = tier3Racks * 50;
      result.set(empId, {
        employee_name: emp.employee_name,
        totalRacks: r,
        payableRacks,
        rackCap: AUDIT_INCENTIVE_RACK_CAP,
        amount: tier1 + tier2 + tier3,
        tier1, tier1Racks,
        tier2, tier2Racks,
        tier3, tier3Racks,
      });
    }
    return result;
  }

  // ── Attendance Bonus Calculation ─────────────────────────────────────

  const ATTENDANCE_BONUS_BASE = { FT: 1000, PT: 500 };
  const ATTENDANCE_BONUS_MIN_ACTIVE_DAYS = 7;

  /**
   * Compute prorated monthly attendance bonus per captain.
   * Roster rows are effective-dated. A captain who changes FT/PT status mid-month
   * should have separate roster rows with different start/end dates.
   *
   * @param {Array} data - daily metric rows with total_active_time
   * @param {Array} rosterRows - roster rows with start/end and employment_type
   * @param {string} monthKey - "YYYY-MM"
   * @param {Object} overrides - optional attendance status overrides keyed employeeId_YYYY-MM-DD
   * @returns {Map<string, {month, employee_id, employee_name, active_days, ft_days, pt_days, missing_type_days, allowed_offs, actual_offs, eligible, bonus_amount, reason}>}
   */
  function computeAttendanceBonus(data, rosterRows, monthKey, overrides = {}) {
    const [year, month] = String(monthKey || '').split('-').map(Number);
    if (!year || !month) return new Map();

    const dates = _attendanceMonthDates(year, month);
    const daysInMonth = dates.length;
    const hoursByKey = _attendanceHoursByKey(data);
    const rosterByCaptain = _attendanceRosterByCaptain(rosterRows);
    const results = new Map();

    for (const [empId, rows] of rosterByCaptain) {
      let employeeName = rows.find(r => r.employee_name)?.employee_name || empId;
      let activeDays = 0;
      let ftDays = 0;
      let ptDays = 0;
      let missingTypeDays = 0;
      let actualOffs = 0;
      let rawAmount = 0;
      let hasUnplannedLeave = false;
      let hasShortAttendance = false;

      for (const date of dates) {
        const roster = _attendanceRosterEntryOnDate(rows, date);
        if (!roster) continue;

        activeDays++;
        if (roster.employee_name) employeeName = roster.employee_name;

        const iso = _dk(date);
        const key = _attendanceOverrideKey(empId, iso);
        const auto = _attendanceStatusFromHours(hoursByKey.get(key) || 0);
        const status = overrides[key] || auto.status;
        const employmentType = _normalizeEmploymentType(roster.employment_type);

        if (employmentType === 'FT') {
          ftDays++;
          rawAmount += ATTENDANCE_BONUS_BASE.FT / daysInMonth;
        } else if (employmentType === 'PT') {
          ptDays++;
          rawAmount += ATTENDANCE_BONUS_BASE.PT / daysInMonth;
        } else {
          missingTypeDays++;
        }

        if (status === 'Off') actualOffs++;
        if (status === 'Unplanned Leave') hasUnplannedLeave = true;

        if (employmentType && status !== 'Off' && status !== 'Unplanned Leave') {
          const credit = _attendanceWorkDayValue(status);
          const requiredCredit = employmentType === 'FT' ? 1 : 0.5;
          if (credit < requiredCredit) hasShortAttendance = true;
        }
      }

      if (activeDays === 0) continue;

      const allowedOffs = Math.round(4 * activeDays / daysInMonth);
      let eligible = false;
      let reason = 'Eligible';

      if (missingTypeDays > 0) reason = 'Needs roster type';
      else if (activeDays < ATTENDANCE_BONUS_MIN_ACTIVE_DAYS) reason = 'Minimum tenure not met';
      else if (hasUnplannedLeave) reason = 'Unplanned leave';
      else if (actualOffs > allowedOffs) reason = 'Too many offs';
      else if (hasShortAttendance) reason = 'Short attendance';
      else eligible = true;

      results.set(empId, {
        month: monthKey,
        employee_id: empId,
        employee_name: employeeName,
        active_days: activeDays,
        ft_days: ftDays,
        pt_days: ptDays,
        missing_type_days: missingTypeDays,
        allowed_offs: allowedOffs,
        actual_offs: actualOffs,
        eligible,
        bonus_amount: eligible ? Math.round(rawAmount) : 0,
        reason,
      });
    }

    return results;
  }

  function _attendanceMonthDates(year, month) {
    const last = new Date(year, month, 0).getDate();
    return Array.from({ length: last }, (_, i) => new Date(year, month - 1, i + 1));
  }

  function _attendanceRosterByCaptain(rosterRows) {
    const out = new Map();
    for (const row of rosterRows || []) {
      const id = _cleanEmployeeId(row.employee_id);
      if (!id) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(row);
    }
    return out;
  }

  function _attendanceHoursByKey(data) {
    const out = new Map();
    for (const row of data || []) {
      const id = _cleanEmployeeId(row.employee_id);
      const iso = row.dateIsoStr || (row.date ? _dk(row.date) : '');
      const hrs = (row.total_active_time || 0) / 3600;
      if (!id || !iso || isNaN(hrs) || hrs <= 0) continue;
      const key = _attendanceOverrideKey(id, iso);
      out.set(key, (out.get(key) || 0) + hrs);
    }
    return out;
  }

  function _attendanceRosterEntryOnDate(rows, date) {
    const target = _dateOnly(date).getTime();
    let best = null;
    let bestStart = -Infinity;

    for (const row of rows || []) {
      const start = _rosterDate(row.start);
      if (!start) continue;
      const startMs = _dateOnly(start).getTime();
      if (startMs > target) continue;
      const end = _rosterDate(row.end);
      if (end && _dateOnly(end).getTime() < target) continue;
      if (startMs >= bestStart) {
        best = row;
        bestStart = startMs;
      }
    }

    return best;
  }

  function _attendanceStatusFromHours(rawHours) {
    if (!rawHours) return { status: 'Off', rawHours: 0 };
    const adjusted = rawHours >= 5 ? rawHours + 1 : rawHours + 0.5;
    const rounded = Math.round(adjusted);
    if (rounded >= 9 && rounded <= 11) return { status: 'Full-day', rawHours };
    if (rounded >= 4 && rounded <= 6) return { status: 'Half-day', rawHours };
    return { status: `${rounded} hrs`, rawHours };
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

  function _attendanceOverrideKey(empId, isoDate) {
    return `${_cleanEmployeeId(empId)}_${isoDate}`;
  }

  function _cleanEmployeeId(value) {
    return String(value || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '').toUpperCase();
  }

  function _normalizeEmploymentType(value) {
    const s = String(value || '').trim().toUpperCase().replace(/[\s_-]+/g, '');
    if (s === 'FT' || s === 'FULLTIME') return 'FT';
    if (s === 'PT' || s === 'PARTTIME') return 'PT';
    return '';
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

  // ── In-Store Time SLA ──────────────────────────────────────────────
  // SLA% over orders with ipo <= cap: share completed within the time
  // threshold. Returns trend buckets (all data) plus drill-downs scoped to
  // the selected merchant cycle (or all data when no cycle is given).

  function _percentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    const i = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
    return sortedAsc[i];
  }

  function computeInstoreSLA(instoreData, selectedCycleKey) {
    if (!instoreData || instoreData.length === 0) return null;
    const CAP = CONFIG.INSTORE_SLA.IPO_CAP;
    const THRESH = CONFIG.INSTORE_SLA.TIME_THRESHOLD_SEC;
    const inScope = r => r.ipo > 0 && r.ipo <= CAP;          // denominator population
    const isMet   = r => r.instore_seconds > 0 && r.instore_seconds <= THRESH;
    const pct = (met, denom) => (denom ? +(met / denom * 100).toFixed(1) : 0);

    // ── Trend buckets (over all passed data) ──────────────────────────
    const bucketTrend = (keyFn, labelFn, sortFn) => {
      const m = new Map();
      for (const r of instoreData) {
        if (!inScope(r)) continue;
        const k = keyFn(r);
        let e = m.get(k);
        if (!e) { e = { key: k, denom: 0, met: 0 }; m.set(k, e); }
        e.denom++; if (isMet(r)) e.met++;
      }
      return [...m.values()]
        .map(e => ({ ...e, label: labelFn(e.key), slaPct: pct(e.met, e.denom) }))
        .sort(sortFn);
    };
    const byKey = (a, b) => a.key.localeCompare(b.key);
    const cycles = bucketTrend(r => _merchantCycleKey(r.date), _merchantCycleLabel, byKey);
    const weekly = bucketTrend(r => _isoWeekKey(r.date), k => _weekLabel(weekStartFromKey(k)), byKey);
    const daily  = bucketTrend(r => _dateKey(r.date), k => k, byKey);

    // ── Drill-downs (scoped to selected cycle, else all) ──────────────
    const drillSource = selectedCycleKey
      ? instoreData.filter(r => _merchantCycleKey(r.date) === selectedCycleKey)
      : instoreData;
    const drillRows = drillSource.filter(inScope);

    let denom = 0, met = 0;
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, denom: 0, met: 0, pct: 0, totalOrders: 0, activePickers: 0 }));

    // Hour load — over ALL orders in the slot (not just IPO≤6):
    //  • totalOrders  = every order picked in that hour
    //  • activePickers = unique pickers with >1 order in that hour
    const hourPickerCounts = Array.from({ length: 24 }, () => new Map());
    for (const r of drillSource) {
      if (r.hour === null || r.hour < 0 || r.hour >= 24) continue;
      byHour[r.hour].totalOrders++;            // all orders (any IPO)
      if (!inScope(r)) continue;               // picker count is over the SLA population (IPO≤6)
      const hp = hourPickerCounts[r.hour];
      hp.set(r.employee_id, (hp.get(r.employee_id) || 0) + 1);
    }
    for (let h = 0; h < 24; h++) {
      let active = 0;
      for (const c of hourPickerCounts[h].values()) if (c > 1) active++;
      byHour[h].activePickers = active;
    }
    const pickerMap = new Map();
    const ipoBands = [
      { label: '1–2 IPO', min: 1, max: 2, denom: 0, met: 0 },
      { label: '3–4 IPO', min: 3, max: 4, denom: 0, met: 0 },
      { label: '5–6 IPO', min: 5, max: 6, denom: 0, met: 0 },
    ];
    const stageAcc = { wait: { sum: 0, n: 0 }, assign: { sum: 0, n: 0 }, pick: { sum: 0, n: 0 }, billing: { sum: 0, n: 0 } };

    for (const r of drillRows) {
      denom++;
      const m = isMet(r);
      if (m) met++;

      if (r.hour !== null && r.hour >= 0 && r.hour < 24) {
        byHour[r.hour].denom++; if (m) byHour[r.hour].met++;
      }

      let p = pickerMap.get(r.employee_id);
      if (!p) { p = { employee_id: r.employee_id, denom: 0, met: 0, times: [] }; pickerMap.set(r.employee_id, p); }
      p.denom++; if (m) p.met++;
      if (r.instore_seconds > 0) p.times.push(r.instore_seconds);

      for (const b of ipoBands) { if (r.ipo >= b.min && r.ipo <= b.max) { b.denom++; if (m) b.met++; } }

      // Stage bottleneck — measured on breached orders only.
      if (!m) {
        if (r.wait_sec   != null) { stageAcc.wait.sum   += r.wait_sec;   stageAcc.wait.n++; }
        if (r.assign_sec != null) { stageAcc.assign.sum += r.assign_sec; stageAcc.assign.n++; }
        if (r.pick_sec   != null) { stageAcc.pick.sum   += r.pick_sec;   stageAcc.pick.n++; }
        if (r.billing_sec!= null) { stageAcc.billing.sum+= r.billing_sec;stageAcc.billing.n++; }
      }
    }

    for (const h of byHour) h.pct = pct(h.met, h.denom);

    const byPicker = [...pickerMap.values()].map(p => {
      const sorted = p.times.slice().sort((a, b) => a - b);
      return {
        employee_id: p.employee_id,
        orders: p.denom, met: p.met, breached: p.denom - p.met,
        pct: pct(p.met, p.denom),
        median: _percentile(sorted, 0.5),
        p90: _percentile(sorted, 0.9),
      };
    }).sort((a, b) => a.pct - b.pct); // worst (lowest %) first

    const byIpoBand = ipoBands.map(b => ({ label: b.label, denom: b.denom, met: b.met, pct: pct(b.met, b.denom) }));

    const byStage = [
      { label: 'Assign wait',  key: 'wait',    avgSec: stageAcc.wait.n    ? Math.round(stageAcc.wait.sum / stageAcc.wait.n)       : 0 },
      { label: 'To pick start', key: 'assign', avgSec: stageAcc.assign.n  ? Math.round(stageAcc.assign.sum / stageAcc.assign.n)   : 0 },
      { label: 'Picking',      key: 'pick',    avgSec: stageAcc.pick.n    ? Math.round(stageAcc.pick.sum / stageAcc.pick.n)       : 0 },
      { label: 'Billing',      key: 'billing', avgSec: stageAcc.billing.n ? Math.round(stageAcc.billing.sum / stageAcc.billing.n) : 0 },
    ];

    return {
      cycles, weekly, daily,
      byHour, byPicker, byStage, byIpoBand,
      totals: { denom, met, breached: denom - met, slaPct: pct(met, denom) },
    };
  }

  // ── Fill Rate SLA ──────────────────────────────────────────────────
  // Order-level: an order is "not in full" if it had >=1 PNA OR >=1
  // item_missing complaint. Affected orders are the UNION of those two sets
  // (an order with both, or with several PNAs/missing items, counts once).
  // Fill Rate % = (checkoutOrders - affected) / checkoutOrders.
  //
  //  pnaRows     — PNA rows already filtered to the window (need .order_id)
  //  missingRows — item_missing complaint rows for the window (need .order_id)
  //  checkoutOrders — total picked orders in the window (the denominator)
  function computeFillRate(pnaRows, missingRows, checkoutOrders) {
    const pnaOrders = new Set();
    for (const r of (pnaRows || [])) if (r && r.order_id) pnaOrders.add(r.order_id);
    const missOrders = new Set();
    for (const r of (missingRows || [])) if (r && r.order_id) missOrders.add(r.order_id);

    const affected = new Set(pnaOrders);
    let both = 0;
    for (const o of missOrders) {
      if (affected.has(o)) both++;
      affected.add(o);
    }

    const orders = checkoutOrders || 0;
    const inFull = Math.max(0, orders - affected.size);
    return {
      checkoutOrders: orders,
      affected:   affected.size,
      pnaOrders:  pnaOrders.size,
      missOrders: missOrders.size,
      bothOrders: both,
      inFull,
      pct: orders > 0 ? +(inFull / orders * 100).toFixed(2) : null,
    };
  }

  return {
    computeFillRate,
    computeFlowFlags,
    computeFNVRate,
    computeWindowKpis,
    projectCyclePace,
    computeCaptainScores,
    computeStoreStats,
    computePersonalAvgs,
    flagSlackers,
    aggregateWeekly,
    aggregateMonthly,
    aggregateBillingMonthly,
    aggregateDaily,
    computeAuditAggregations,
    computeComplaintAggregations,
    computeInstoreSLA,
    formatDuration,
    deviationClass,
    getWeekKeysForMonth,
    weekStartFromKey,
    computePickingIncentives,
    computeAuditIncentives,
    computeAttendanceBonus,
    PICKING_SLABS_400,
    PICKING_SLABS_800,
  };
})();
