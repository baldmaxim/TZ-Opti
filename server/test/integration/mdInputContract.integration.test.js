'use strict';

// Integration: АРХИТЕКТУРНЫЙ ИНВАРИАНТ входа анализа — ТЗ анализируется ТОЛЬКО по
// отдельно загруженной Markdown-копии (doc_type='tz', имя *.md). .docx в том же
// слоте используется ИСКЛЮЧИТЕЛЬНО для финального экспорта с правками, а НЕ как
// источник семантического анализа.
//
// Этот сценарий (загрузка .md отдельно от .docx) НЕ должен быть заменён
// автоизвлечением текста из .docx: задача 4 осознанно не реализована. Тест —
// СТРАЖ: если кто-то заставит анализ читать .docx (или сделает .md
// необязательным), проверки ниже упадут.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const tz = require('../../services/tzActiveTextService');

const OPTS = dbTestOptions();
const TENDER_ID = 'md-contract-tender';

async function addDoc(db, { id, name, text }) {
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', ?, ?, ?, ?, 'extracted')`,
    id, TENDER_ID, name, `/tmp/${name}`, new Date().toISOString(), text,
  );
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Контракт Markdown-входа', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

test('только .docx в слоте ТЗ → анализ не имеет входа (missingMd), .docx НЕ читается как ТЗ', OPTS, async () => {
  const db = getDb();
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await addDoc(db, {
    id: 'md-contract-docx',
    name: 'ТЗ.docx',
    text: 'Извлечённый из .docx текст — для семантического анализа НЕ используется.',
  });

  const active = await tz.getTzText(TENDER_ID);
  assert.equal(active.missingMd, true, 'при отсутствии .md анализ обязан сообщить об отсутствии входа');
  assert.equal(active.document, null, '.docx НЕ должен подставляться как источник анализа');
  assert.equal(active.activeText, '', 'активного текста ТЗ нет — анализ по .docx не ведётся');
});

test('.md в слоте ТЗ → он и есть источник анализа (missingMd=false)', OPTS, async () => {
  const db = getDb();
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await addDoc(db, {
    id: 'md-contract-md',
    name: 'ТЗ.md',
    text: '# 1. Объём работ\n\nПодрядчик выполняет монтаж по проекту.',
  });

  const active = await tz.getTzText(TENDER_ID);
  assert.equal(active.missingMd, false);
  assert.ok(active.document, 'должен быть найден документ ТЗ');
  assert.match(active.document.name, /\.md$/i, 'источник анализа — именно .md-копия');
  assert.ok(active.activeText.includes('Объём работ'), 'анализируется содержимое .md');
});

test('и .md, и .docx вместе → источник анализа = .md (docx только для экспорта)', OPTS, async () => {
  const db = getDb();
  await db.queryRun('DELETE FROM documents WHERE tender_id = ?', TENDER_ID);
  await addDoc(db, { id: 'md-both-docx', name: 'ТЗ.docx', text: 'DOCX-текст (для экспорта).' });
  await addDoc(db, { id: 'md-both-md', name: 'ТЗ.md', text: '# Раздел\n\nMD-текст (для анализа).' });

  const active = await tz.getTzText(TENDER_ID);
  assert.equal(active.missingMd, false);
  assert.match(active.document.name, /\.md$/i, 'при наличии обоих форматов анализ берёт .md, а не .docx');
  assert.ok(active.activeText.includes('MD-текст'));
  assert.ok(!active.activeText.includes('DOCX-текст'), 'текст .docx в активный текст анализа не попадает');
});
