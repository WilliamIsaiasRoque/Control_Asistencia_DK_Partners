/**
 * DK Partners attendance webhook.
 * Deploy as a Web App that executes as the admin account. Supabase sends batches
 * from its Edge Function; Supabase remains the source of truth.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return jsonOutput({ ok: false, error: 'Sincronización ocupada; reintenta luego.' });

  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var properties = PropertiesService.getScriptProperties();
    var expectedSecret = properties.getProperty('WEBHOOK_SECRET') || '';
    if (!expectedSecret || !constantTimeEquals(String(payload.secret || ''), expectedSecret)) {
      return jsonOutput({ ok: false, error: 'No autorizado.' });
    }

    var spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('Falta configurar SPREADSHEET_ID en las propiedades del script.');
    if (!Array.isArray(payload.items)) throw new Error('El cuerpo no contiene una lista items.');

    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    var index = ensureSyncIndex(spreadsheet);
    var result = [];
    payload.items.forEach(function (item) {
      try {
        result.push(syncAttendance(spreadsheet, index, item));
      } catch (error) {
        result.push({ attendance_id: String((item && item.id) || ''), ok: false, error: String(error.message || error).slice(0, 900) });
      }
    });
    SpreadsheetApp.flush();
    return jsonOutput({ ok: true, results: result });
  } catch (error) {
    return jsonOutput({ ok: false, error: String(error.message || error).slice(0, 900) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEquals(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function ensureSyncIndex(spreadsheet) {
  var name = '_SYNC_IDS';
  var headers = ['ATTENDANCE_ID', 'WORKER_ID', 'WORK_DATE', 'SHEET_TAB', 'ROW', 'ENTRY_COLUMN', 'EXIT_COLUMN'];
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.hideSheet();
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var existing = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    for (var i = 0; i < headers.length; i++) {
      if (String(existing[i] || '').trim().toUpperCase() !== headers[i]) {
        throw new Error('La pestaña _SYNC_IDS existe, pero sus columnas no coinciden con el índice esperado.');
      }
    }
  }
  return sheet;
}

function syncAttendance(spreadsheet, indexSheet, item) {
  if (!item || !item.id || !item.worker_id || !item.work_date || !item.worker_name) {
    throw new Error('La marca no contiene ID, trabajador, nombre y fecha.');
  }

  var dateParts = String(item.work_date).split('-');
  var month = Number(dateParts[1]);
  var months = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  var tabName = months[month - 1];
  if (!tabName || dateParts.length !== 3) throw new Error('La fecha de asistencia no es válida.');

  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('No existe la pestaña mensual ' + tabName + '.');
  var grid = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), Math.min(sheet.getMaxColumns(), 26)).getValues();
  var top = grid[0] || [];
  var sub = grid[1] || [];
  var dateColumn = sub.findIndex(function (value) { return normalizeName(value) === 'FECHA'; });
  if (dateColumn < 0) throw new Error('No encuentro la columna Fecha en la fila 2 de ' + tabName + '.');

  var rowIndex = -1;
  for (var r = 2; r < grid.length; r++) {
    if (sheetDateKey(grid[r][dateColumn], spreadsheet.getSpreadsheetTimeZone()) === item.work_date) {
      rowIndex = r;
      break;
    }
  }
  if (rowIndex < 0) throw new Error('No existe una fila para ' + item.work_date + ' en ' + tabName + '.');

  var workerColumn = top.findIndex(function (value, column) {
    return column > dateColumn && namesMatch(item.worker_name, value);
  });
  if (workerColumn < 0) throw new Error('No encuentro el bloque del trabajador "' + item.worker_name + '" en la fila 1 de ' + tabName + '.');

  var entryColumn = sub.findIndex(function (value, column) {
    return column >= workerColumn && normalizeName(value) === 'INGRESO';
  });
  var exitColumn = sub.findIndex(function (value, column) {
    return column > entryColumn && normalizeName(value) === 'SALIDA';
  });
  if (entryColumn < workerColumn || exitColumn <= entryColumn || exitColumn > workerColumn + 3) {
    throw new Error('No encuentro Ingreso y Salida en el bloque de "' + item.worker_name + '" de ' + tabName + '.');
  }

  var sheetRow = rowIndex + 1;
  writeTimeCell(sheet.getRange(sheetRow, entryColumn + 1), item.check_in_at);
  writeTimeCell(sheet.getRange(sheetRow, exitColumn + 1), item.check_out_at);

  var indexRow = findIndexRow(indexSheet, String(item.id));
  var values = [[String(item.id), String(item.worker_id), String(item.work_date), tabName, sheetRow, entryColumn + 1, exitColumn + 1]];
  if (indexRow) indexSheet.getRange(indexRow, 1, 1, values[0].length).setValues(values);
  else indexSheet.getRange(indexSheet.getLastRow() + 1, 1, 1, values[0].length).setValues(values);

  return { attendance_id: String(item.id), ok: true };
}

function writeTimeCell(range, timestamp) {
  if (!timestamp) {
    range.clearContent();
    return;
  }
  var date = new Date(timestamp);
  if (isNaN(date.getTime())) throw new Error('La marca contiene una hora inválida.');
  var timeText = Utilities.formatDate(date, 'America/Lima', 'HH:mm');
  var parts = timeText.split(':');
  var fractionOfDay = (Number(parts[0]) * 60 + Number(parts[1])) / 1440;
  range.setValue(fractionOfDay);
  range.setNumberFormat('h:mm AM/PM');
}

function findIndexRow(indexSheet, attendanceId) {
  var lastRow = indexSheet.getLastRow();
  if (lastRow < 2) return 0;
  var ids = indexSheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === attendanceId) return i + 2;
  }
  return 0;
}

function sheetDateKey(value, timeZone) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  var match = String(value || '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return '';
  return match[3] + '-' + String(match[2]).padStart(2, '0') + '-' + String(match[1]).padStart(2, '0');
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function namesMatch(profileName, headerName) {
  var profile = normalizeName(profileName);
  var header = normalizeName(headerName);
  return Boolean(profile && header && Math.min(profile.length, header.length) >= 3 &&
    (profile === header || profile.indexOf(header) === 0 || header.indexOf(profile) === 0));
}
