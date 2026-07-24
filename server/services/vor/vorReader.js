'use strict';

// Чтение книги xls/xlsx в «сетку» для vorParser: значения ячеек + объединения.
// Единственное место, где ВОР касается библиотеки xlsx, — разбор (vorParser.js)
// остаётся чистым и тестируется офлайн.

const path = require('path');
const XLSX = require('xlsx');

const SPREADSHEET_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods']);

function isSpreadsheet(fileName, mimeType) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (SPREADSHEET_EXT.has(ext)) return true;
  const mt = String(mimeType || '').toLowerCase();
  return mt.includes('spreadsheetml') || mt.includes('ms-excel') || mt.includes('opendocument.spreadsheet');
}

// Возвращает [{ name, index, rows, merges }]. Координаты строк/колонок ВСЕГДА
// считаются от A1 (диапазон листа принудительно расширяется до начала), иначе
// row_index и адреса ячеек разъехались бы с тем, что инженер видит в Excel.
function gridsFromWorkbook(wb) {
  return wb.SheetNames.map((name, index) => {
    const sheet = wb.Sheets[name] || {};
    let range = null;
    if (sheet['!ref']) {
      range = XLSX.utils.decode_range(sheet['!ref']);
      range.s.r = 0;
      range.s.c = 0;
    }
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: true,
      raw: true,
      ...(range ? { range } : {}),
    });
    return { name, index, rows, merges: sheet['!merges'] || [] };
  });
}

function readGridsFromFile(filePath) {
  return gridsFromWorkbook(XLSX.readFile(filePath, { cellDates: true }));
}

function readGridsFromBuffer(buffer) {
  return gridsFromWorkbook(XLSX.read(buffer, { type: 'buffer', cellDates: true }));
}

module.exports = { isSpreadsheet, gridsFromWorkbook, readGridsFromFile, readGridsFromBuffer, SPREADSHEET_EXT };
