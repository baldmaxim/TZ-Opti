'use strict';

const XLSX = require('xlsx');

function buildXlsxBuffer(rows, sheetName = 'Лист1') {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildXlsxBuffer };
