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
  let _rosterCache = null;
  let _instoreCache = null;
  let _pnaCache = null;

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
    const date    = _parseDate(dateRaw);
    if (!date) return null;
    const _dy = date.getFullYear(), _dm = String(date.getMonth()+1).padStart(2,'0'), _dd = String(date.getDate()).padStart(2,'0');
    const dateIsoStr = `${_dy}-${_dm}-${_dd}`; // YYYY-MM-DD, matches audit/roster dateStr format

    return {
      date,
      dateStr,
      dateIsoStr,
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
    // Use Number() (not parseFloat) so date strings like "2026-05-28" are
    // rejected as serials — parseFloat would greedily read "2026" and treat it
    // as a serial number, landing the date in ~1905. Only treat a value as a
    // Sheets serial when the WHOLE value is numeric.
    const n = Number(val);
    if (!isNaN(n) && n > 1000) {
      // Google Sheets serial number → JS Date
      return new Date(Math.round((n - 25569) * 86400 * 1000));
    }
    // Fallback: parse as a date/datetime string (e.g. "2026-05-28 19:30:58").
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

  // ── Roster Data ────────────────────────────────────────────────────────

  async function fetchRosterData(force = false) {
    if (_rosterCache && !force) return _rosterCache;
    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');
    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(CONFIG.ROSTER_DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.warn('Roster sheet fetch failed:', response.status);
      _rosterCache = [];
      return _rosterCache;
    }
    const json = await response.json();
    const rows = json.values || [];
    if (rows.length < 2) { _rosterCache = []; return _rosterCache; }
    _rosterCache = rows.slice(1).map(_parseRosterRow).filter(Boolean);
    return _rosterCache;
  }

  function _parseRosterRow(raw) {
    if (!raw || raw.length === 0) return null;
    const c = CONFIG.ROSTER_COL;
    const empId = _str(raw[c.employee_id]);
    if (!empId) return null;
    return {
      employee_id:   empId,
      employee_name: _str(raw[c.employee_name]),
      shift:         _str(raw[c.shift]),
      start:         _str(raw[c.start]),
      end:           _str(raw[c.end]),
      assigned_off:  _str(raw[c.assigned_off]),
      employment_type: _str(raw[c.employment_type]),
      // Correctly-named aliases for the live Roster layout (A:H):
      // D = Shift Start Date (effective date), E = Start time,
      // F = End time, G = Assigned Off. (Existing fields above are kept
      // as-is so tier/attendance code is undisturbed.)
      eff_date:    _str(raw[3]),
      shift_start: _str(raw[4]),
      shift_end:   _str(raw[5]),
      off_day:     _str(raw[6]),
    };
  }

  function getRosterCached() { return _rosterCache || []; }

  // ── In-Store Orders With Time Data ──────────────────────────────────────
  // Order-level rows for the In-store time SLA. Columns are resolved by header
  // name so the sheet may be safely reordered without touching code.

  async function fetchInstoreData(force = false) {
    if (_instoreCache && !force) return _instoreCache;
    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');
    const instoreBook = CONFIG.INSTORE_SPREADSHEET_ID || CONFIG.SPREADSHEET_ID;
    const url = `${BASE_URL}/${instoreBook}/values/${encodeURIComponent(CONFIG.INSTORE_DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.warn('In-store sheet fetch failed:', response.status);
      _instoreCache = [];
      return _instoreCache;
    }
    const json = await response.json();
    const rows = json.values || [];
    if (rows.length < 2) { _instoreCache = []; return _instoreCache; }

    // Resolve logical field → column index from the header row.
    const header = rows[0].map(h => _str(h).toLowerCase());
    const idx = {};
    for (const [field, headerName] of Object.entries(CONFIG.INSTORE_HEADERS)) {
      idx[field] = header.indexOf(headerName.toLowerCase());
    }
    _instoreCache = rows.slice(1).map(r => _parseInstoreRow(r, idx)).filter(Boolean);
    return _instoreCache;
  }

  function _parseInstoreRow(raw, idx) {
    if (!raw || raw.length === 0) return null;
    const at = (field) => (idx[field] >= 0 ? raw[idx[field]] : undefined);

    const date = _parseDate(at('date_ts'));
    if (!date) return null;
    const _y = date.getFullYear(), _m = String(date.getMonth()+1).padStart(2,'0'), _d = String(date.getDate()).padStart(2,'0');
    const dateIsoStr = `${_y}-${_m}-${_d}`;

    // Stage timestamps (serial datetimes → Date). Time portion is in IST,
    // interpreted in the browser's local zone (IST), so getHours() is correct.
    const readyTs   = _parseDate(at('ready_to_assign_ts'));
    const assignTs  = _parseDate(at('picker_assigned_ts'));
    const startTs   = _parseDate(at('picking_started_ts'));
    const completeTs = _parseDate(at('picking_completed_ts'));
    const billTs    = _parseDate(at('billing_completed_ts'));

    const _diffSec = (a, b) => (a && b ? Math.max(0, Math.round((b - a) / 1000)) : null);
    const hourSrc = startTs || readyTs || date;
    const dropRaw = _str(at('is_dropzone_available')).toUpperCase();

    return {
      order_id:        _str(at('order_id')),
      employee_id:     _str(at('picker_id')),   // picker_id == employee_id elsewhere
      outlet_name:     _str(at('outlet_name')),
      ipo:             _num(at('ipo')),
      instore_seconds: _num(at('instore_seconds')), // plain seconds, not a day-fraction
      date,
      dateStr:         String(at('date_ts')),
      dateIsoStr,
      hour:            hourSrc ? hourSrc.getHours() : null,
      wait_sec:    _diffSec(readyTs, assignTs),       // assign_ready → picker assigned
      assign_sec:  _diffSec(assignTs, startTs),       // assigned → picking started
      pick_sec:    _diffSec(startTs, completeTs),      // picking started → completed
      billing_sec: _diffSec(completeTs, billTs),       // completed → billing done
      is_dropzone_available: dropRaw === 'Y' || dropRaw === 'YES' || dropRaw === 'TRUE',
    };
  }

  function getInstoreCached() { return _instoreCache || []; }
  function clearInstoreCache() { _instoreCache = null; }

  // ── PNA Data (Product-Not-Available) ────────────────────────────────────
  // Order-level rows for the Fill Rate SLA. Columns resolved by header name so
  // the "PNAs" tab may be reordered without touching code.

  async function fetchPnaData(force = false) {
    if (_pnaCache && !force) return _pnaCache;
    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');
    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent(CONFIG.PNA_DATA_RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.warn('PNAs sheet fetch failed:', response.status);
      _pnaCache = [];
      return _pnaCache;
    }
    const json = await response.json();
    const rows = json.values || [];
    if (rows.length < 2) { _pnaCache = []; return _pnaCache; }

    // Resolve logical field → column index from the header row.
    const header = rows[0].map(h => _str(h).toLowerCase());
    const idx = {};
    for (const [field, headerName] of Object.entries(CONFIG.PNA_HEADERS)) {
      idx[field] = header.indexOf(headerName.toLowerCase());
    }
    _pnaCache = rows.slice(1).map(r => _parsePnaRow(r, idx)).filter(Boolean);
    return _pnaCache;
  }

  function _parsePnaRow(raw, idx) {
    if (!raw || raw.length === 0) return null;
    const at = (field) => (idx[field] >= 0 ? raw[idx[field]] : undefined);

    const order_id = _str(at('order_id'));
    if (!order_id) return null;

    const date = _parseDate(at('date'));
    let dateIsoStr = '';
    if (date) {
      const y = date.getFullYear(), m = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
      dateIsoStr = `${y}-${m}-${d}`;
    }

    return {
      order_id,
      employee_id: _str(at('picker_id')),
      pna_qty:     _num(at('pna_qty')),
      date,
      dateIsoStr,
    };
  }

  function getPnaCached() { return _pnaCache || []; }
  function clearPnaCache() { _pnaCache = null; }

  return { fetchData, getCached, clearCache, lastFetched, fetchAuditData, getAuditCached, clearAuditCache, fetchComplaintsData, getComplaintsCached, clearComplaintsCache, fetchRosterData, getRosterCached, fetchInstoreData, getInstoreCached, clearInstoreCache, fetchPnaData, getPnaCached, clearPnaCache };
})();
