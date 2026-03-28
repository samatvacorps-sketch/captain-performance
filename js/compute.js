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
  function flagSlackers(data, storeStats, personalAvgs, threshold = 1.0) {
    return data.map(row => {
      const flows = computeFlowFlags(row);
      const fnvRate = computeFNVRate(row);
      const enriched = { ...row, flows, fnv_audit_rate: fnvRate };

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
        const worseThanStore = devSD > threshold;
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
   */
  function aggregateWeekly(data) {
    const byWeek = {};

    for (const row of data) {
      if (!row.date) continue;
      const weekKey = _isoWeekKey(row.date);
      if (!byWeek[weekKey]) {
        byWeek[weekKey] = {
          week_key: weekKey,
          week_start: _weekStart(row.date),
          rows: [],
        };
      }
      byWeek[weekKey].rows.push(row);
    }

    return Object.values(byWeek)
      .sort((a, b) => a.week_start - b.week_start)
      .map(_summarise);
  }

  // ── 7. Monthly Aggregation ───────────────────────────────────────────

  function aggregateMonthly(data) {
    const byMonth = {};

    for (const row of data) {
      if (!row.date) continue;
      const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth[key]) {
        byMonth[key] = { month_key: key, rows: [] };
      }
      byMonth[key].rows.push(row);
    }

    return Object.values(byMonth)
      .sort((a, b) => a.month_key.localeCompare(b.month_key))
      .map(_summarise);
  }

  // ── Summary Helper ────────────────────────────────────────────────────

  /** Format a week start date as "Aug W1 2025" */
  function _weekLabel(weekStart) {
    if (!weekStart) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[weekStart.getMonth()];
    const weekOfMonth = Math.ceil(weekStart.getDate() / 7);
    const year = weekStart.getFullYear();
    return `${month} W${weekOfMonth} ${year}`;
  }

  function _summarise(group) {
    const rows = group.rows;
    const n = rows.length;
    if (n === 0) return group;

    const sum = (key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
    const avg = (key, activeFilter) => {
      const active = activeFilter ? rows.filter(activeFilter) : rows;
      if (active.length === 0) return 0;
      return active.reduce((acc, r) => acc + (r[key] || 0), 0) / active.length;
    };

    const pickingRows = rows.filter(r => r.flows?.is_picking);
    const puttingRows = rows.filter(r => r.flows?.is_putting);
    const fnvRows     = rows.filter(r => r.flows?.is_fnv);

    return {
      ...group,
      label: group.week_start ? _weekLabel(group.week_start) : (group.month_key || group.week_key),
      total_orders_picked:    sum('checkout_orders'),
      total_picking_hours:    sum('picker_active_time') / 3600,
      total_putting_hours:    sum('putter_active_time') / 3600,
      total_audit_hours:      sum('auditor_active_time') / 3600,
      total_putaway_qty:      sum('putaway_qty'),
      total_racks_audited:    sum('racks_audited'),
      total_complaints:       sum('missing_complaints') + sum('wrong_complaints') + sum('other_complaints'),
      missing_complaints:     sum('missing_complaints'),
      wrong_complaints:       sum('wrong_complaints'),
      other_complaints:       sum('other_complaints'),

      avg_ppi:                           avg('ppi', r => r.flows?.is_picking),
      avg_picking_time_per_order:        avg('picking_time_per_order', r => r.flows?.is_picking),
      avg_total_time_per_order:          avg('total_time_per_order', r => r.flows?.is_picking),
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
    const val = row[metricKey];
    return (val !== undefined && val !== null) ? val : null;
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
  function deviationClass(devSD) {
    if (devSD === null || devSD === undefined) return '';
    if (devSD > 2)   return 'cell-dark-red';
    if (devSD > 1)   return 'cell-red';
    if (devSD > 0.5) return 'cell-yellow';
    if (devSD <= 0)  return 'cell-green';
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

    // ── Volume aggregation ──────────────────────────────────────────
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

    // Convert sets to counts for daily
    const daily = new Map();
    for (const [ds, v] of dailyMap) {
      daily.set(ds, { date: v.date, totalRacks: v.totalRacks, totalCaptains: v.captains.size, uniqueCodes: v.codes.size });
    }

    // Weekly
    const weekBuckets = {};
    for (const [, v] of dailyMap) {
      const wk = _isoWeekKey(v.date);
      if (!weekBuckets[wk]) weekBuckets[wk] = { weekKey: wk, weekStart: _weekStart(v.date), totalRacks: 0, captains: new Set(), codes: new Set(), days: 0 };
      const b = weekBuckets[wk];
      b.totalRacks += v.totalRacks;
      for (const c of v.captains) b.captains.add(c);
      for (const c of v.codes) b.codes.add(c);
      b.days++;
    }
    const weekly = Object.values(weekBuckets)
      .sort((a, b) => a.weekStart - b.weekStart)
      .map(b => ({
        weekKey: b.weekKey, label: _weekLabel(b.weekStart),
        totalRacks: b.totalRacks, totalCaptains: b.captains.size, uniqueCodes: b.codes.size,
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
    const monthly = Object.values(monthBuckets)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map(b => ({
        monthKey: b.monthKey, label: b.monthKey,
        totalRacks: b.totalRacks, totalCaptains: b.captains.size, uniqueCodes: b.codes.size,
        avgRacksPerDay: b.days > 0 ? +(b.totalRacks / b.days).toFixed(1) : 0,
      }));

    const volume = { daily, weekly, monthly };

    // ── Captain audit performance ───────────────────────────────────
    const captainMap = new Map();
    for (const row of auditData) {
      let cap = captainMap.get(row.employee_id);
      if (!cap) {
        cap = { employee_id: row.employee_id, employee_name: row.employee_name, days: [] };
        captainMap.set(row.employee_id, cap);
      }

      const lookupKey = `${row.employee_id}_${row.dateStr}`;
      const dailyRow = dailyLookup.get(lookupKey);
      const auditSeconds = dailyRow ? dailyRow.auditor_active_time : 0;
      const auditHours = auditSeconds / 3600;
      const racksCount = row.audit_codes.length;

      cap.days.push({
        dateStr: row.dateStr,
        date: row.date,
        audit_codes: row.audit_codes,
        racks: racksCount,
        auditor_active_hours: +auditHours.toFixed(2),
        racks_per_hour: auditHours > 0 ? +(racksCount / auditHours).toFixed(1) : null,
      });
    }

    // Compute totals
    for (const [, cap] of captainMap) {
      const totalRacks = cap.days.reduce((s, d) => s + d.racks, 0);
      const totalHours = cap.days.reduce((s, d) => s + d.auditor_active_hours, 0);
      cap.totals = {
        totalRacks,
        totalHours: +totalHours.toFixed(2),
        avgRacksPerHour: totalHours > 0 ? +(totalRacks / totalHours).toFixed(1) : null,
        totalDays: cap.days.length,
        avgRacksPerDay: +(totalRacks / cap.days.length).toFixed(1),
      };
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

  return {
    computeFlowFlags,
    computeFNVRate,
    computeStoreStats,
    computePersonalAvgs,
    flagSlackers,
    aggregateWeekly,
    aggregateMonthly,
    computeAuditAggregations,
    formatDuration,
    deviationClass,
  };
})();
