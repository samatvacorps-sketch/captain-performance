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

  // ── IndexedDB session cache ─────────────────────────────────────────
  // Parsed rows are persisted per dataset so the dashboard renders
  // instantly on the next open (structured clone keeps Date objects),
  // then refreshes from the network in the background. Best-effort:
  // every failure path resolves to null and the app falls back to a
  // normal blocking fetch.
  const IDB_NAME = 'dsa-cache';
  const IDB_STORE = 'datasets';
  let _idb = null;

  function _idbOpen() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => { _idb = req.result; resolve(_idb); };
      req.onerror = () => resolve(null);
    });
  }

  async function _idbPut(key, rows) {
    const db = await _idbOpen();
    if (!db) return;
    try {
      db.transaction(IDB_STORE, 'readwrite')
        .objectStore(IDB_STORE)
        .put({ ts: Date.now(), rows }, key);
    } catch (e) { /* quota / clone errors are non-fatal */ }
  }

  async function _idbGet(key) {
    const db = await _idbOpen();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  /**
   * Populates the in-memory caches from IndexedDB (previous session's
   * fetch). Returns { ts } of the daily dataset on a hit, null otherwise.
   */
  async function loadFromCache() {
    const [daily, audits, complaints, instore, pna, roster, config, racks] = await Promise.all([
      _idbGet('daily'), _idbGet('audits'), _idbGet('complaints'),
      _idbGet('instore'), _idbGet('pna'), _idbGet('roster'), _idbGet('sheetconfig'),
      _idbGet('racks'),
    ]);
    if (!daily || !Array.isArray(daily.rows) || daily.rows.length === 0) return null;
    _cache           = daily.rows;
    _auditCache      = audits?.rows || [];
    _complaintsCache = complaints?.rows || [];
    _instoreCache    = instore?.rows || [];
    _pnaCache        = pna?.rows || [];
    _rosterCache     = roster?.rows || [];
    _lastFetched     = new Date(daily.ts);
    if (config?.rows && typeof cfg !== 'undefined') {
      _configCache = config.rows;
      cfg.setSheetConfig(_configCache);
    }
    if (racks?.rows) _rackListCache = racks.rows;
    return { ts: daily.ts };
  }

  // ── Sheet-backed business config (Config tab: key | value | notes) ────
  // Missing tab is fine — the dashboard falls back to localStorage/defaults.
  let _configCache = null;

  function _parseConfigValue(raw) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
    const s = String(raw).trim();
    if (s === '') return undefined;
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (s[0] === '{' || s[0] === '[') {
      try { return JSON.parse(s); } catch (e) { return s; }
    }
    return s;
  }

  async function fetchConfigData(force = false) {
    if (_configCache && !force) return _configCache;
    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');
    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent('Config!A:C')}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.warn('Config sheet fetch failed (tab may not exist yet):', response.status);
      _configCache = {};
      if (typeof cfg !== 'undefined') cfg.setSheetConfig(_configCache);
      return _configCache;
    }
    const json = await response.json();
    const rows = json.values || [];
    const flat = {};
    for (const row of rows) {
      const key = _str(row?.[0]);
      if (!key || key.startsWith('#') || key.toLowerCase() === 'key') continue;
      const val = _parseConfigValue(row?.[1]);
      if (val !== undefined) flat[key] = val;
    }
    _configCache = flat;
    if (typeof cfg !== 'undefined') cfg.setSheetConfig(_configCache);
    _idbPut('sheetconfig', _configCache);
    return _configCache;
  }

  function getConfigCached() { return _configCache || {}; }

  // ── Master Rack List (Racks tab) ────────────────────────────────────────
  // Optional master list of every rack code in the store (column A; header
  // row and `#`-prefixed rows ignored). Powers Inventory Health coverage %
  // and the stale-rack queue. Missing tab degrades gracefully.
  let _rackListCache = null;

  // Fetched-vs-parsed row counts per dataset (Data Health panel).
  const _parseStats = {};

  async function fetchRackListData(force = false) {
    if (_rackListCache && !force) return _rackListCache;
    const token = await auth.getToken();
    if (!token) throw new Error('Not authenticated');
    const url = `${BASE_URL}/${CONFIG.SPREADSHEET_ID}/values/${encodeURIComponent('Racks!A:A')}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.warn('Racks sheet fetch failed (tab may not exist yet):', response.status);
      _rackListCache = [];
      return _rackListCache;
    }
    const json = await response.json();
    const rows = json.values || [];
    const codes = [];
    for (const row of rows) {
      const c = _str(row?.[0]).toUpperCase();
      if (!c || c === 'RACK_CODE' || c === 'RACK' || c === 'CODE' || c.startsWith('#')) continue;
      codes.push(c);
    }
    _rackListCache = [...new Set(codes)];
    _idbPut('racks', _rackListCache);
    return _rackListCache;
  }

  function getRackListCached() { return _rackListCache || []; }

  function getParseStats() { return _parseStats; }

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
    _parseStats.daily = { fetched: dataRows.length, parsed: _cache.length };
    _lastFetched = new Date();
    _idbPut('daily', _cache);

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
    _parseStats.audits = { fetched: rows.length - 1, parsed: _auditCache.length };
    _idbPut('audits', _auditCache);
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
    _parseStats.complaints = { fetched: rows.length - 1, parsed: _complaintsCache.length };
    _idbPut('complaints', _complaintsCache);
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

  // In-store stage timestamps can arrive two ways depending on how the row was
  // written to the In-store sheet:
  //   • text  "2026-06-20 06:08:12.000"  → new Date() parses in local (IST) zone
  //   • serial 46200.2556 (real datetime) → bare serial→Date lands the wall-clock
  //     in UTC, so getHours() in an IST browser is shifted +5:30.
  // The serial's wall-clock IS the intended IST time, so shift by the local tz
  // offset to make serials and strings agree (getHours() = true IST hour).
  function _parseInstoreTs(val) {
    if (val === undefined || val === null || val === '') return null;
    const n = Number(val);
    if (!isNaN(n) && n > 1000) {
      const ms = Math.round((n - 25569) * 86400 * 1000);
      return new Date(ms + new Date(ms).getTimezoneOffset() * 60000);
    }
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
    _parseStats.roster = { fetched: rows.length - 1, parsed: _rosterCache.length };
    _idbPut('roster', _rosterCache);
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
    _parseStats.instore = { fetched: rows.length - 1, parsed: _instoreCache.length };
    _idbPut('instore', _instoreCache);
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
    const readyTs   = _parseInstoreTs(at('ready_to_assign_ts'));
    const assignTs  = _parseInstoreTs(at('picker_assigned_ts'));
    const startTs   = _parseInstoreTs(at('picking_started_ts'));
    const completeTs = _parseInstoreTs(at('picking_completed_ts'));
    const billTs    = _parseInstoreTs(at('billing_completed_ts'));

    const _diffSec = (a, b) => (a && b ? Math.max(0, Math.round((b - a) / 1000)) : null);
    const hourSrc = startTs || readyTs || date;
    const dropRaw = _str(at('is_dropzone_available')).toUpperCase();
    // First captain action on the order — powers shift adherence (rostered
    // start vs first activity). Prefer picking-started (captain action) over
    // system-side assignment.
    const actTs = startTs || assignTs || readyTs;

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
      act_ms:          actTs ? actTs.getTime() : null,
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
    _parseStats.pna = { fetched: rows.length - 1, parsed: _pnaCache.length };
    _idbPut('pna', _pnaCache);
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

  return { fetchData, getCached, clearCache, lastFetched, loadFromCache, fetchAuditData, getAuditCached, clearAuditCache, fetchComplaintsData, getComplaintsCached, clearComplaintsCache, fetchRosterData, getRosterCached, fetchInstoreData, getInstoreCached, clearInstoreCache, fetchPnaData, getPnaCached, clearPnaCache, fetchConfigData, getConfigCached, fetchRackListData, getRackListCached, getParseStats };
})();
