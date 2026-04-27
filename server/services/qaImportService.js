'use strict';

const XLSX = require('xlsx');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest } = require('../utils/errors');

/**
 * Ожидаемые колонки xlsx (заголовки в первой строке):
 *   Вопрос | Ответ | Принятое решение | Источник характеристики | Значение
 *
 * Алгоритм:
 *   1. Читаем первый лист.
 *   2. Каждая непустая строка → qa_entries.
 *   3. Если есть «Источник характеристики» и «Значение» → создаём characteristic.
 */
function importQaXlsx(tenderId, filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw badRequest('Файл xlsx пуст');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) throw badRequest('В Q&A xlsx нет строк');

  const norm = (s) => (s || '').toString().trim();

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM characteristics WHERE tender_id = ?').run(tenderId);
    db.prepare('DELETE FROM qa_entries WHERE tender_id = ?').run(tenderId);

    const insQa = db.prepare(`
      INSERT INTO qa_entries (id, tender_id, source_file_path, question, answer, accepted_decision, order_idx, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insChar = db.prepare(`
      INSERT INTO characteristics (id, tender_id, name, value, source, comment, derived_from_qa_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    rows.forEach((row, idx) => {
      const question = norm(row['Вопрос'] || row['question']);
      const answer = norm(row['Ответ'] || row['answer']);
      const decision = norm(row['Принятое решение'] || row['accepted_decision']);
      const charName = norm(row['Источник характеристики'] || row['characteristic']);
      const charValue = norm(row['Значение'] || row['value']);
      if (!question && !answer && !charName) return;

      const qaId = newId();
      insQa.run(qaId, tenderId, filePath, question, answer, decision, idx, nowIso());
      const finalName = charName || question;
      const finalValue = charValue || decision || answer;
      if (finalName) {
        insChar.run(
          newId(),
          tenderId,
          finalName,
          finalValue || '',
          'Q&A',
          decision || null,
          qaId
        );
      }
    });
  });
  tx();

  return {
    qa_count: db.prepare('SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?').get(tenderId).c,
    characteristics_count: db.prepare('SELECT COUNT(*) as c FROM characteristics WHERE tender_id = ?').get(tenderId).c,
  };
}

module.exports = { importQaXlsx };
