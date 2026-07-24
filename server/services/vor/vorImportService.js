'use strict';

// Импорт ВОР в БД: файл xls/xlsx → позиции (vor_items) + отчёт разбора.
//
// Одна позиция ведомости = одна строка таблицы со всеми координатами (лист,
// строка Excel, адреса ячеек). Импорт ИДЕМПОТЕНТЕН: позиции тендера заменяются
// целиком в одной транзакции.

const fs = require('fs');
const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const { parseGrids } = require('./vorParser');
const { isSpreadsheet, readGridsFromFile } = require('./vorReader');

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
    await tx.queryRun('DELETE FROM vor_items WHERE tender_id = ?', tenderId);
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

async function loadVorItems(tenderId) {
  const rows = await db.queryAll(
    'SELECT * FROM vor_items WHERE tender_id = ? ORDER BY order_idx ASC',
    tenderId,
  );
  return rows.map(mapRow);
}

// Ленивая самопочинка: позиций нет, а документ ВОР — таблица на диске →
// импортируем прямо сейчас. Нужно для ВОР, загруженных до появления
// структурного импорта: инженеру не приходится перезаливать файл.
// Ошибка импорта НЕ роняет анализ — стадия 1 продолжит на текстовом фолбэке.
async function ensureVorItems(tenderId, vorDoc) {
  const items = await loadVorItems(tenderId);
  if (items.length || !vorDoc) return { items, imported: false };
  if (!isSpreadsheet(vorDoc.name || vorDoc.file_path, vorDoc.mime_type)) {
    return { items, imported: false };
  }
  try {
    await importVorFile(tenderId, { documentId: vorDoc.id, filePath: vorDoc.file_path });
    return { items: await loadVorItems(tenderId), imported: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[vor] отложенный импорт ВОР не удался (${vorDoc.id}): ${err.message}`);
    return { items, imported: false, error: err.message };
  }
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
  deleteVorItems,
  unitSummary,
};
