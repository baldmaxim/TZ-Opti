'use strict';

// Проверка самих test helpers: временные каталоги, DOCX-фикстуры, fake LLM,
// контролируемые часы/ID, блокировка сети. Если ломается helper — должен
// падать этот тест, а не десяток чужих.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');

const { makeTmpDir, writeTmpFile, removeTmpDir } = require('../helpers/tmpDir');
const { writeTmpDocx, simpleDocx, para, decision } = require('../helpers/docxFixtures');
const { installFakeLlm } = require('../helpers/fakeLlm');
const { makeClock, makeIdFactory, installFakeClock } = require('../helpers/clock');
const { blockNetwork } = require('../helpers/network');
const { DocxPackage } = require('../../services/reviewDocx/docxPackage');
const { exportReviewedDocx } = require('../../services/reviewDocx');
const { chatJson } = require('../../services/stageAnalysis/llm/openaiClient');

// --- tmpDir -------------------------------------------------------------------

test('makeTmpDir создаёт каталог и убирает его после теста', () => {
  const dir = makeTmpDir();
  assert.ok(fs.existsSync(dir));
  const fp = writeTmpFile(dir, 'a/b.txt', 'x');
  assert.equal(fs.readFileSync(fp, 'utf8'), 'x');
  removeTmpDir(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('removeTmpDir не трогает пути вне tz-opti-test-', () => {
  const dir = makeTmpDir();
  removeTmpDir(process.cwd()); // no-op
  assert.ok(fs.existsSync(process.cwd()));
  removeTmpDir(dir);
});

// --- DOCX-фикстуры ------------------------------------------------------------

test('simpleDocx даёт открываемый .docx, экспорт применяет решение', (t) => {
  const fp = simpleDocx('Подрядчик выполняет демонтажные работы своими силами.', { t });
  assert.ok(fs.existsSync(fp));
  assert.ok(DocxPackage.fromFile(fp).getDocumentXml());

  const { report } = exportReviewedDocx(
    fp,
    [decision({ fragment: 'демонтажные работы', kind: 'delete', extra: { paragraph_index: 0 } })],
    { author: 'Tester', date: new Date('2026-01-01T00:00:00Z') },
  );
  assert.equal(report.summary.applied, 1);
});

test('writeTmpDocx собирает многочастный документ', (t) => {
  const fp = writeTmpDocx([para('Первый абзац.'), para('Второй абзац.')], { t });
  const xml = DocxPackage.fromFile(fp).getDocumentXml().toString();
  assert.ok(xml.includes('Первый абзац.'));
  assert.ok(xml.includes('Второй абзац.'));
});

// --- fake LLM -----------------------------------------------------------------

test('installFakeLlm перехватывает chatJson и записывает вызовы', async (t) => {
  const llm = installFakeLlm(t, [{ findings: [{ fragment: 'x' }] }]);
  const out = await chatJson({ system: 'sys', user: 'usr', jsonSchema: {}, schemaName: 's' });
  assert.deepEqual(out, { findings: [{ fragment: 'x' }] });
  assert.equal(llm.callCount, 1);
  assert.equal(llm.calls[0].user, 'usr');
});

test('fake LLM умеет отдавать ошибку (fail-loud путь стадии)', async (t) => {
  installFakeLlm(t, [new Error('LLM упал')]);
  await assert.rejects(() => chatJson({ system: 's', user: 'u', jsonSchema: {} }), /LLM упал/);
});

test('лишний вызов LLM без запланированного ответа — падение, а не тишина', async (t) => {
  installFakeLlm(t, []);
  await assert.rejects(() => chatJson({ system: 's', user: 'u', jsonSchema: {} }), /незапланированный вызов/);
});

test('без fake-провайдера реальный LLM в тестовом процессе запрещён', async () => {
  await assert.rejects(() => chatJson({ system: 's', user: 'u', jsonSchema: {} }), (err) => {
    assert.equal(err.code, 'LLM_CALL_IN_TEST_PROCESS');
    return true;
  });
});

// --- часы и ID ----------------------------------------------------------------

test('makeClock/makeIdFactory детерминированы', () => {
  const clock = makeClock(Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(clock.iso(), '2026-01-01T00:00:00.000Z');
  clock.tick(60_000);
  assert.equal(clock.iso(), '2026-01-01T00:01:00.000Z');

  const nextId = makeIdFactory('clu');
  assert.equal(nextId(), 'clu-0001');
  assert.equal(nextId(), 'clu-0002');
});

test('installFakeClock замораживает Date.now() и восстанавливает его', (t) => {
  const before = Date.now();
  const { clock, restore } = installFakeClock(t, Date.parse('2026-02-02T10:00:00.000Z'));
  assert.equal(Date.now(), Date.parse('2026-02-02T10:00:00.000Z'));
  assert.equal(new Date().toISOString(), '2026-02-02T10:00:00.000Z');
  clock.tick(5000);
  assert.equal(new Date().toISOString(), '2026-02-02T10:00:05.000Z');
  restore();
  assert.ok(Date.now() >= before);
});

// --- сеть ---------------------------------------------------------------------

test('blockNetwork ловит исходящее соединение и восстанавливается', (t) => {
  const guard = blockNetwork(t);
  assert.throws(() => new net.Socket().connect(5432, 'db.example.com'), /Сеть запрещена/);
  assert.deepEqual(guard.attempts, ['db.example.com:5432']);
  guard.restore();
});
