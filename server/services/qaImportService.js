'use strict';

// Импорт Q&A (форма «вопрос-ответ», .xlsx) — РАУНДАМИ, а не полной заменой.
//
// Каждый импорт — отдельная строка qa_imports (номер раунда + дата + снимок
// разобранного файла). Прежние вопросы и ответы НЕ удаляются: записи qa_entries
// несут статус active | superseded | cancelled; новый ответ на тот же вопрос
// вставляется НОВОЙ записью и явно ссылается на отменяемую
// (supersedes_entry_id), а прежняя переводится в superseded.
//
// Разбираются ВСЕ листы книги (лист без шапки «Вопрос/Ответ» помечается
// непригодным, но импорт не роняет); при применении можно выбрать нужные листы.
//
// Двухфазный поток: previewQaImport (разбор + diff против активных записей,
// строка qa_imports со статусом pending, БД записей не трогается) →
// applyQaImport (diff пересчитывается в транзакции и применяется) или
// discardQaImport. importQaXlsx — одношаговый путь (загрузка документа в слот
// qa, спасательный реимпорт перед стадией 2): все листы, тот же diff — поэтому
// повторный импорт того же файла идемпотентен (совпавшие пары не дублируются).
//
// ИНВАРИАНТ: импорт Q&A НИКОГДА не трогает таблицу characteristics —
// характеристики самостоятельный источник (см. README, characteristicsTemplate).
// Прежний DELETE FROM characteristics был реликтом MVP-схемы «характеристики
// из Q&A» и удалён.

const XLSX = require('xlsx');
const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');

const HEADER_KEYWORDS = ['вопрос', 'ответ', 'раздел', 'решен', 'дата', 'получен'];

const ENTRY_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  CANCELLED: 'cancelled',
});

const IMPORT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  DISCARDED: 'discarded',
});

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

// --- Разбор книги (чистая по данным: вход — матрицы строк) --------------------

// Один лист → { name, ok, reason?, entries[], rounds[], sections[] }.
function parseSheetRows(name, rows) {
  if (!rows || !rows.length) return { name, ok: false, reason: 'лист пуст', entries: [] };
  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) {
    return { name, ok: false, reason: 'не найдена шапка (нет колонок «Вопрос»/«Ответ»)', entries: [] };
  }
  const cols = mapHeaders(rows[headerIdx]);
  if (cols.question === -1 || cols.answer === -1) {
    return { name, ok: false, reason: 'в шапке нет колонок «Вопрос» и «Ответ»', entries: [] };
  }

  const entries = [];
  const rounds = new Set();
  const sections = new Set();
  let currentRound = null;
  for (const row of rows.slice(headerIdx + 1)) {
    if (isColumnIndexRow(row, cols)) continue;
    const roundLabel = detectRoundLabel(row, cols.question);
    if (roundLabel) {
      currentRound = roundLabel;
      rounds.add(roundLabel);
      continue;
    }
    const question = norm(row[cols.question]);
    const answer = norm(row[cols.answer]);
    const section = cols.section >= 0 ? norm(row[cols.section]) : '';
    const decision = cols.accepted_decision >= 0 ? norm(row[cols.accepted_decision]) : '';
    const sentAt = cols.sent_at >= 0 ? norm(row[cols.sent_at]) : '';
    const answerAt = cols.answer_at >= 0 ? norm(row[cols.answer_at]) : '';
    if (!question && !answer && !section && !decision) continue;
    entries.push({
      section: section || null,
      sent_at: sentAt || null,
      answer_at: answerAt || null,
      round_label: currentRound || null,
      question: question || null,
      answer: answer || null,
      accepted_decision: decision || null,
    });
    if (section) sections.add(section);
  }
  if (!entries.length) {
    return { name, ok: false, reason: 'на листе не нашлось ни одной пары вопрос-ответ', entries: [] };
  }
  return { name, ok: true, entries, rounds: [...rounds], sections: [...sections] };
}

// ВСЕ листы книги. Хотя бы один пригодный обязателен.
function parseQaWorkbook(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  if (!wb.SheetNames.length) throw badRequest('Файл xlsx пуст: нет ни одного листа');
  const sheets = wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', header: 1 });
    return parseSheetRows(name, rows);
  });
  if (!sheets.some((s) => s.ok)) {
    throw badRequest(
      'Ни на одном листе не найдено пар вопрос-ответ. Ожидаются колонки: «Вопрос», «Ответ», «Раздел», «Дата», «Принятые решения».',
    );
  }
  return { sheets };
}

// --- Diff (чистая) ------------------------------------------------------------

const qKey = (q) => lc(q);

// Сопоставление входящих записей с ТЕКУЩИМИ активными:
//   unchanged      — тот же вопрос и тот же ответ уже есть активной записью
//                    (дубль не вставляется — сохраняются привязки к ТЗ и разметка);
//   answer_changed — вопрос есть, ответ другой: новая запись станет active,
//                    прежняя → superseded (supersedes_entry_id — явная связь);
//   new            — вопроса среди активных нет (или строка без вопроса).
// Записи в статусах superseded/cancelled в сопоставлении НЕ участвуют.
function diffQaEntries(currentActive, incoming) {
  const byQuestion = new Map(); // qKey -> [active rows]
  for (const row of currentActive || []) {
    const k = qKey(row.question);
    if (!k) continue;
    if (!byQuestion.has(k)) byQuestion.set(k, []);
    byQuestion.get(k).push(row);
  }
  const items = [];
  const matchedCurrentIds = new Set();
  for (const inc of incoming || []) {
    const k = qKey(inc.question);
    const candidates = (k && byQuestion.get(k)) || [];
    const same = candidates.find(
      (c) => lc(c.answer) === lc(inc.answer) && !matchedCurrentIds.has(c.id),
    );
    if (same) {
      matchedCurrentIds.add(same.id);
      items.push({ kind: 'unchanged', incoming: inc, current_id: same.id });
      continue;
    }
    const changed = candidates.find((c) => !matchedCurrentIds.has(c.id));
    if (changed) {
      matchedCurrentIds.add(changed.id);
      items.push({
        kind: 'answer_changed',
        incoming: inc,
        current_id: changed.id,
        current_answer: changed.answer || null,
      });
      continue;
    }
    items.push({ kind: 'new', incoming: inc, current_id: null });
  }
  const count = (kind) => items.filter((i) => i.kind === kind).length;
  return {
    items,
    summary: {
      total: items.length,
      new: count('new'),
      answer_changed: count('answer_changed'),
      unchanged: count('unchanged'),
    },
  };
}

// --- DB-слой -------------------------------------------------------------------

async function loadActiveEntries(tenderId, tx = null) {
  const e = tx || db;
  return e.queryAll(
    `SELECT * FROM qa_entries
      WHERE tender_id = ? AND COALESCE(status, 'active') = 'active'
      ORDER BY order_idx ASC`,
    tenderId,
  );
}

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch (_e) { return fallback; }
}

function importRowToApi(row, { withPayload = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    tender_id: row.tender_id,
    round_no: Number(row.round_no),
    original_name: row.original_name,
    status: row.status,
    created_at: row.created_at,
    applied_at: row.applied_at,
    sheets: parseJson(row.sheets_json, []).map((s) => ({
      name: s.name, ok: s.ok, reason: s.reason || null, entries: s.entries.length,
    })),
    summary: parseJson(row.summary_json, null),
  };
  if (withPayload) out.payload_sheets = parseJson(row.sheets_json, []);
  return out;
}

// Фаза 1: разобрать файл, построить diff, сохранить строку раунда (pending).
// Записи qa_entries и характеристики НЕ трогаются.
async function previewQaImport(tenderId, filePath, { originalName = null } = {}) {
  const { sheets } = parseQaWorkbook(filePath);
  const active = await loadActiveEntries(tenderId);

  const sheetDiffs = sheets.map((s) => (s.ok
    ? { name: s.name, ok: true, diff: diffQaEntries(active, s.entries) }
    : { name: s.name, ok: false, reason: s.reason }));

  const id = newId();
  const createdAt = nowIso();
  const roundNo = await db.transaction(async (tx) => {
    const last = await tx.queryOne(
      'SELECT COALESCE(MAX(round_no), 0) AS n FROM qa_imports WHERE tender_id = ?', tenderId,
    );
    const n = Number((last && last.n) || 0) + 1;
    await tx.queryRun(
      `INSERT INTO qa_imports (
         id, tender_id, round_no, source_file_path, original_name,
         sheets_json, summary_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, tenderId, n, filePath, originalName,
      JSON.stringify(sheets),
      JSON.stringify(summarizeSheetDiffs(sheetDiffs)),
      createdAt,
    );
    return n;
  });

  return {
    import_id: id,
    round_no: roundNo,
    sheets: sheetDiffs.map((s) => (s.ok
      ? {
        name: s.name,
        ok: true,
        summary: s.diff.summary,
        items: s.diff.items.map((it) => ({
          kind: it.kind,
          question: (it.incoming.question || '').slice(0, 300),
          answer: (it.incoming.answer || '').slice(0, 300),
          current_answer: it.current_answer ? it.current_answer.slice(0, 300) : undefined,
          section: it.incoming.section,
          round_label: it.incoming.round_label,
        })),
      }
      : { name: s.name, ok: false, reason: s.reason })),
    summary: summarizeSheetDiffs(sheetDiffs),
  };
}

function summarizeSheetDiffs(sheetDiffs) {
  const sum = { sheets_ok: 0, sheets_skipped: 0, new: 0, answer_changed: 0, unchanged: 0 };
  for (const s of sheetDiffs) {
    if (!s.ok) { sum.sheets_skipped += 1; continue; }
    sum.sheets_ok += 1;
    sum.new += s.diff.summary.new;
    sum.answer_changed += s.diff.summary.answer_changed;
    sum.unchanged += s.diff.summary.unchanged;
  }
  return sum;
}

// Применить diff одного набора записей внутри транзакции.
async function applyEntriesTx(tx, tenderId, importRow, entries, { startOrderIdx }) {
  const active = await loadActiveEntries(tenderId, tx);
  const { items, summary } = diffQaEntries(active, entries);
  let orderIdx = startOrderIdx;
  const importedAt = nowIso();
  for (const it of items) {
    if (it.kind === 'unchanged') continue;
    if (it.kind === 'answer_changed') {
      await tx.queryRun(
        `UPDATE qa_entries SET status = 'superseded' WHERE id = ?`, it.current_id,
      );
    }
    await tx.queryRun(
      `INSERT INTO qa_entries
         (id, tender_id, source_file_path, section, sent_at, answer_at, round_label,
          question, answer, accepted_decision, order_idx, imported_at,
          qa_import_id, status, supersedes_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      newId(), tenderId, importRow.source_file_path,
      it.incoming.section, it.incoming.sent_at, it.incoming.answer_at, it.incoming.round_label,
      it.incoming.question, it.incoming.answer, it.incoming.accepted_decision,
      orderIdx, importedAt,
      importRow.id, it.kind === 'answer_changed' ? it.current_id : null,
    );
    orderIdx += 1;
  }
  return { summary, nextOrderIdx: orderIdx };
}

// Фаза 2: применить раунд. sheetNames (опц.) — выбранные листы; по умолчанию все
// пригодные. Diff пересчитывается В ТРАНЗАКЦИИ против текущих активных записей
// (между preview и apply записи могли измениться). Характеристики не трогаются.
async function applyQaImport(tenderId, importId, { sheetNames = null } = {}) {
  return db.transaction(async (tx) => {
    const row = await tx.queryOne(
      'SELECT * FROM qa_imports WHERE id = ? AND tender_id = ? FOR UPDATE', importId, tenderId,
    );
    if (!row) throw notFound('Раунд импорта Q&A не найден');
    if (row.status !== IMPORT_STATUS.PENDING) {
      throw badRequest(`Раунд уже ${row.status === IMPORT_STATUS.APPLIED ? 'применён' : 'отменён'}`);
    }
    const sheets = parseJson(row.sheets_json, []);
    const usable = sheets.filter((s) => s.ok);
    const chosen = sheetNames && sheetNames.length
      ? usable.filter((s) => sheetNames.includes(s.name))
      : usable;
    if (!chosen.length) throw badRequest('Не выбран ни один пригодный лист');

    const maxRow = await tx.queryOne(
      'SELECT COALESCE(MAX(order_idx), -1) AS m FROM qa_entries WHERE tender_id = ?', tenderId,
    );
    let orderIdx = Number((maxRow && maxRow.m) ?? -1) + 1;

    const perSheet = [];
    for (const sheet of chosen) {
      const { summary, nextOrderIdx } = await applyEntriesTx(tx, tenderId, row, sheet.entries, {
        startOrderIdx: orderIdx,
      });
      orderIdx = nextOrderIdx;
      perSheet.push({ name: sheet.name, ...summary });
    }

    const total = perSheet.reduce((acc, s) => ({
      new: acc.new + s.new,
      answer_changed: acc.answer_changed + s.answer_changed,
      unchanged: acc.unchanged + s.unchanged,
    }), { new: 0, answer_changed: 0, unchanged: 0 });

    await tx.queryRun(
      `UPDATE qa_imports SET status = 'applied', applied_at = ?, summary_json = ? WHERE id = ?`,
      nowIso(), JSON.stringify({ ...total, per_sheet: perSheet, applied_sheets: chosen.map((s) => s.name) }),
      importId,
    );

    return {
      import_id: importId,
      round_no: Number(row.round_no),
      applied_sheets: chosen.map((s) => s.name),
      ...total,
      per_sheet: perSheet,
    };
  });
}

async function discardQaImport(tenderId, importId) {
  const res = await db.queryRun(
    `UPDATE qa_imports SET status = 'discarded' WHERE id = ? AND tender_id = ? AND status = 'pending'`,
    importId, tenderId,
  );
  const changed = (res && (res.changes ?? res.rowCount)) || 0;
  if (!changed) throw notFound('Раунд импорта Q&A не найден или уже обработан');
  return { import_id: importId, status: IMPORT_STATUS.DISCARDED };
}

async function listQaImports(tenderId) {
  const rows = await db.queryAll(
    'SELECT * FROM qa_imports WHERE tender_id = ? ORDER BY round_no DESC', tenderId,
  );
  return rows.map((r) => importRowToApi(r));
}

// Одношаговый импорт (без предпросмотра): загрузка документа в слот qa и
// спасательный реимпорт перед стадией 2. Все пригодные листы; благодаря diff
// повторный импорт того же файла идемпотентен. Характеристики НЕ трогаются.
async function importQaXlsx(tenderId, filePath, { originalName = null } = {}) {
  const preview = await previewQaImport(tenderId, filePath, { originalName });
  const result = await applyQaImport(tenderId, preview.import_id);
  const qaCount = result.new + result.answer_changed;
  return {
    qa_count: qaCount,
    new: result.new,
    answer_changed: result.answer_changed,
    unchanged: result.unchanged,
    round_no: result.round_no,
    import_id: result.import_id,
    sheets: result.applied_sheets,
  };
}

module.exports = {
  ENTRY_STATUS,
  IMPORT_STATUS,
  // чистое ядро (офлайн-тесты)
  parseSheetRows,
  diffQaEntries,
  // DB
  parseQaWorkbook,
  previewQaImport,
  applyQaImport,
  discardQaImport,
  listQaImports,
  importQaXlsx,
};
