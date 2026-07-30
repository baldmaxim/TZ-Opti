'use strict';

// Integration: РАУНДЫ импорта Q&A через Postgres + реальные .xlsx (SheetJS).
//
// Что защищаем:
//   • ИНВАРИАНТ: импорт Q&A НИКОГДА не трогает таблицу characteristics
//     (регресс: прежний импорт делал DELETE FROM characteristics);
//   • каждый импорт — отдельная строка qa_imports с номером раунда и датой;
//   • прежние вопросы и ответы НЕ удаляются: изменившийся ответ добавляется
//     новой active-записью, старая → superseded, связь supersedes_entry_id явная;
//   • разбираются все листы; при применении можно выбрать нужные;
//   • preview ничего не применяет; discard отменяет раунд;
//   • повторный импорт того же файла идемпотентен (unchanged, без дублей);
//   • разметка инженера (tz_clause, контуры) на неизменившихся записях живёт.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const qaImport = require('../../services/qaImportService');

const OPTS = dbTestOptions();
const TENDER_ID = 'qa-rounds-tender';

const nowIso = () => new Date().toISOString();
const HEADER = ['№', 'Дата', 'Дата получения ответа', 'Раздел', 'Вопрос', 'Ответ', 'Принятые решения'];

let tmpDir;

function writeXlsx(name, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }
  const p = path.join(tmpDir, name);
  XLSX.writeFile(wb, p);
  return p;
}

const qaSheet = (entries) => [HEADER, ...entries];

async function activeRows(db) {
  return db.queryAll(
    `SELECT * FROM qa_entries WHERE tender_id = ? AND COALESCE(status,'active')='active' ORDER BY order_idx`,
    TENDER_ID,
  );
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rounds-'));
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Раунды Q&A', 'draft', nowIso(),
  );
  // Характеристики, заполненные инженером ДО импорта, — их сохранность и есть инвариант.
  await db.queryRun(
    `INSERT INTO characteristics (id, tender_id, name, value, comment, sort_order)
     VALUES ('qa-char-1', ?, 'Класс бетона', 'B25', 'принято в расчёт', 1),
            ('qa-char-2', ?, 'Площадь кровли', '1200 м2', NULL, 2)`,
    TENDER_ID, TENDER_ID,
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ }
});

test('раунд 1: preview ничего не применяет, apply добавляет записи, характеристики целы', OPTS, async () => {
  const db = getDb();
  const file = writeXlsx('round1.xlsx', {
    'Лист1': qaSheet([
      ['1', '01.02', '05.02', 'Кровля', 'Чей материал?', 'Материал подрядчика', 'Учесть в КП'],
      ['2', '01.02', '05.02', 'Общие', 'Кто вывозит мусор?', 'Подрядчик', ''],
    ]),
    'Оглавление': [['Содержание'], ['стр. 1']], // непригодный лист — не роняет импорт
  });

  const preview = await qaImport.previewQaImport(TENDER_ID, file, { originalName: 'round1.xlsx' });
  assert.equal(preview.round_no, 1);
  assert.equal(preview.summary.new, 2);
  assert.equal(preview.summary.sheets_skipped, 1);
  assert.equal((await activeRows(db)).length, 0, 'preview не применяет записи');

  const result = await qaImport.applyQaImport(TENDER_ID, preview.import_id);
  assert.equal(result.new, 2);
  assert.deepEqual(result.applied_sheets, ['Лист1']);

  const rows = await activeRows(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.qa_import_id === preview.import_id), 'записи привязаны к раунду');

  const imp = (await qaImport.listQaImports(TENDER_ID))[0];
  assert.equal(imp.round_no, 1);
  assert.equal(imp.status, 'applied');
  assert.ok(imp.created_at && imp.applied_at, 'номер и даты раунда сохранены');

  // ИНВАРИАНТ: характеристики не тронуты.
  const chars = await db.queryAll('SELECT * FROM characteristics WHERE tender_id = ? ORDER BY sort_order', TENDER_ID);
  assert.equal(chars.length, 2);
  assert.equal(chars[0].value, 'B25');
});

test('раунд 2: изменившийся ответ → supersede с явной связью, разметка неизменившихся живёт', OPTS, async () => {
  const db = getDb();
  // Инженер разметил запись раунда 1.
  const before1 = await activeRows(db);
  const marked = before1.find((r) => r.question === 'Кто вывозит мусор?');
  await db.queryRun(
    `UPDATE qa_entries SET tz_clause = 'п. 4.2', affects_kp = 1 WHERE id = ?`, marked.id,
  );

  const file = writeXlsx('round2.xlsx', {
    'Лист1': qaSheet([
      ['1', '10.02', '15.02', 'Кровля', 'Чей материал?', 'Материал заказчика (уточнение)', ''],
      ['2', '', '', 'Общие', 'Кто вывозит мусор?', 'Подрядчик', ''],
      ['3', '10.02', '15.02', 'Сроки', 'Возможен ли сдвиг графика?', 'Нет', ''],
    ]),
  });

  const preview = await qaImport.previewQaImport(TENDER_ID, file, { originalName: 'round2.xlsx' });
  assert.equal(preview.round_no, 2);
  assert.deepEqual(
    { n: preview.summary.new, c: preview.summary.answer_changed, u: preview.summary.unchanged },
    { n: 1, c: 1, u: 1 },
  );

  const result = await qaImport.applyQaImport(TENDER_ID, preview.import_id);
  assert.equal(result.answer_changed, 1);

  const all = await db.queryAll('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx', TENDER_ID);
  assert.equal(all.length, 4, 'прежние записи не удалены: 2 старых + 2 новых');

  const superseded = all.find((r) => r.status === 'superseded');
  assert.equal(superseded.answer, 'Материал подрядчика', 'старый ответ сохранён со статусом superseded');
  const replacement = all.find((r) => r.supersedes_entry_id === superseded.id);
  assert.ok(replacement, 'новый ответ ЯВНО ссылается на отменяемый');
  assert.equal(replacement.answer, 'Материал заказчика (уточнение)');
  assert.equal(replacement.status, 'active');

  const keptMark = all.find((r) => r.id === marked.id);
  assert.equal(keptMark.status, 'active');
  assert.equal(keptMark.tz_clause, 'п. 4.2', 'разметка неизменившейся записи не потеряна');
  assert.equal(Number(keptMark.affects_kp), 1);

  // Характеристики по-прежнему целы после второго импорта.
  const chars = await db.queryAll('SELECT COUNT(*) AS c FROM characteristics WHERE tender_id = ?', TENDER_ID);
  assert.equal(Number(chars[0].c), 2);
});

test('повторный импорт того же файла идемпотентен; discard отменяет раунд', OPTS, async () => {
  const db = getDb();
  const file = writeXlsx('round2-again.xlsx', {
    'Лист1': qaSheet([
      ['1', '', '', 'Кровля', 'Чей материал?', 'Материал заказчика (уточнение)', ''],
      ['2', '', '', 'Общие', 'Кто вывозит мусор?', 'Подрядчик', ''],
      ['3', '', '', 'Сроки', 'Возможен ли сдвиг графика?', 'Нет', ''],
    ]),
  });

  // Одношаговый путь (загрузка документа в слот qa): все пары уже есть → 0 вставок.
  const result = await qaImport.importQaXlsx(TENDER_ID, file);
  assert.equal(result.qa_count, 0, 'дубли не вставляются');
  assert.equal(result.unchanged, 3);
  assert.equal(result.round_no, 3);

  // Раунд с discard: pending-строка остаётся в истории, записи не меняются.
  const countBefore = await db.queryOne('SELECT COUNT(*) AS c FROM qa_entries WHERE tender_id = ?', TENDER_ID);
  const preview = await qaImport.previewQaImport(TENDER_ID, file);
  await qaImport.discardQaImport(TENDER_ID, preview.import_id);
  const countAfter = await db.queryOne('SELECT COUNT(*) AS c FROM qa_entries WHERE tender_id = ?', TENDER_ID);
  assert.equal(Number(countAfter.c), Number(countBefore.c));
  await assert.rejects(
    () => qaImport.applyQaImport(TENDER_ID, preview.import_id),
    /отменён/,
    'отменённый раунд применить нельзя',
  );

  const imports = await qaImport.listQaImports(TENDER_ID);
  assert.deepEqual(
    imports.map((i) => [i.round_no, i.status]),
    [[4, 'discarded'], [3, 'applied'], [2, 'applied'], [1, 'applied']],
    'история раундов полная: номер + статус',
  );
});

test('выбор листов: применяются только указанные', OPTS, async () => {
  const db = getDb();
  const file = writeXlsx('two-sheets.xlsx', {
    'Раунд А': qaSheet([['1', '', '', 'Общие', 'Вопрос только с листа А?', 'Ответ А', '']]),
    'Раунд Б': qaSheet([['1', '', '', 'Общие', 'Вопрос только с листа Б?', 'Ответ Б', '']]),
  });
  const preview = await qaImport.previewQaImport(TENDER_ID, file);
  const result = await qaImport.applyQaImport(TENDER_ID, preview.import_id, { sheetNames: ['Раунд Б'] });
  assert.deepEqual(result.applied_sheets, ['Раунд Б']);

  const rows = await activeRows(db);
  assert.ok(rows.some((r) => r.question === 'Вопрос только с листа Б?'));
  assert.ok(!rows.some((r) => r.question === 'Вопрос только с листа А?'), 'невыбранный лист не применён');
});
