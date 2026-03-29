/**
 * config.js — Dashboard configuration
 *
 * SETUP REQUIRED:
 *  1. Set CLIENT_ID to your Google OAuth 2.0 Web Client ID
 *     (Google Cloud Console → APIs & Services → Credentials)
 *  2. SPREADSHEET_ID is pre-filled from the source document.
 */

const CONFIG = {
  // ── Google OAuth ────────────────────────────────────────────────────
  CLIENT_ID: '994594167101-j7j79oi4dgkfj4j11un6eogqi5v52ocu.apps.googleusercontent.com',

  // ── Google Sheets ────────────────────────────────────────────────────
  SPREADSHEET_ID: '1HrznjUpDFBErTI6AzMmj3ygo6f6h3jJCbZosiPkJGIc',
  SHEET_NAME: 'Daily Metrics',
  DATA_RANGE: 'Daily Metrics!A:V',

  // ── Audits Sheet ───────────────────────────────────────────────────
  AUDIT_DATA_RANGE: 'Audits!A:E',
  AUDIT_COL: {
    employee_id: 0,    // A
    employee_name: 1,  // B
    date: 2,           // C
    month: 3,          // D
    audit_codes: 4,    // E
  },

  // ── Complaints Sheet ──────────────────────────────────────────────────
  COMPLAINTS_DATA_RANGE: 'Complaints!A:O',
  COMPLAINTS_COL: {
    cycle: 0,              // A
    x: 1,                  // B
    order_date: 2,         // C
    outlet_id: 3,          // D
    outlet_name: 4,        // E
    order_id: 5,           // F
    employee_id: 6,        // G
    product_id: 7,         // H
    product_name: 8,       // I
    l0_category: 9,        // J
    l1_category: 10,       // K
    complaint_category: 11, // L
    customer_name: 12,     // M
    rca: 13,               // N
    in_store: 14,          // O
  },

  // ── Flagging ─────────────────────────────────────────────────────────
  // How many SDs worse than the store average before flagging.
  // Editable in the Config tab UI.
  THRESHOLD: 1.0,

  // ── Metric Definitions ───────────────────────────────────────────────
  // direction: 'HIGH' = high value is bad (e.g. slow time)
  //            'LOW'  = low value is bad  (e.g. low throughput)
  METRICS: [
    {
      key: 'picking_time_per_order',
      label: 'Picking Time/Order',
      flow: 'picking',
      direction: 'HIGH',
      isDuration: true,
      col: 'N',
    },
    {
      key: 'assigned_to_started_per_order',
      label: 'Delay to Start',
      flow: 'picking',
      direction: 'HIGH',
      isDuration: true,
      col: 'O',
    },
    {
      key: 'billing_time_per_order',
      label: 'Billing Time/Order',
      flow: 'picking',
      direction: 'HIGH',
      isDuration: true,
      col: 'P',
    },
    {
      key: 'total_time_per_order',
      label: 'Total Time/Order',
      flow: 'picking',
      direction: 'HIGH',
      isDuration: true,
      col: 'Q',
    },
    {
      key: 'iph',
      label: 'Items Put Away/Hr',
      flow: 'putting',
      direction: 'LOW',
      isDuration: false,
      col: 'S',
    },
  ],

  // ── Column Index Map (0-based, after removing header row) ────────────
  // Maps column letter to array index for raw Sheets API rows.
  COL: {
    date: 0,           // A
    employee_id: 1,    // B
    employee_name: 2,  // C
    checkout_orders: 3, // D
    total_quantity_picked: 4, // E
    putaway_qty: 5,    // F
    audited_qty: 6,    // G
    racks_audited: 7,  // H
    total_active_time: 8,  // I
    picker_active_time: 9, // J
    putter_active_time: 10, // K
    auditor_active_time: 11, // L
    fnv_active_time: 12,    // M
    picking_time_per_order: 13, // N
    assigned_to_started_per_order: 14, // O
    billing_time_per_order: 15, // P
    total_time_per_order: 16,   // Q
    ppi: 17,                    // R
    iph: 18,                    // S
    missing_complaints: 19,     // T
    wrong_complaints: 20,       // U
    other_complaints: 21,       // V
  },
};
