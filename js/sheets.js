/**
 * sheets.js — Google Sheets API v4 data fetcher
 *
 * Fetches all rows from Sheet1 (columns A–V), parses them,
 * and caches the result in memory for the session.
 */

const sheets = (() => {
  const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
  let _cache = null;
  let _lastFetched = null;
  let _auditCache = null;
  let _complaintsCache = null;

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Fetch and return parsed rows. Uses in-memory cache unless force=true.
   * @returns {Promise<Array>} Array of parsed row objects.
   */
  async function fetchData(force = false) {
    if (_cache && !force) return _cache;

    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');

    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(CONFIG.DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Sheets API error ${response.status}: ${err.error?.message || response.statusText}`);
    }

    const json = await response.json();
    const rows = json.values || [];

    if (rows.length < 2) {
      _cache = [];
      return _cache;
    }

    // First row is headers — skip it, parse the rest
    const dataRows = rows.slice(1);
    _cache = dataRows.map(_parseRow).filter(Boolean);
    _lastFetched = new Date();

    return _cache;
  }

  /** Returns the cached data without fetching. */
  function getCached() { return _cache || []; }

  /** Clears the cache so next fetchData() call re-fetches. */
  function clearCache() { _cache = null; }

  /** Returns when data was last fetched. */
  function lastFetched() { return _lastFetched; }

  // ── Audit Data ─────────────────────────────────────────────────────

  async function fetchAuditData(force = false) {
    if (_auditCache && !force) return _auditCache;

    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');

    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(CONFIG.AUDIT_DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      // Audit sheet may not exist — fail gracefully
      console.warn('Audits sheet fetch failed:', response.status);
      _auditCache = [];
      return _auditCache;
    }

    const json = await response.json();
    const rows = json.values || [];

    if (rows.length < 2) {
      _auditCache = [];
      return _auditCache;
    }

    _auditCache = rows.slice(1).map(_parseAuditRow).filter(Boolean);
    return _auditCache;
  }

  function _parseAuditRow(raw) {
    if (!raw || raw.length === 0) return null;

    const c = CONFIG.AUDIT_COL;
    const dateRaw = raw[c.date];
    if (dateRaw === undefined || dateRaw === null || dateRaw === '') return null;

    const date = _parseDate(dateRaw);
    if (!date) return null;

    // Build dateStr as YYYY-MM-DD for join key consistency
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const codesRaw = raw[c.audit_codes];
    const audit_codes = codesRaw
      ? String(codesRaw).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    return {
      employee_id:   _str(raw[c.employee_id]),
      employee_name: _str(raw[c.employee_name]),
      date,
      dateStr,
      month:         _str(raw[c.month]),
      audit_codes,
    };
  }

  function getAuditCached() { return _auditCache || []; }
  function clearAuditCache() { _auditCache = null; }

  // ── Complaints Data ───────────────────────────────────────────────────

  async function fetchComplaintsData(force = false) {
    if (_complaintsCache && !force) return _complaintsCache;

    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');

    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(CONFIG.COMPLAINTS_DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.warn('Complaints sheet fetch failed:', response.status);
      _complaintsCache = [];
      return _complaintsCache;
    }

    const json = await response.json();
    const rows = json.values || [];

    if (rows.length < 2) {
      _complaintsCache = [];
      return _complaintsCache;
    }

    _complaintsCache = rows.slice(1).map(_parseComplaintRow).filter(Boolean);
    return _complaintsCache;
  }

  function _parseComplaintRow(raw) {
    if (!raw || raw.length === 0) return null;

    const c = CONFIG.COMPLAINTS_COL;
    const dateRaw = raw[c.order_date];
    if (dateRaw === undefined || dateRaw === null || dateRaw === '') return null;

    const date = _parseDate(dateRaw);
    if (!date) return null;

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const inStoreRaw = _str(raw[c.in_store]).toUpperCase();

    return {
      cycle:              _str(raw[c.cycle]),
      x:                  _str(raw[c.x]),
      date,
      dateStr,
      outlet_id:          _str(raw[c.outlet_id]),
      outlet_name:        _str(raw[c.outlet_name]),
      order_id:           _str(raw[c.order_id]),
      employee_id:        _str(raw[c.employee_id]),
      product_id:         _str(raw[c.product_id]),
      product_name:       _str(raw[c.product_name]),
      l0_category:        _str(raw[c.l0_category]),
      l1_category:        _str(raw[c.l1_category]),
      complaint_category: _str(raw[c.complaint_category]),
      customer_name:      _str(raw[c.customer_name]),
      rca:                _str(raw[c.rca]),
      in_store:           inStoreRaw === 'Y' || inStoreRaw === 'YES',
    };
  }

  function getComplaintsCached() { return _complaintsCache || []; }
  function clearComplaintsCache() { _complaintsCache = null; }

  // ── Row Parsing ─────────────────────────────────────────────────────

  function _parseRow(raw) {
    if (!raw || raw.length === 0) return null;

    const c = CONFIG.COL;

    const dateRaw = raw[c.date];
    if (dateRaw === undefined || dateRaw === null || dateRaw === '') return null;
    const dateStr = String(dateRaw); // always string so Map keys match

    return {
      date:           _parseDate(dateRaw),
      dateStr:        dateStr,
      employee_id:    _str(raw[c.employee_id]),
      employee_name:  _str(raw[c.employee_name]),

      // Numeric fields
      checkout_orders:       _num(raw[c.checkout_orders]),
      total_quantity_picked: _num(raw[c.total_quantity_picked]),
      putaway_qty:           _num(raw[c.putaway_qty]),
      audited_qty:           _num(raw[c.audited_qty]),
      racks_audited:         _num(raw[c.racks_audited]),
      iph:                   _num(raw[c.iph]),
      missing_complaints:    _num(raw[c.missing_complaints]),
      wrong_complaints:      _num(raw[c.wrong_complaints]),
      other_complaints:      _num(raw[c.other_complaints]),

      // Duration fields → seconds
      total_active_time:              _dur(raw[c.total_active_time]),
      picker_active_time:             _dur(raw[c.picker_active_time]),
      putter_active_time:             _dur(raw[c.putter_active_time]),
      auditor_active_time:            _dur(raw[c.auditor_active_time]),
      fnv_active_time:                _dur(raw[c.fnv_active_time]),
      picking_time_per_order:         _dur(raw[c.picking_time_per_order]),
      assigned_to_started_per_order:  _dur(raw[c.assigned_to_started_per_order]),
      billing_time_per_order:         _dur(raw[c.billing_time_per_order]),
      total_time_per_order:           _dur(raw[c.total_time_per_order]),
      ppi:                            _dur(raw[c.ppi]),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Parse date value → Date object.
   * With UNFORMATTED_VALUE, Google Sheets returns dates as serial numbers
   * (days since Dec 30, 1899). 25569 = days from Dec 30, 1899 to Jan 1, 1970.
   */
  function _parseDate(val) {
    if (val === undefined || val === null || val === '') return null;
    const n = parseFloat(val);
    if (!isNaN(n) && n > 1000) {
      // Google Sheets serial number → JS Date
      return new Date(Math.round((n - 25569) * 86400 * 1000));
    }
    // Fallback: try parsing as string
    const d = new Date(val);
    return isNaN(d) ? null : d;
  }

  /** Parse numeric field, returning 0 for blank/invalid. */
  function _num(val) {
    if (val === undefined || val === null || val === '') return 0;
    const n = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /**
   * Parse duration value → seconds.
   * With UNFORMATTED_VALUE, durations come as decimal fractions of a day
   * (e.g. 0.09583 = 2h 18m = 8280 seconds).
   * Also handles HH:MM:SS strings as fallback.
   */
  function _dur(val) {
    if (val === undefined || val === null || val === '') return 0;
    const n = parseFloat(val);
    // Numeric fraction of a day (from UNFORMATTED_VALUE)
    if (!isNaN(n) && n > 0 && n < 10) {
      return Math.round(n * 86400);
    }
    // String format HH:MM:SS or MM:SS
    const str = String(val).trim();
    if (!str || str === '0') return 0;
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function _str(val) {
    return val !== undefined && val !== null ? String(val).trim() : '';
  }

  return { fetchData, getCached, clearCache, lastFetched, fetchAuditData, getAuditCached, clearAuditCache, fetchComplaintsData, getComplaintsCached, clearComplaintsCache };
})();
