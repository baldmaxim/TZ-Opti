'use strict';

// Integration: структурный импорт ВОР (vor_items) на живом PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем то, ради чего заведена таблица:
//   • позиция сохраняется со ВСЕМИ координатами (лист, строка, адреса ячеек);
//   • количество лежит числом, единица — нормализованной, исходники сохранены;
//   • повторный импорт идемпотентен (замена, а не дубли);
//   • ensureVorItems сам импортирует ВОР, загруженный до появления импорта.

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { makeTmpDir } = require('../helpers/tmpDir');
const {
  importVorFile,
  loadVorItems,
  ensureVorItems,
  deleteVorItems,
} = require('../../services/vor/vorImportService');

const OPTS = dbTestOptions();
const TENDER_ID = 'vor-int-tender';
const DOC_ID = 'vor-int-doc';

const ROWS = [
  ['Ведомость объёмов работ'],
  ['№ п/п', 'Шифр', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Примечание'],
  ['', '', 'Раздел 1. Монолитные работы', '', '', ''],
  [1, 'ГЭСН 06-01-001', 'Бетонирование стен', 'куб.м', '1 250,5', 'B25'],
  [2, '', '', 'куб.м', 320, 'B30'],
  ['', '', '', '', '', ''],
  [3, '', 'Армирование каркасов', 'тн', '12,75', ''],
  ['', '', 'Итого по разделу', '', 1583.25, ''],
];

function writeVorXlsx(dir) {
  const sheet = XLSX.utils.aoa_to_sheet(ROWS);
  sheet['!merges'] = [{ s: { r: 3, c: 2 }, e: { r: 4, c: 2 } }]; // наименование на две строки
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'ВОР');
  const fp = `${dir}/vor.xlsx`;
  XLSX.writeFile(wb, fp);
  return fp;
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'ВОР: integration-тест', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

test('импорт ВОР: позиции, координаты, нормализованные единицы и количества', OPTS, async (t) => {
  const dir = makeTmpDir(t);
  const filePath = writeVorXlsx(dir);
  const db = getDb();
  await db.queryRun('DELETE FROM documents WHERE id = ?', DOC_ID);
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, uploaded_at, processing_status)
     VALUES (?, ?, 'vor', 'vor.xlsx', ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?, 'extracted')`,
    DOC_ID, TENDER_ID, filePath, new Date().toISOString(),
  );

  const report = await importVorFile(TENDER_ID, { documentId: DOC_ID, filePath });
  assert.equal(report.stats.items, 3);
  assert.equal(report.stats.sheets_parsed, 1);

  const items = await loadVorItems(TENDER_ID);
  assert.equal(items.length, 3);

  const beton = items.filter((i) => i.name === 'Бетонирование стен');
  assert.equal(beton.length, 2, 'объединённая ячейка наименования дала две позиции');
  assert.deepEqual(beton.map((i) => i.quantity), [1250.5, 320]);
  assert.equal(typeof beton[0].quantity, 'number', 'количество хранится числом, а не текстом');
  assert.equal(beton[0].quantity_raw, '1 250,5', 'исходная запись количества сохранена');
  assert.equal(beton[0].unit, 'м3', 'единица нормализована');
  assert.equal(beton[0].unit_raw, 'куб.м');
  assert.equal(beton[0].unit_known, true);
  assert.equal(beton[0].code, 'ГЭСН 06-01-001');
  assert.equal(beton[0].section, 'Раздел 1. Монолитные работы');
  assert.equal(beton[0].sheet_name, 'ВОР');
  assert.equal(beton[0].row_index, 4);
  assert.equal(beton[0].cells.name, 'C4', 'адрес ячейки наименования пережил запись в БД');
  assert.equal(beton[0].cells.quantity, 'E4');
  assert.equal(beton[1].merged_cells.name, 'C4', 'источник объединённой ячейки сохранён');
  assert.deepEqual(items.map((i) => i.order_idx), [0, 1, 2]);
  assert.equal(items.some((i) => /Итого/i.test(i.name)), false, 'итоговая строка не позиция');

  const arm = items.find((i) => i.name === 'Армирование каркасов');
  assert.equal(arm.quantity, 12.75);
  assert.equal(arm.unit, 'т');

  // Отчёт разбора сохранён рядом с документом.
  const doc = await db.queryOne('SELECT import_report FROM documents WHERE id = ?', DOC_ID);
  const saved = JSON.parse(doc.import_report);
  assert.equal(saved.stats.items, 3);
  assert.ok(Array.isArray(saved.units) && saved.units.length, 'сводка по единицам сохранена');
});

test('повторный импорт идемпотентен: замена позиций, а не дубли', OPTS, async (t) => {
  const dir = makeTmpDir(t);
  const filePath = writeVorXlsx(dir);
  await importVorFile(TENDER_ID, { documentId: DOC_ID, filePath });
  await importVorFile(TENDER_ID, { documentId: DOC_ID, filePath });
  const items = await loadVorItems(TENDER_ID);
  assert.equal(items.length, 3, 'после двух импортов позиций столько же');
});

test('ensureVorItems сам импортирует ВОР, загруженный до появления структурного импорта', OPTS, async (t) => {
  const dir = makeTmpDir(t);
  const filePath = writeVorXlsx(dir);
  const db = getDb();
  await db.queryRun(
    'UPDATE documents SET file_path = ? WHERE id = ?', filePath, DOC_ID,
  );
  await deleteVorItems(TENDER_ID); // как будто импорта никогда не было
  assert.equal((await loadVorItems(TENDER_ID)).length, 0);

  const doc = await db.queryOne('SELECT * FROM documents WHERE id = ?', DOC_ID);
  const res = await ensureVorItems(TENDER_ID, doc);
  assert.equal(res.imported, true);
  assert.equal(res.items.length, 3);

  // Второй вызов уже ничего не импортирует — позиции на месте.
  const again = await ensureVorItems(TENDER_ID, doc);
  assert.equal(again.imported, false);
  assert.equal(again.items.length, 3);
});

test('битый/непонятный файл ВОР не роняет анализ: ensureVorItems возвращает пусто с причиной', OPTS, async (t) => {
  const dir = makeTmpDir(t);
  const sheet = XLSX.utils.aoa_to_sheet([['Объект', 'Жилой дом'], ['Договор', '№ 12/24']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Титул');
  const fp = `${dir}/broken.xlsx`;
  XLSX.writeFile(wb, fp);

  await deleteVorItems(TENDER_ID);
  const res = await ensureVorItems(TENDER_ID, {
    id: DOC_ID, name: 'broken.xlsx', file_path: fp, mime_type: null,
  });
  assert.equal(res.imported, false);
  assert.equal(res.items.length, 0);
  assert.match(res.error, /не распознано ни одной позиции/);
});
