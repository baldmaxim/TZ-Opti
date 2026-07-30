'use strict';

// Integration: хранилище частей ТЗ на живой PostgreSQL — ДВЕ таблицы с разной
// природой (см. services/stageAnalysis/segments/segmentStore.js):
//   analysis_segments     — КЭШ результата, скоупленный ревизией документов;
//   analysis_run_segments — НЕИЗМЕНЯЕМАЯ история выполнения части в прогоне.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем ровно то, ради чего таблицы заведены:
//   • план нарезки пишется upsert-ом (повторный прогон не плодит строки);
//   • посчитанная часть ПЕРЕИСПОЛЬЗУЕТСЯ, пока не изменился вход (input_hash);
//   • изменившийся вход обесценивает кэш (результат прошлой ревизии не течёт);
//   • упавшая часть хранит ошибку и попытки В СВОЁМ ПРОГОНЕ;
//   • retry гасит кэш ОДНОЙ части, не трогая соседние и не трогая историю;
//   • история прогона неизменяема: следующий прогон пишет свои строки.
// Сценарии жизненного цикла целиком — stageRunLifecycle.integration.test.js.

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const store = require('../../services/stageAnalysis/segments/segmentStore');

const OPTS = dbTestOptions();
const TENDER_ID = 'seg-int-tender';
const STAGE = 1;
const REV = 'rev_1';
const CFG = 'cfg_test';

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

// Прогон-владелец истории частей: строки analysis_run_segments ссылаются на него.
async function makeRun(id, startedAt = new Date().toISOString()) {
  await getDb().queryRun(
    `INSERT INTO analysis_runs (id, tender_id, stage, kind, documents_revision_id, config_version, started_at, status)
     VALUES (?, ?, ?, 'stage', ?, ?, ?, 'running')
     ON CONFLICT (id) DO NOTHING`,
    id, TENDER_ID, STAGE, REV, CFG, startedAt,
  );
  return id;
}

const cacheScope = { revisionId: REV, configVersion: CFG };

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
  const runId = await makeRun('seg-run-plan');
  const segments = [seg(0, 'h0'), seg(1, 'h1'), seg(2, 'h2')];
  for (const _ of [1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments });
    // eslint-disable-next-line no-await-in-loop
    await store.planRunSegments(runId, TENDER_ID, STAGE, { ...cacheScope, segments });
  }

  let rows = await store.listRunSegments(TENDER_ID, STAGE, runId);
  assert.equal(rows.length, 3, 'повторный план не должен плодить строки');
  assert.deepEqual(rows.map((r) => r.segment_index), [0, 1, 2]);
  assert.equal(rows[0].heading_path, '1. Раздел › 1.1 Подраздел');
  assert.equal(rows[0].status, store.STATUS.PENDING);

  // Более короткая нарезка (ТЗ ужалось) — хвост прошлой нарезки не остаётся в кэше.
  await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments: [seg(0, 'h0'), seg(1, 'h1')] });
  rows = await getDb().queryAll(
    'SELECT * FROM analysis_segments WHERE tender_id = ? AND analysis_stage = ? AND document_revision_id = ?',
    TENDER_ID, STAGE, REV,
  );
  assert.equal(rows.length, 2, 'части, которых больше нет в нарезке, должны удаляться из кэша');
});

test('результат части переиспользуется, пока не изменился вход', OPTS, async () => {
  const runId = await makeRun('seg-run-cache');
  const segments = [seg(0, 'h0'), seg(1, 'h1')];
  await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments });
  await store.planRunSegments(runId, TENDER_ID, STAGE, { ...cacheScope, segments });
  await store.markRunSegmentRunning(runId, 0);
  await store.saveCache(TENDER_ID, STAGE, 0, { findings: [{ fragment: 'цитата ТЗ' }], ...cacheScope, runId });
  await store.markRunSegmentDone(runId, 0, { count: 1, source: store.SOURCE.LLM });

  const cached = await store.getCompleted(TENDER_ID, STAGE, 0, 'h0', cacheScope);
  assert.deepEqual(cached, [{ fragment: 'цитата ТЗ' }]);
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 0, 'ДРУГОЙ', cacheScope), null, 'чужой input_hash — не кэш');
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 1, 'h1', cacheScope), null, 'непосчитанная часть кэша не даёт');

  // Повторный план с ТЕМ ЖЕ входом бережёт результат…
  await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments });
  assert.deepEqual(await store.getCompleted(TENDER_ID, STAGE, 0, 'h0', cacheScope), [{ fragment: 'цитата ТЗ' }]);

  // …а изменившийся вход (другой справочник в той же ревизии) — обесценивает.
  await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments: [seg(0, 'h0-new'), seg(1, 'h1')] });
  assert.equal(await store.getCompleted(TENDER_ID, STAGE, 0, 'h0-new', cacheScope), null);
  const after0 = await store.getCacheSegment(TENDER_ID, STAGE, 0);
  assert.equal(after0.status, 'pending');
  assert.equal(after0.findings_json, null, 'результат прошлого входа не должен протечь');
});

test('упавшая часть хранит ошибку и попытки; retry гасит кэш только её', OPTS, async () => {
  const runId = await makeRun('seg-run-fail');
  const segments = [seg(0, 'a'), seg(1, 'b'), seg(2, 'c')];
  await store.planCache(TENDER_ID, STAGE, { ...cacheScope, segments });
  await store.planRunSegments(runId, TENDER_ID, STAGE, { ...cacheScope, segments });
  for (const i of [0, 1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    await store.markRunSegmentRunning(runId, i);
  }
  await store.saveCache(TENDER_ID, STAGE, 0, { findings: [{ fragment: 'A' }], ...cacheScope, runId });
  await store.markRunSegmentDone(runId, 0, { count: 1 });
  await store.markRunSegmentFailed(runId, 1, new Error('часть 2/3 — таймаут модели'));
  await store.saveCache(TENDER_ID, STAGE, 2, { findings: [{ fragment: 'C' }, { fragment: 'C2' }], ...cacheScope, runId });
  await store.markRunSegmentDone(runId, 2, { count: 2 });

  const rows = await store.listRunSegments(TENDER_ID, STAGE, runId);
  const failed = rows.find((r) => r.segment_index === 1);
  assert.equal(failed.status, store.STATUS.FAILED);
  assert.match(failed.error, /таймаут модели/);
  assert.equal(Number(failed.attempts), 1);

  const summary = store.summarize(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.findings, 3, 'сводка считает находки по всем посчитанным частям');

  // Точечный перезапуск: гаснет ТОЛЬКО кэш части №2 (index=1) — соседние
  // остаются, поэтому следующий прогон переспросит модель об одной части из трёх.
  const changed = await store.invalidateCache(TENDER_ID, STAGE, 1);
  assert.equal(changed, 1);
  assert.deepEqual(await store.getCompleted(TENDER_ID, STAGE, 0, 'a', cacheScope), [{ fragment: 'A' }]);
  assert.equal((await store.getCompleted(TENDER_ID, STAGE, 2, 'c', cacheScope)).length, 2);
  // История прогона от retry НЕ меняется: он гасит кэш, а не переписывает прошлое.
  const afterRetry = await store.listRunSegments(TENDER_ID, STAGE, runId);
  assert.equal(afterRetry.find((r) => r.segment_index === 1).status, store.STATUS.FAILED);
});

test('история прогона неизменяема: следующий прогон пишет СВОИ строки', OPTS, async () => {
  const first = 'seg-run-fail'; // прогон из предыдущего теста: часть 2 упала
  const second = await makeRun('seg-run-next', new Date(Date.now() + 1000).toISOString());
  const segments = [seg(0, 'a'), seg(1, 'b2'), seg(2, 'c')];
  await store.planRunSegments(second, TENDER_ID, STAGE, { ...cacheScope, segments });
  for (const i of [0, 1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    await store.markRunSegmentDone(second, i, { count: 1, source: i === 1 ? 'llm' : 'cache' });
  }

  const old = await store.listRunSegments(TENDER_ID, STAGE, first);
  assert.equal(old.find((r) => r.segment_index === 1).status, store.STATUS.FAILED,
    'сбой прошлого прогона обязан остаться видимым после нового прогона');
  const fresh = await store.listRunSegments(TENDER_ID, STAGE, second);
  assert.ok(fresh.every((r) => r.status === store.STATUS.COMPLETED));
  assert.equal(store.summarize(fresh).computed, 1, 'моделью считалась одна часть, остальные — из кэша');

  // Без runId отдаётся ПОСЛЕДНИЙ прогон.
  const latest = await store.listRunSegments(TENDER_ID, STAGE);
  assert.ok(latest.every((r) => r.analysis_run_id === second));

  const runs = await store.listSegmentRuns(TENDER_ID, STAGE);
  assert.ok(runs.length >= 2, 'история прогонов доступна списком');
  assert.equal(runs[0].id, second);
});

test('финализация прогона закрывает незавершённые части (interrupted / skipped)', OPTS, async () => {
  const runId = await makeRun('seg-run-finalize');
  await store.planRunSegments(runId, TENDER_ID, STAGE, {
    ...cacheScope, segments: [seg(0, 'x'), seg(1, 'y'), seg(2, 'z')],
  });
  await store.markRunSegmentDone(runId, 0, { count: 0 });
  await store.markRunSegmentRunning(runId, 1);

  const res = await store.finalizeRunSegments(runId, { reason: 'воркер потерян' });
  assert.equal(res.interrupted, 1);
  assert.equal(res.skipped, 1);
  const rows = await store.listRunSegments(TENDER_ID, STAGE, runId);
  assert.deepEqual(rows.map((r) => r.status), ['completed', 'interrupted', 'skipped']);
  assert.match(rows[1].error, /воркер потерян/);
});

test('КРОСС-РЕВИЗИЯ: часть с тем же input_hash поднимается из кэша другой ревизии', OPTS, async () => {
  const REV2 = 'rev_2';
  const runId = await makeRun('seg-run-crossrev');
  const scope2 = { revisionId: REV2, configVersion: CFG };

  // Ревизия 1 уже содержит посчитанную часть 'a' (индекс 0, тесты выше).
  // Новая ревизия (согласованная версия): нарезка сдвинулась — тот же вход
  // оказался частью с ДРУГИМ индексом.
  await store.planCache(TENDER_ID, STAGE, { ...scope2, segments: [seg(0, 'intro-new'), seg(1, 'a')] });

  const wrapped = store.makeStageSegmentStore({
    tenderId: TENDER_ID, stage: STAGE, revisionId: REV2, configVersion: CFG, runId,
  });
  const reused = await wrapped.getCompleted(1, 'a');
  assert.deepEqual(reused, [{ fragment: 'A' }], 'результат ревизии 1 переиспользован по input_hash');

  // Прогрев: результат продублирован в кэш текущей ревизии — следующий запуск
  // попадёт точным ключом.
  assert.deepEqual(await store.getCompleted(TENDER_ID, STAGE, 1, 'a', scope2), [{ fragment: 'A' }]);

  // Изменённая часть новой ревизии из чужого кэша не поднимается.
  assert.equal(await wrapped.getCompleted(0, 'intro-new'), null);

  // Другая версия конфигурации — не кэш (та же защита, что и внутри ревизии).
  assert.equal(await store.getCompletedByHash(TENDER_ID, STAGE, 'a', { configVersion: 'cfg_other' }), null);
});

test('части разных стадий одного тендера не пересекаются', OPTS, async () => {
  const runId = await makeRun('seg-run-stage4');
  await getDb().queryRun('UPDATE analysis_runs SET stage = 4 WHERE id = ?', runId);
  await store.planCache(TENDER_ID, 4, { ...cacheScope, segments: [seg(0, 'z')] });
  await store.planRunSegments(runId, TENDER_ID, 4, { ...cacheScope, segments: [seg(0, 'z')] });
  await store.saveCache(TENDER_ID, 4, 0, { findings: [{ fragment: 'риск' }], ...cacheScope, runId });
  await store.markRunSegmentDone(runId, 0, { count: 1 });

  assert.equal((await store.listRunSegments(TENDER_ID, 4, runId)).length, 1);
  assert.equal(
    (await store.listRunSegments(TENDER_ID, STAGE, 'seg-run-fail')).length, 3,
    'стадия 4 не должна трогать части стадии 1',
  );
  assert.deepEqual(await store.getCompleted(TENDER_ID, 4, 0, 'z', cacheScope), [{ fragment: 'риск' }]);
});
