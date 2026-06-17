/**
 * Merge all monthly in-store time tabs into a single "All Data" sheet.
 *
 * Monthly tabs follow the naming pattern: Mon-YY (for example, Jan-26).
 * The dashboard reads the merged sheet through the "In-store Time" data range.
 *
 * Expected key headers include:
 * date_ts, order_id, picker_id, ipo, outlet_name,
 * order_ready_to_assign_ts_ist, order_picker_assigned_ts_ist,
 * order_picking_started_ts_ist, order_picking_completed_ts_ist,
 * order_billing_completed_ts_ist, assign_ready_to_billing_complete,
 * is_dropzone_available
 *
 * Header detection scans the first few rows so tabs work whether row 1 contains
 * direct headers or an IMPORTRANGE/formula row above the headers.
 */

const INSTORE_MASTER_SHEET_NAME = 'All Data';
const INSTORE_MAX_SOURCE_ROWS = 50000;
const INSTORE_SOURCE_COLS = 17; // Dashboard reads A:Q for In-store Time.
const INSTORE_WRITE_BATCH_ROWS = 10000;

const INSTORE_TAB_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})$/;

const INSTORE_HEADER_KEYWORDS = [
  'date_ts',
  'order_id',
  'picker_id',
  'ipo',
  'order_ready_to_assign_ts_ist',
  'order_picker_assigned_ts_ist',
  'order_picking_started_ts_ist',
  'order_picking_completed_ts_ist',
  'order_billing_completed_ts_ist',
  'assign_ready_to_billing_complete',
  'is_dropzone_available',
];

const INSTORE_REQUIRED_HEADERS = [
  'date_ts',
  'order_id',
  'picker_id',
  'ipo',
  'order_ready_to_assign_ts_ist',
  'order_picker_assigned_ts_ist',
  'order_picking_started_ts_ist',
  'order_picking_completed_ts_ist',
  'order_billing_completed_ts_ist',
  'assign_ready_to_billing_complete',
];

// Menu

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merge In-store Time')
    .addItem('Merge All Months', 'mergeAllInstoreTime')
    .addItem('Debug: Inspect Tabs', 'debugInspectInstoreTabs')
    .addSeparator()
    .addItem('Enable Auto-Merge', 'setupInstoreTimeTrigger')
    .addItem('Disable Auto-Merge', 'removeInstoreTimeTrigger')
    .addToUi();
}

// Manual trigger with UI alert

function mergeAllInstoreTime() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = doMergeInstoreTime(ss);

  try {
    const ui = SpreadsheetApp.getUi();

    if (result === null) {
      ui.alert('No monthly tabs found matching the Mon-YY pattern (for example, Jan-26).');
      return;
    }

    if (result.masterHeader === null) {
      ui.alert(
        'Merge Failed',
        'Could not find a valid in-store time header row in any monthly tab.\n\nRun "Debug: Inspect Tabs" to diagnose.',
        ui.ButtonSet.OK
      );
      return;
    }

    let message = `Merged ${result.rowCount} rows from ${result.tabsProcessed.length} tabs.\n\n`;
    message += `Processed:\n${result.tabsProcessed.join('\n')}`;

    if (result.missingRequiredHeaders.length > 0) {
      message += `\n\nMissing required headers in All Data:\n${result.missingRequiredHeaders.join('\n')}`;
    }

    if (result.tabsSkipped.length > 0) {
      message += `\n\nSkipped:\n${result.tabsSkipped.join('\n')}`;
    }

    ui.alert('Merge Complete', message.substring(0, 1800), ui.ButtonSet.OK);
  } catch (e) {
    Logger.log(result && result.masterHeader
      ? `In-store merge complete: ${result.rowCount} rows from ${result.tabsProcessed.length} tabs`
      : 'In-store merge failed or no tabs found');
  }
}

// Auto trigger handler without UI calls

/**
 * Time-based trigger: runs every 3 hours to rebuild All Data.
 */
function onInstoreTimeMergeTrigger() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = doMergeInstoreTime(ss);
    if (result !== null && result.masterHeader !== null) {
      ss.toast(`${result.rowCount} rows across ${result.tabsProcessed.length} months`, 'All Data updated', 4);
    }
  } catch (err) {
    Logger.log('onInstoreTimeMergeTrigger error: ' + err.message);
  }
}

// Trigger management

function setupInstoreTimeTrigger() {
  const ui = SpreadsheetApp.getUi();

  _removeInstoreTriggersNamed('onInstoreTimeMergeTrigger');

  ScriptApp.newTrigger('onInstoreTimeMergeTrigger')
    .timeBased()
    .everyHours(3)
    .create();

  ui.alert(
    'Auto-Merge Enabled',
    'All Data will now rebuild automatically every 3 hours.',
    ui.ButtonSet.OK
  );
}

function removeInstoreTimeTrigger() {
  const ui = SpreadsheetApp.getUi();
  const removed = _removeInstoreTriggersNamed('onInstoreTimeMergeTrigger');

  ui.alert(
    'Auto-Merge Disabled',
    removed > 0
      ? `Removed ${removed} trigger(s). All Data will no longer update automatically.`
      : 'No auto-merge trigger was active.',
    ui.ButtonSet.OK
  );
}

function _removeInstoreTriggersNamed(fnName) {
  let count = 0;
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  }
  return count;
}

// Core merge logic without UI calls

/**
 * Performs the full merge. Returns a result object or null if no monthly tabs exist.
 */
function doMergeInstoreTime(ss) {
  const monthlySheets = getInstoreTimeSheets(ss);
  if (monthlySheets.length === 0) return null;

  let masterHeader = null;
  let masterHeaderKeys = null;
  const allRows = [];
  const tabsProcessed = [];
  const tabsSkipped = [];

  for (const { sheet } of monthlySheets) {
    const tabName = sheet.getName();
    const readResult = _readInstoreSheetData(sheet);
    const data = readResult.data;

    if (data.length < 2) {
      tabsSkipped.push(`${tabName} (empty)`);
      continue;
    }

    const headerRowIndex = findInstoreHeaderRow(data);

    if (headerRowIndex === -1) {
      const preview = data.slice(0, 3)
        .map((r, i) => `row${i + 1}: [${r.slice(0, 5).join(' | ')}]`)
        .join('\n');
      tabsSkipped.push(`${tabName} (header not found)\n  ${preview}`);
      continue;
    }

    const header = _trimTrailingCells(data[headerRowIndex]);
    if (!masterHeader) {
      masterHeader = header;
      masterHeaderKeys = masterHeader.map(_normaliseInstoreHeader);
    }

    const rowMapper = _buildInstoreRowMapper(header, masterHeaderKeys);
    let rowsAdded = 0;

    for (let row = headerRowIndex + 1; row < data.length; row++) {
      const rowData = data[row];
      if (_isBlankInstoreRow(rowData)) continue;

      const normalised = rowMapper.map(sourceIndex => sourceIndex >= 0 ? rowData[sourceIndex] : '');
      if (!_isValidInstoreDataRow(normalised, masterHeaderKeys)) continue;

      allRows.push(normalised);
      rowsAdded++;
    }

    const capNote = readResult.hitRowCap ? ', hit row cap' : '';
    tabsProcessed.push(`${tabName} (${rowsAdded} rows, header at row ${headerRowIndex + 1}${capNote})`);
  }

  if (!masterHeader) {
    return { masterHeader: null, rowCount: 0, tabsProcessed, tabsSkipped, missingRequiredHeaders: [] };
  }

  const missingRequiredHeaders = _missingInstoreRequiredHeaders(masterHeader);

  let allDataSheet = ss.getSheetByName(INSTORE_MASTER_SHEET_NAME);
  if (allDataSheet) {
    allDataSheet.clear();
  } else {
    allDataSheet = ss.insertSheet(INSTORE_MASTER_SHEET_NAME);
  }

  allDataSheet.getRange(1, 1, 1, masterHeader.length).setValues([masterHeader]);
  allDataSheet.getRange(1, 1, 1, masterHeader.length).setFontWeight('bold');

  for (let start = 0; start < allRows.length; start += INSTORE_WRITE_BATCH_ROWS) {
    const batch = allRows.slice(start, start + INSTORE_WRITE_BATCH_ROWS);
    allDataSheet.getRange(2 + start, 1, batch.length, masterHeader.length).setValues(batch);
  }

  allDataSheet.setFrozenRows(1);
  allDataSheet.autoResizeColumns(1, masterHeader.length);

  return {
    masterHeader,
    rowCount: allRows.length,
    tabsProcessed,
    tabsSkipped,
    missingRequiredHeaders,
  };
}

// Debug

function debugInspectInstoreTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const monthlySheets = getInstoreTimeSheets(ss);

  if (monthlySheets.length === 0) {
    ui.alert('No monthly tabs found.');
    return;
  }

  let report = '';
  for (const { sheet } of monthlySheets) {
    const tabName = sheet.getName();
    const readResult = _readInstoreSheetData(sheet);
    const data = readResult.data;
    const headerRowIndex = findInstoreHeaderRow(data);
    const header = headerRowIndex >= 0 ? data[headerRowIndex] : [];
    const missing = headerRowIndex >= 0 ? _missingInstoreRequiredHeaders(header) : [];

    report += `\n-- ${tabName} (${data.length} rows read${readResult.hitRowCap ? ', hit row cap' : ''}) --\n`;
    report += `  Header detected at: ${headerRowIndex === -1 ? 'NOT FOUND' : `row ${headerRowIndex + 1}`}\n`;
    if (missing.length > 0) report += `  Missing required: ${missing.join(', ')}\n`;

    for (let r = 0; r < Math.min(3, data.length); r++) {
      const preview = data[r].slice(0, 6).map(c => String(c).substring(0, 18)).join(' | ');
      report += `  row${r + 1}: ${preview}\n`;
    }
  }

  Logger.log(report);
  ui.alert('Tab Inspection Report', report.substring(0, 1800) + (report.length > 1800 ? '\n...(see Logs for full output)' : ''), ui.ButtonSet.OK);
}

// Helpers

function _readInstoreSheetData(sheet) {
  const rowCount = Math.min(sheet.getMaxRows(), INSTORE_MAX_SOURCE_ROWS);
  const rawData = sheet.getRange(1, 1, rowCount, INSTORE_SOURCE_COLS).getValues();

  let lastUsed = 0;
  for (let r = 0; r < rawData.length; r++) {
    if (rawData[r].some(c => c !== '' && c !== null && c !== undefined)) lastUsed = r;
  }

  return {
    data: rawData.slice(0, lastUsed + 1),
    hitRowCap: lastUsed + 1 >= rowCount && rowCount >= INSTORE_MAX_SOURCE_ROWS,
  };
}

function findInstoreHeaderRow(data) {
  for (let r = 0; r < Math.min(data.length, 10); r++) {
    const cells = data[r].map(_normaliseInstoreHeader);
    let hits = 0;

    for (const keyword of INSTORE_HEADER_KEYWORDS) {
      if (cells.indexOf(keyword) !== -1) hits++;
    }

    if (hits >= 2) return r;
  }
  return -1;
}

function getInstoreTimeSheets(ss) {
  const monthMap = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };

  const result = [];
  for (const sheet of ss.getSheets()) {
    const match = sheet.getName().match(INSTORE_TAB_PATTERN);
    if (match) {
      const year = 2000 + parseInt(match[2], 10);
      const sortKey = year * 12 + monthMap[match[1]];
      result.push({ sheet, sortKey });
    }
  }

  return result.sort((a, b) => a.sortKey - b.sortKey);
}

function _buildInstoreRowMapper(sourceHeader, masterHeaderKeys) {
  const sourceIndexByKey = {};
  sourceHeader.forEach((header, index) => {
    const key = _normaliseInstoreHeader(header);
    if (key && sourceIndexByKey[key] === undefined) sourceIndexByKey[key] = index;
  });

  return masterHeaderKeys.map(key => sourceIndexByKey[key] === undefined ? -1 : sourceIndexByKey[key]);
}

function _isValidInstoreDataRow(rowData, headerKeys) {
  const nonEmpty = rowData.filter(c => c !== '' && c !== null && c !== undefined).length;
  if (nonEmpty < 3) return false;

  const dateIndex = headerKeys.indexOf('date_ts');
  const orderIndex = headerKeys.indexOf('order_id');
  const pickerIndex = headerKeys.indexOf('picker_id');

  const hasDate = dateIndex >= 0 && String(rowData[dateIndex] || '').trim() !== '';
  const hasOrder = orderIndex >= 0 && String(rowData[orderIndex] || '').trim() !== '';
  const hasPicker = pickerIndex >= 0 && String(rowData[pickerIndex] || '').trim() !== '';

  return hasDate && (hasOrder || hasPicker);
}

function _isBlankInstoreRow(rowData) {
  return rowData.every(cell => cell === '' || cell === null || cell === undefined);
}

function _trimTrailingCells(rowData) {
  let last = rowData.length - 1;
  while (last > 0 && (rowData[last] === '' || rowData[last] === null || rowData[last] === undefined)) {
    last--;
  }
  return rowData.slice(0, last + 1);
}

function _missingInstoreRequiredHeaders(header) {
  const keys = header.map(_normaliseInstoreHeader);
  return INSTORE_REQUIRED_HEADERS.filter(required => keys.indexOf(required) === -1);
}

function _normaliseInstoreHeader(value) {
  return String(value || '').trim().toLowerCase();
}
