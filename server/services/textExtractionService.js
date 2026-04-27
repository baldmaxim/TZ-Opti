'use strict';

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

async function extractFromFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.docx' || (mimeType && mimeType.includes('wordprocessingml'))) {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return { text: value, status: 'extracted' };
    }
    if (ext === '.pdf' || (mimeType && mimeType.includes('pdf'))) {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return { text: data.text || '', status: 'extracted' };
    }
    if (ext === '.xlsx' || ext === '.xls' || (mimeType && mimeType.includes('spreadsheetml'))) {
      const wb = XLSX.readFile(filePath);
      const parts = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ' | ' });
        parts.push(`# Лист: ${sheetName}\n${csv}`);
      }
      return { text: parts.join('\n\n'), status: 'extracted' };
    }
    if (ext === '.txt' || ext === '.md' || ext === '.csv') {
      const text = fs.readFileSync(filePath, 'utf8');
      return { text, status: 'extracted' };
    }
    return { text: '', status: 'failed', reason: `Неподдерживаемый формат: ${ext || mimeType}` };
  } catch (err) {
    return { text: '', status: 'failed', reason: err.message };
  }
}

module.exports = { extractFromFile };
