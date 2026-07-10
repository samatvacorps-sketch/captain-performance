/**
 * config-setup.gs — creates the `Config` tab the dashboard reads its
 * business config from (see js/config-store.js).
 *
 * Run setupConfigTab() once from the Apps Script editor of the MAIN
 * dashboard spreadsheet. It creates a `Config` tab (key | value | notes)
 * pre-filled with the current code defaults, all commented out with a
 * leading `#`. Remove the `#` from a row (and edit the value) to make it
 * live — the dashboard ignores rows whose key starts with `#`.
 *
 * Key styles the dashboard understands:
 *   • dotted scalar leaf:  slaTargets.2026-07.instore.baseline | 86
 *   • JSON blob:           complaintSlaCategories | ["item_missing", ...]
 * Use one style per subtree; an exact key wins over dotted leaves below it.
 */

function setupConfigTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Config')) {
    throw new Error('A "Config" tab already exists — delete or rename it first.');
  }

  const sheet = ss.insertSheet('Config');
  const cycle = _currentCycleKey_();

  const rows = [
    ['key', 'value', 'notes'],

    ['# ── SLA targets (per billing cycle, key = cycle end month) ─────', '', ''],
    ['# slaTargets.' + cycle + '.instore.baseline',  75,    'In-store time SLA %: orders ≤150s with IPO ≤6'],
    ['# slaTargets.' + cycle + '.instore.sla1',      80,    ''],
    ['# slaTargets.' + cycle + '.instore.sla2',      86,    ''],
    ['# slaTargets.' + cycle + '.complaints.baseline', 1.33, 'Complaint % (qualifying items ÷ picked orders) — lower is better'],
    ['# slaTargets.' + cycle + '.complaints.sla1',     1.1,  ''],
    ['# slaTargets.' + cycle + '.complaints.sla2',     0.9,  ''],
    ['# slaTargets.' + cycle + '.fillrate.baseline', 99.32, 'Fill rate %: orders with no PNA and no item_missing complaint'],
    ['# slaTargets.' + cycle + '.fillrate.sla1',     99.56, ''],
    ['# slaTargets.' + cycle + '.fillrate.sla2',     99.66, ''],

    ['# ── Complaints SLA qualifying categories (JSON array) ──────────', '', ''],
    ['# complaintSlaCategories', '["item_missing","wrong_item"]', 'Default rule when unset: all categories except MDND / Poor Quality / QNG'],

    ['# ── Incentive slab overrides (per calendar month) ──────────────', '', ''],
    ['# incentiveSlabs.' + _currentMonthKey_(), '{"threshold400":400,"threshold800":800,"slabs400":[{"maxTime":70,"amount":500},{"maxTime":75,"amount":400},{"maxTime":80,"amount":300},{"maxTime":90,"amount":250},{"maxTime":110,"amount":125}],"slabs800":[{"maxTime":75,"amount":500},{"maxTime":80,"amount":400},{"maxTime":85,"amount":300},{"maxTime":95,"amount":250},{"maxTime":120,"amount":125}]}', 'Weekly picking slabs — shown here with the code defaults'],

    ['# ── Supervisor exclusion (JSON array, replaces hardcoded list) ──', '', ''],
    ['# supervisorIds', '["DLES282705","DLES280049","DLES280053"]', 'IDs excluded from all calculations when the toggle is on'],
  ];

  sheet.getRange(1, 1, rows.length, 3).setValues(rows);

  // Formatting: header row bold, key column monospace, freeze header.
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#1a1f2e').setFontColor('#ffffff');
  sheet.getRange(2, 1, rows.length - 1, 1).setFontFamily('Roboto Mono');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 340);
  sheet.setColumnWidth(2, 420);
  sheet.setColumnWidth(3, 420);

  // Values must stay text/plain — protect against Sheets auto-formatting
  // JSON blobs or dotted keys into dates/numbers.
  sheet.getRange(2, 1, rows.length - 1, 1).setNumberFormat('@');

  SpreadsheetApp.getUi().alert(
    'Config tab created. Rows are commented out with "#" — remove the "#" from a key to activate it, then hit Refresh in the dashboard.'
  );
}

/** Billing-cycle key (YYYY-MM of the cycle END month; cycles run 26th → 25th). */
function _currentCycleKey_() {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  if (now.getDate() >= 26) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return y + '-' + ('0' + m).slice(-2);
}

/** Current calendar month key YYYY-MM. */
function _currentMonthKey_() {
  const now = new Date();
  return now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
}
