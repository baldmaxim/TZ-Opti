'use strict';

// Импорт ВОР в БД: файл xls/xlsx → позиции (vor_items) + отчёт разбора.
//
// Одна позиция ведомости = одна строка таблицы со всеми координатами (лист,
// строка Excel, адреса ячеек). Импорт ИДЕМПОТЕНТЕН и СКОУПЛЕН ДОКУМЕНТОМ:
// в одной транзакции заменяются позиции ЭТОГО файла, а не всего тендера —
// в тендере одновременно живёт несколько ВОР (корпус 1, корпус 2, …), и
// переимпорт одного корпуса не стирает ведомость другого.
//
// Чтение (loadVorItems) отдаёт позиции только АКТУАЛЬНЫХ по манифесту
// документов ВОР: superseded-редакция исключается вместе со своими позициями.

const fs = require('fs');
const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const { parseGrids } = require('./vorParser');
const { isSpreadsheet, readGridsFromFile } = require('./vorReader');
const { selectActiveDocuments } = require('../documents/manifestModel');

const INSERT_CHUNK = 200;

const COLUMNS = [
  'id', 'tender_id', 'document_id', 'order_idx', 'sheet_name', 'sheet_index', 'row_index',
  'position_no', 'code', 'section', 'name', 'name_key', 'unit', 'unit_raw', 'unit_known',
  'quantity', 'quantity_raw', 'note', 'row_kind', 'cells', 'merged_cells', 'imported_at',
];

function rowValues(item, { tenderId, documentId, importedAt }) {
  return [
    newId(),
    tenderId,
    documentId || null,
    item.order_idx,
    item.sheet_name || null,
    item.sheet_index ?? null,
    item.row_index ?? null,
    item.position_no || null,
    item.code || null,
    item.section || null,
    item.name,
    item.name_key || null,
    item.unit || null,
    item.unit_raw || null,
    item.unit_known ? 1 : 0,
    item.quantity,
    item.quantity_raw || null,
    item.note || null,
    item.row_kind || 'item',
    JSON.stringify(item.cells || {}),
    JSON.stringify(item.merged_cells || {}),
    importedAt,
  ];
}

async function insertItems(tx, items, meta) {
  const placeholders = `(${COLUMNS.map(() => '?').join(', ')})`;
  for (let i = 0; i < items.length; i += INSERT_CHUNK) {
    const chunk = items.slice(i, i + INSERT_CHUNK);
    const sql =
      `INSERT INTO vor_items (${COLUMNS.join(', ')}) VALUES ` +
      chunk.map(() => placeholders).join(', ');
    const params = chunk.flatMap((item) => rowValues(item, meta));
    // eslint-disable-next-line no-await-in-loop
    await tx.queryRun(sql, ...params);
  }
}

// Сводка по единицам измерения — «что и в чём считает ВОР» одним взглядом.
function unitSummary(items) {
  const byUnit = new Map();
  for (const it of items) {
    const key = it.unit || '—';
    const cur = byUnit.get(key) || { unit: key, positions: 0, quantity: 0, known: it.unit_known !== false };
    cur.positions += 1;
    if (typeof it.quantity === 'number') cur.quantity += it.quantity;
    byUnit.set(key, cur);
  }
  return [...byUnit.values()]
    .sort((a, b) => b.positions - a.positions)
    .map((u) => ({ ...u, quantity: Math.round(u.quantity * 1000) / 1000 }));
}

// Разбирает файл БЕЗ записи в БД (используется и импортом, и предпросмотром).
function parseVorFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw badRequest('Файл ВОР не найден на диске — загрузите документ заново.');
  }
  const grids = readGridsFromFile(filePath);
  const parsed = parseGrids(grids);
  return parsed;
}

// filePath → vor_items(tenderId). Возвращает отчёт разбора.
async function importVorFile(tenderId, { documentId = null, filePath }) {
  const parsed = parseVorFile(filePath);
  if (!parsed.items.length) {
    const detail = parsed.warnings.map((w) => w.message).join(' ');
    throw badRequest(
      `В ВОР не распознано ни одной позиции. Нужны колонки «Наименование», «Ед. изм.», «Кол-во». ${detail}`.trim(),
    );
  }
  const importedAt = nowIso();
  await db.transaction(async (tx) => {
    // Скоуп удаления — ЭТОТ документ: позиции других ВОР тендера не трогаем.
    // IS NOT DISTINCT FROM покрывает и legacy-строки без document_id.
    await tx.queryRun(
      'DELETE FROM vor_items WHERE tender_id = ? AND document_id IS NOT DISTINCT FROM ?',
      tenderId, documentId || null,
    );
    await insertItems(tx, parsed.items, { tenderId, documentId, importedAt });
  });

  const report = {
    imported_at: importedAt,
    document_id: documentId,
    stats: parsed.stats,
    sheets: parsed.sheets,
    warnings: parsed.warnings,
    units: unitSummary(parsed.items),
  };
  if (documentId) {
    await db
      .queryRun('UPDATE documents SET import_report = ? WHERE id = ?', JSON.stringify(report), documentId)
      .catch(() => {}); // отчёт — справочная информация, импорт из-за него не падает
  }
  // eslint-disable-next-line no-console
  console.log(
    `[vor] импорт: ${parsed.stats.items} позиций с ${parsed.stats.sheets_parsed}/${parsed.stats.sheets} листов ` +
      `(с количеством ${parsed.stats.with_quantity}, с единицей ${parsed.stats.with_unit}), ` +
      `предупреждений ${parsed.warnings.length}`,
  );
  return report;
}

function mapRow(row) {
  const parseJson = (s) => {
    if (!s) return {};
    try { return JSON.parse(s); } catch (_e) { return {}; }
  };
  return {
    id: row.id,
    document_id: row.document_id || null,
    order_idx: row.order_idx,
    sheet_name: row.sheet_name || '',
    sheet_index: row.sheet_index,
    row_index: row.row_index,
    position_no: row.position_no || '',
    code: row.code || '',
    section: row.section || '',
    name: row.name,
    name_key: row.name_key || '',
    unit: row.unit || '',
    unit_raw: row.unit_raw || '',
    unit_known: row.unit_known === 1 || row.unit_known === true,
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    quantity_raw: row.quantity_raw || '',
    note: row.note || '',
    row_kind: row.row_kind || 'item',
    cells: parseJson(row.cells),
    merged_cells: parseJson(row.merged_cells),
  };
}

// Актуальные по манифесту документы ВОР тендера (в порядке релевантности).
async function activeVorDocuments(tenderId) {
  const docs = await db.queryAll('SELECT * FROM documents WHERE tender_id = ?', tenderId);
  return selectActiveDocuments(docs, 'vor');
}

// Позиции ВСЕХ актуальных ВОР тендера. Позиции superseded-редакций остаются в
// БД (история), но в анализ и API не попадают. Legacy-строки без document_id
// (импорт до скоупинга) считаются актуальными. Порядок: документы в порядке
// манифеста, внутри документа — порядок листа.
async function loadVorItems(tenderId) {
  const rows = await db.queryAll(
    'SELECT * FROM vor_items WHERE tender_id = ? ORDER BY order_idx ASC',
    tenderId,
  );
  const active = await activeVorDocuments(tenderId);
  const rank = new Map(active.map((d, i) => [d.id, i]));
  return rows
    .map(mapRow)
    .filter((it) => !it.document_id || rank.has(it.document_id))
    .sort((a, b) => {
      const ra = a.document_id ? rank.get(a.document_id) : rank.size;
      const rb = b.document_id ? rank.get(b.document_id) : rank.size;
      return ra - rb || a.order_idx - b.order_idx;
    });
}

// Ленивая самопочинка: у актуального документа ВОР нет своих позиций, а файл —
// таблица на диске → импортируем прямо сейчас. Нужно для ВОР, загруженных до
// появления структурного импорта (и для скоупинга по документам). Принимает
// один документ или список; ошибка импорта НЕ роняет анализ — стадия 1
// продолжит на текстовом фолбэке.
async function ensureVorItems(tenderId, vorDocOrDocs) {
  const vorDocs = (Array.isArray(vorDocOrDocs) ? vorDocOrDocs : [vorDocOrDocs]).filter(Boolean);
  if (!vorDocs.length) return { items: await loadVorItems(tenderId), imported: false };

  const counts = await db.queryAll(
    'SELECT document_id, COUNT(*) AS c FROM vor_items WHERE tender_id = ? GROUP BY document_id',
    tenderId,
  );
  const haveItems = new Set(counts.filter((r) => Number(r.c) > 0).map((r) => r.document_id || null));

  let imported = false;
  const errors = [];
  for (const doc of vorDocs) {
    if (haveItems.has(doc.id)) continue;
    // Legacy: позиции без document_id уже есть, и это единственный ВОР —
    // не плодим дубли поверх них.
    if (haveItems.has(null) && vorDocs.length === 1) continue;
    if (!isSpreadsheet(doc.name || doc.file_path, doc.mime_type)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await importVorFile(tenderId, { documentId: doc.id, filePath: doc.file_path });
      imported = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[vor] отложенный импорт ВОР не удался (${doc.id}): ${err.message}`);
      errors.push(err.message);
    }
  }
  const items = await loadVorItems(tenderId);
  const out = { items, imported };
  if (errors.length) out.error = errors.join('; ');
  return out;
}

async function deleteVorItems(tenderId) {
  const r = await db.queryRun('DELETE FROM vor_items WHERE tender_id = ?', tenderId);
  return r.changes || 0;
}

module.exports = {
  importVorFile,
  parseVorFile,
  loadVorItems,
  ensureVorItems,
  activeVorDocuments,
  deleteVorItems,
  unitSummary,
};
