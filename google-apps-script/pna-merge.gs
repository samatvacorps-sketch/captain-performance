/**
 * Merge all monthly PNA tabs into a single "All Data" sheet.
 *
 * Monthly tabs follow the naming pattern: Mon-YY (e.g., Jan-26, Jun-26)
 * Each tab is a flat table: ScheduledDate, pna_marked_at, outlet_id,
 * store_name, city, order_id, item_id, item_name, product_id, pna_qty, ...
 *
 * Some tabs may have an IMPORTRANGE formula in row 1, headers in row 2,
 * and data from row 3. Header detection scans the first 5 rows.
 */

// Keywords that reliably appear in the PNA header row.
const PNA_HEADER_KEYWORDS = [
  'scheduleddate',
  'pna_marked_at',
  'outlet_id',
  'order_id',
  'item_id',
  'pna_qty',
  'picker_id'
];

const PNA_TAB_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})$/;
const PNA_MASTER_SHEET_NAME = 'All Data';

// ─── Menu ────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merge PNAs')
    .addItem('Merge All Months', 'mergeAllPnas')
    .addItem('Debug: Inspect Tabs', 'debugInspectPnaTabs')
    .addSeparator()
    .addItem('Enable Auto-Merge', 'setupPnaTrigger')
    .addItem('Disable Auto-Merge', 'removePnaTrigger')
    .addToUi();
}

// ─── Manual trigger (with UI alert) ──────────────────────────────────────────

function mergeAllPnas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = doMergePnas(ss);

  try {
    const ui = SpreadsheetApp.getUi();

    if (result === null) {
      ui.alert('No monthly tabs found matching the Mon-YY pattern (e.g., Jan-26, Jun-26).');
      return;
    }

    if (result.masterHeader === null) {
      ui.alert(
        'Merge Failed',
        'Could not find a valid PNA header row in any monthly tab.\n\nRun "Debug: Inspect Tabs" to diagnose.',
        ui.ButtonSet.OK
      );
      return;
    }

    let message = `Merged ${result.rowCount} rows from ${result.tabsProcessed.length} tabs.\n\n`;
    message += `Processed:\n${result.tabsProcessed.join('\n')}`;
    if (result.tabsSkipped.length > 0) {
      message += `\n\nSkipped:\n${result.tabsSkipped.join('\n')}`;
    }
    ui.alert('Merge Complete', message, ui.ButtonSet.OK);

  } catch (e) {
    // No UI in trigger context — log result instead.
    Logger.log(result && result.masterHeader
      ? `PNA merge complete: ${result.rowCount} rows from ${result.tabsProcessed.length} tabs`
      : 'PNA merge failed or no tabs found');
  }
}

// ─── Auto trigger handler (no UI) ────────────────────────────────────────────

/**
 * Time-based trigger: runs every 3 hours to rebuild All Data.
 */
function onPnaMergeTimer() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = doMergePnas(ss);
    if (result !== null && result.masterHeader !== null) {
      ss.toast(`${result.rowCount} rows across ${result.tabsProcessed.length} months`, 'All Data updated', 4);
    }
  } catch (err) {
    Logger.log('onPnaMergeTimer error: ' + err.message);
  }
}

// ─── Trigger management ───────────────────────────────────────────────────────

function setupPnaTrigger() {
  const ui = SpreadsheetApp.getUi();

  _removePnaTriggersNamed('onPnaMergeTimer');

  ScriptApp.newTrigger('onPnaMergeTimer')
    .timeBased()
    .everyHours(3)
    .create();

  ui.alert(
    'Auto-Merge Enabled',
    'All Data will now rebuild automatically every 3 hours.',
    ui.ButtonSet.OK
  );
}

function removePnaTrigger() {
  const ui = SpreadsheetApp.getUi();
  const removed = _removePnaTriggersNamed('onPnaMergeTimer');

  ui.alert(
    'Auto-Merge Disabled',
    removed > 0
      ? `Removed ${removed} trigger(s). All Data will no longer update automatically.`
      : 'No auto-merge trigger was active.',
    ui.ButtonSet.OK
  );
}

function _removePnaTriggersNamed(fnName) {
  let count = 0;
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  }
  return count;
}

// ─── Core merge logic (no UI calls) ──────────────────────────────────────────

/**
 * Performs the full merge. Returns result object or null if no monthly tabs found.
 */
function doMergePnas(ss) {
  const monthlySheets = getPnaSheets(ss);
  if (monthlySheets.length === 0) return null;

  let masterHeader = null;
  const allRows = [];
  const tabsProcessed = [];
  const tabsSkipped = [];

  for (const { sheet } of monthlySheets) {
    const tabName = sheet.getName();

    // Read a fixed large range instead of getDataRange() because getDataRange()
    // can miss rows spilled by IMPORTRANGE and only see the formula cell.
    const lastCol = Math.max(sheet.getLastColumn(), 20);
    const rawData = sheet.getRange(1, 1, 5000, lastCol).getValues();

    let lastUsed = 0;
    for (let r = 0; r < rawData.length; r++) {
      if (rawData[r].some(c => c !== '' && c !== null)) lastUsed = r;
    }
    const data = rawData.slice(0, lastUsed + 1);

    if (data.length < 2) {
      tabsSkipped.push(`${tabName} (empty)`);
      continue;
    }

    const headerRowIndex = findPnaHeaderRow(data);

    if (headerRowIndex === -1) {
      const preview = data.slice(0, 3).map((r, i) => `row${i + 1}: [${r.slice(0, 6).join(' | ')}]`).join('\n');
      tabsSkipped.push(`${tabName} (header not found)\n  ${preview}`);
      continue;
    }

    const header = data[headerRowIndex];
    if (!masterHeader) masterHeader = header;

    let rowsAdded = 0;
    for (let row = headerRowIndex + 1; row < data.length; row++) {
      const rowData = data[row];

      if (rowData.every(cell => cell === '' || cell === null || cell === undefined)) continue;

      const nonEmpty = rowData.filter(c => c !== '' && c !== null && c !== undefined).length;
      if (nonEmpty < 3) continue;

      // PNA rows can have blank col A in some exports, so validate by core
      // business columns instead of requiring the first column.
      const orderId = rowData[6];
      const itemId = rowData[7];
      const pnaQty = rowData[10];
      if (String(orderId).trim() === '' && String(itemId).trim() === '' && String(pnaQty).trim() === '') continue;

      const colCount = masterHeader.length;
      const normalized = rowData.slice(0, colCount);
      while (normalized.length < colCount) normalized.push('');

      allRows.push(normalized);
      rowsAdded++;
    }

    tabsProcessed.push(`${tabName} (${rowsAdded} rows, header at row ${headerRowIndex + 1})`);
  }

  if (!masterHeader) return { masterHeader: null, rowCount: 0, tabsProcessed, tabsSkipped };

  let allDataSheet = ss.getSheetByName(PNA_MASTER_SHEET_NAME);
  if (allDataSheet) {
    allDataSheet.clear();
  } else {
    allDataSheet = ss.insertSheet(PNA_MASTER_SHEET_NAME);
  }

  allDataSheet.getRange(1, 1, 1, masterHeader.length).setValues([masterHeader]);
  allDataSheet.getRange(1, 1, 1, masterHeader.length).setFontWeight('bold');

  if (allRows.length > 0) {
    allDataSheet.getRange(2, 1, allRows.length, masterHeader.length).setValues(allRows);
  }

  for (let i = 1; i <= masterHeader.length; i++) {
    allDataSheet.autoResizeColumn(i);
  }
  allDataSheet.setFrozenRows(1);

  return { masterHeader, rowCount: allRows.length, tabsProcessed, tabsSkipped };
}

// ─── Debug ────────────────────────────────────────────────────────────────────

function debugInspectPnaTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const monthlySheets = getPnaSheets(ss);

  if (monthlySheets.length === 0) {
    ui.alert('No monthly tabs found.');
    return;
  }

  let report = '';
  for (const { sheet } of monthlySheets) {
    const tabName = sheet.getName();
    const rawData = sheet.getRange(1, 1, 5000, Math.max(sheet.getLastColumn(), 20)).getValues();
    let lastUsed = 0;
    for (let r = 0; r < rawData.length; r++) {
      if (rawData[r].some(c => c !== '' && c !== null)) lastUsed = r;
    }
    const data = rawData.slice(0, lastUsed + 1);
    const headerRowIndex = findPnaHeaderRow(data);

    report += `\n-- ${tabName} (${data.length} rows total) --\n`;
    report += `  Header detected at: ${headerRowIndex === -1 ? 'NOT FOUND' : `row ${headerRowIndex + 1}`}\n`;

    for (let r = 0; r < Math.min(3, data.length); r++) {
      const preview = data[r].slice(0, 8).map(c => String(c).substring(0, 15)).join(' | ');
      report += `  row${r + 1}: ${preview}\n`;
    }
  }

  Logger.log(report);
  ui.alert('Tab Inspection Report', report.substring(0, 1500) + (report.length > 1500 ? '\n...(see Logs for full output)' : ''), ui.ButtonSet.OK);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findPnaHeaderRow(data) {
  for (let r = 0; r < Math.min(data.length, 5); r++) {
    const cells = data[r].map(c => String(c).trim().toLowerCase());
    const hitCount = PNA_HEADER_KEYWORDS.filter(keyword => cells.includes(keyword)).length;
    if (hitCount >= 2) return r;
  }
  return -1;
}

function getPnaSheets(ss) {
  const monthMap = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
  };

  const result = [];
  for (const sheet of ss.getSheets()) {
    const match = sheet.getName().match(PNA_TAB_PATTERN);
    if (match) {
      const year = 2000 + parseInt(match[2], 10);
      const sortKey = year * 12 + monthMap[match[1]];
      result.push({ sheet, sortKey });
    }
  }

  return result.sort((a, b) => a.sortKey - b.sortKey);
}
