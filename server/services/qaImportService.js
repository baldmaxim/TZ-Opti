'use strict';

const XLSX = require('xlsx');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest } = require('../utils/errors');

const HEADER_KEYWORDS = ['вопрос', 'ответ', 'раздел', 'решен', 'дата', 'получен'];

function norm(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v)
    .replace(/\s+/g, ' ')
    .trim();
}

function lc(v) {
  return norm(v).toLowerCase();
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const cells = rows[i] || [];
    let hits = 0;
    for (const c of cells) {
      const s = lc(c);
      if (!s) continue;
      if (HEADER_KEYWORDS.some((kw) => s.includes(kw))) hits += 1;
      if (hits >= 2) return i;
    }
  }
  return -1;
}

function mapHeaders(headerRow) {
  // Возвращает индексы колонок для известных логических полей.
  const map = { question: -1, answer: -1, section: -1, accepted_decision: -1, sent_at: -1, answer_at: -1 };
  for (let i = 0; i < headerRow.length; i += 1) {
    const h = lc(headerRow[i]);
    if (!h) continue;
    if (map.answer_at === -1 && h.includes('получен')) {
      map.answer_at = i;
      continue;
    }
    if (map.accepted_decision === -1 && h.includes('решен')) {
      map.accepted_decision = i;
      continue;
    }
    if (map.section === -1 && h.includes('раздел')) {
      map.section = i;
      continue;
    }
    if (map.question === -1 && h.includes('вопрос')) {
      map.question = i;
      continue;
    }
    if (map.answer === -1 && h.includes('ответ')) {
      map.answer = i;
      continue;
    }
    if (h.includes('дата')) {
      if (map.sent_at === -1) map.sent_at = i;
      else if (map.answer_at === -1) map.answer_at = i;
    }
  }
  return map;
}

function detectRoundLabel(row, qIdx) {
  // \b в JS-регексе не работает с кириллицей, поэтому используем явную проверку.
  const cell = norm(row[qIdx]);
  if (cell.toLowerCase().startsWith('направлено')) return cell;
  return null;
}

function isColumnIndexRow(row, cols) {
  // В реальных файлах после строки заголовков встречается строка с номерами колонок (1,2,3,4,5,6,7).
  // Отличить её от настоящей записи: question состоит только из цифр и короткий.
  const q = norm(row[cols.question]);
  if (!/^\d{1,3}$/.test(q)) return false;
  const a = norm(row[cols.answer]);
  return /^\d{1,3}$/.test(a);
}

async function importQaXlsx(tenderId, filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw badRequest('Файл xlsx пуст: нет ни одного листа');
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });
  if (!rows.length) throw badRequest('В Q&A xlsx нет строк');

  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) {
    throw badRequest(
      'Не нашёл строки с заголовками. Ожидаются колонки: «Вопрос», «Ответ», «Раздел», «Дата», «Принятые решения».',
    );
  }
  const headers = rows[headerIdx];
  const cols = mapHeaders(headers);
  if (cols.question === -1 || cols.answer === -1) {
    throw badRequest('В шапке не нашлись колонки «Вопрос» и «Ответ». Проверьте формат файла.');
  }

  const data = rows.slice(headerIdx + 1);

  const result = await db.transaction(async (tx) => {
    await tx.queryRun('DELETE FROM characteristics WHERE tender_id = ?', tenderId);
    await tx.queryRun('DELETE FROM qa_entries WHERE tender_id = ?', tenderId);

    let currentRound = null;
    let orderIdx = 0;
    let qaCount = 0;
    const rounds = new Set();
    const sections = new Set();

    for (const row of data) {
      if (isColumnIndexRow(row, cols)) continue;
      const roundLabel = cols.question >= 0 ? detectRoundLabel(row, cols.question) : null;
      if (roundLabel) {
        currentRound = roundLabel;
        rounds.add(roundLabel);
        continue;
      }
      const question = cols.question >= 0 ? norm(row[cols.question]) : '';
      const answer = cols.answer >= 0 ? norm(row[cols.answer]) : '';
      const section = cols.section >= 0 ? norm(row[cols.section]) : '';
      const decision = cols.accepted_decision >= 0 ? norm(row[cols.accepted_decision]) : '';
      const sentAt = cols.sent_at >= 0 ? norm(row[cols.sent_at]) : '';
      const answerAt = cols.answer_at >= 0 ? norm(row[cols.answer_at]) : '';
      if (!question && !answer && !section && !decision) continue;

      await tx.queryRun(
        `
        INSERT INTO qa_entries
          (id, tender_id, source_file_path, section, sent_at, answer_at, round_label,
           question, answer, accepted_decision, order_idx, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        newId(),
        tenderId,
        filePath,
        section || null,
        sentAt || null,
        answerAt || null,
        currentRound || null,
        question || null,
        answer || null,
        decision || null,
        orderIdx,
        nowIso(),
      );
      orderIdx += 1;
      qaCount += 1;
      if (section) sections.add(section);
    }

    if (qaCount === 0) {
      throw badRequest('В файле не нашлось ни одной пары вопрос-ответ.');
    }

    return { qaCount, sections, rounds };
  });

  return {
    qa_count: result.qaCount,
    characteristics_count: 0,
    sections_count: result.sections.size,
    rounds: [...result.rounds],
  };
}

module.exports = { importQaXlsx };
