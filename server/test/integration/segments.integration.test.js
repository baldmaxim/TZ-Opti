'use strict';

// Integration: хранилище частей ТЗ (analysis_segments) на живой PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем ровно то, ради чего таблица заведена:
//   • план нарезки пишется upsert-ом (повторный прогон не плодит строки);
//   • посчитанная часть ПЕРЕИСПОЛЬЗУЕТСЯ, пока не изменился вход (input_hash);
//   • изменившийся вход сбрасывает часть в pending (кэш прошлой ревизии не течёт);
//   • упавшая часть хранит ошибку и попытки;
//   • retry гасит результат ОДНОЙ части, не трогая соседние.

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const store = require('../../services/stageAnalysis/segments/segmentStore');

const OPTS = dbTestOptions();
const TENDER_ID = 'seg-int-tender';
const STAGE = 1;

function seg(index, hash, extra = {}) {
  return {
    index,
    key: `seg_key_${index}`,
    headingPath: [`${index + 1}. Раздел`, `${index + 1}.1 Подраздел`],
    firstBlockIndex: index * 10,
    lastBlockIndex: index * 10 + 9,
    chars: 5000 + index,
    tokens: 1800 + index,
    inputHash: hash,
    ...extra,
  };
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Сегментация: integration-тест', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

test('план нарезки: upsert, а не дубли строк; лишние части прошлой нарезки удаляются', OPTS, async () => {
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_1',
    segments: [seg(0, 'h0'), seg(1, 'h1'), seg(2, 'h2')],
  });
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_1',
    segments: [seg(0, 'h0'), seg(1, 'h1'), seg(2, 'h2')],
  });

  let rows = await store.listSegments(TENDER_ID, STAGE);
  assert.equal(rows.length, 3, 'повторный план не должен плодить строки');
  assert.deepEqual(rows.map((r) => r.segment_index), [0, 1, 2]);
  assert.equal(rows[0].heading_path, '1. Раздел › 1.1 Подраздел');
  assert.equal(rows[0].status, store.STATUS.PENDING);

  // Более короткая нарезка (ТЗ ужалось) — хвост прошлой нарезки не остаётся.
  await store.planSegments(TENDER_ID, STAGE, { revisionId: 'rev_1', segments: [seg(0, 'h0'), seg(1, 'h1')] });
  rows = await store.listSegments(TENDER_ID, STAGE);
  assert.equal(rows.length, 2, 'части, которых больше нет в нарезке, должны удаляться');
});

test('результат части переиспользуется, пока не изменился вход', OPTS, async () => {
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_1',
    segments: [seg(0, 'h0'), seg(1, 'h1')],
  });
  await store.markRunning(TENDER_ID, STAGE, 0);
  await store.saveSuccess(TENDER_ID, STAGE, 0, { findings: [{ fragment: 'цитата ТЗ' }] });

  const cached = await store.getCompleted(TENDER_ID, STAGE, 0, 'h0');
  assert.deepEqual(cached, [{ fragment: 'цитата ТЗ' }]);
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 0, 'ДРУГОЙ'), null, 'чужой input_hash — не кэш');
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 1, 'h1'), null, 'непосчитанная часть кэша не даёт');

  // Повторный план с ТЕМ ЖЕ входом бережёт результат…
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_1',
    segments: [seg(0, 'h0'), seg(1, 'h1')],
  });
  assert.deepEqual(await store.getCompleted(TENDER_ID, STAGE, 0, 'h0'), [{ fragment: 'цитата ТЗ' }]);

  // …а изменившийся вход (новая ревизия ТЗ / другой справочник) — сбрасывает.
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_2',
    segments: [seg(0, 'h0-new'), seg(1, 'h1')],
  });
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 0, 'h0-new'), null);
  const after0 = await store.getSegment(TENDER_ID, STAGE, 0);
  assert.equal(after0.status, store.STATUS.PENDING);
  assert.equal(after0.findings_json, null, 'результат прошлой ревизии не должен протечь');
});

test('упавшая часть хранит ошибку и попытки; retry гасит только её', OPTS, async () => {
  await store.planSegments(TENDER_ID, STAGE, {
    revisionId: 'rev_3',
    segments: [seg(0, 'a'), seg(1, 'b'), seg(2, 'c')],
  });
  for (const i of [0, 1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    await store.markRunning(TENDER_ID, STAGE, i);
  }
  await store.saveSuccess(TENDER_ID, STAGE, 0, { findings: [{ fragment: 'A' }] });
  await store.saveFailure(TENDER_ID, STAGE, 1, new Error('часть 2/3 — таймаут модели'));
  await store.saveSuccess(TENDER_ID, STAGE, 2, { findings: [{ fragment: 'C' }, { fragment: 'C2' }] });

  const rows = await store.listSegments(TENDER_ID, STAGE);
  const failed = rows.find((r) => r.segment_index === 1);
  assert.equal(failed.status, store.STATUS.FAILED);
  assert.match(failed.error, /таймаут модели/);
  assert.equal(Number(failed.attempts), 1);

  const summary = store.summarize(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.findings, 3, 'сводка считает находки по всем посчитанным частям');

  // Точечный перезапуск: гаснет ТОЛЬКО часть №2 (index=1) — соседние остаются
  // в кэше, поэтому повтор стадии переспросит модель об одной части из трёх.
  const changed = await store.requestRetry(TENDER_ID, STAGE, 1);
  assert.equal(changed, 1);
  const retried = await store.getSegment(TENDER_ID, STAGE, 1);
  assert.equal(retried.status, store.STATUS.PENDING);
  assert.equal(retried.error, null);
  assert.deepEqual(await store.getCompleted(TENDER_ID, STAGE, 0, 'a'), [{ fragment: 'A' }]);
  assert.equal((await store.getCompleted(TENDER_ID, STAGE, 2, 'c')).length, 2);
});

test('части разных стадий одного тендера не пересекаются', OPTS, async () => {
  await store.planSegments(TENDER_ID, 4, { revisionId: 'rev_3', segments: [seg(0, 'z')] });
  await store.saveSuccess(TENDER_ID, 4, 0, { findings: [{ fragment: 'риск' }] });

  assert.equal((await store.listSegments(TENDER_ID, 4)).length, 1);
  assert.equal((await store.listSegments(TENDER_ID, STAGE)).length, 3, 'стадия 4 не должна трогать части стадии 1');
  assert.deepEqual(await store.getCompleted(TENDER_ID, 4, 0, 'z'), [{ fragment: 'риск' }]);
});
