'use strict';

// ПРИЁМОЧНЫЙ тест сквозного пути портала: HTTP-API + очередь + воркер + живой
// PostgreSQL, модель — стаб (внешней сети нет вовсе).
//
// Сценарии этого файла:
//   1. Без .md-копии ТЗ анализ НЕ ЗАПУСКАЕТСЯ (.docx источником анализа не
//      становится, модель не зовут вообще).
//   2. ПОЛНЫЙ УСПЕШНЫЙ АНАЛИЗ: стадии 1–4 → самоанализ → кластеры → решение
//      инженера → выгрузка. Итог — completed/success на всех поверхностях.
//   3. ПОЛНЫЙ ОТКАЗ LLM не выдаётся за успех: стадия падает, завершить её
//      нельзя, конвейер зелёным не становится.
//   4. ЭКСПОРТ идёт только от АКТИВНОГО согласованного снимка: собранный рядом
//      прогон-кандидат в выгрузку не попадает.
//
//   npm run test:acceptance      — без TEST_DATABASE_URL тесты SKIP
//   npm run test:acceptance:ci   — без TEST_DATABASE_URL тесты ПАДАЮТ
// ВНИМАНИЕ: тест применяет схему (runMigration) — указывайте отдельную БД.

const H = require('./harness'); // ПЕРВЫМ: настраивает окружение до серверных модулей

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { buildMinimalDocx } = require('../../db/fixtures/buildMinimalDocx');

const OPTS = H.OPTS;
const PREFIX = `acc_flow_${process.pid}`;
const created = [];

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
});

after(async () => {
  if (OPTS.skip) return;
  const db = H.getDb();
  for (const id of created) await H.dropTender(db, id);
  await closeQuietly();
  H.removeUploads();
});

async function closeQuietly() {
  try { await H.closeDb(); } catch { /* пул мог не открыться */ }
}

async function newTender(call, title) {
  const id = await H.createTender(call, `${PREFIX} — ${title}`);
  created.push(id);
  return id;
}

// Успешно прогнать и завершить стадию. Возвращает отчёт стадии (summary прогона).
async function passStage(call, tenderId, stage) {
  const run = await H.runStageAndWait(call, tenderId, stage);
  assert.equal(run.queued, true, `стадия ${stage} должна встать в очередь`);
  assert.equal(
    run.status, 'reviewing',
    `стадия ${stage} обязана дойти до рецензии, а не «${run.status}» `
    + `(исход: ${JSON.stringify(run.outcome && run.outcome.status)}, `
    + `причина: ${(run.outcome && run.outcome.error) || '—'})`,
  );
  assert.equal(run.outcome.status, 'completed', `исход стадии ${stage} — полный успех`);
  const finished = await H.finishStage(call, tenderId, stage);
  assert.equal(finished.status, 200, `стадию ${stage} обязано быть можно завершить`);
  return run.outcome;
}

// --- 1. Без .md анализ не запускается ------------------------------------------

test('без .md-копии ТЗ анализ не запускается: .docx источником анализа не становится', OPTS, async (t) => {
  const { call } = await H.startApi(t);
  await H.startWorker(t);
  const llm = H.scriptedLlm(t);
  llm.respond(() => { throw new Error('модель не должна вызываться: входа для анализа нет'); });

  const tenderId = await newTender(call, 'только docx');
  // В слоте ТЗ лежит НАСТОЯЩИЙ .docx (он нужен для экспорта) — и только он.
  await H.uploadDocument(call, tenderId, {
    name: 'ТЗ.docx',
    content: buildMinimalDocx(['1. Раздел 1', 'Подрядчик выполняет монтаж по проекту.']),
    docType: 'tz',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  const run = await H.runStageAndWait(call, tenderId, 1);
  assert.equal(run.queued, true, 'постановка в очередь — не место для проверки входа');

  assert.equal(llm.callCount, 0, 'без .md модель не зовут ВООБЩЕ: платного прогона по .docx быть не должно');
  assert.equal(run.status, 'open', 'стадия обязана вернуться в исходный статус, а не «крутиться»');
  assert.equal(run.run.status, 'failed', 'прогон закрыт как неуспешный');
  assert.equal(run.outcome.status, 'failed', 'исход прогона — сбой, а не «нет данных, но всё хорошо»');
  assert.match(run.outcome.error, /\.md/i, 'в причине сбоя должно быть сказано, что нужна .md-копия ТЗ');

  const finish = await H.finishStage(call, tenderId, 1);
  assert.equal(finish.status, 400, 'стадию без успешного анализа нельзя завершить');

  const issues = await call(`/api/tenders/${tenderId}/stages/1/issues`);
  assert.deepEqual(issues.body.items, [], 'находок из .docx появиться не может');
});

// --- 2. Полный успешный анализ --------------------------------------------------

test('полный успешный анализ: стадии 1–4 → самоанализ → кластеры → решение → выгрузка', OPTS, async (t) => {
  const db = H.getDb();
  const { call } = await H.startApi(t);
  await H.startWorker(t);
  const llm = H.scriptedLlm(t);

  const tenderId = await newTender(call, 'полный успех');
  await H.uploadDocument(call, tenderId, { name: 'ТЗ.md', text: H.buildTzMarkdown() });
  await H.seedQaEntries(db, tenderId);

  // Стадия 1 — добытчик: на каждую часть ТЗ модель отдаёт находку по маркеру.
  llm.respond((c) => H.findingFor(c));
  const card1 = await passStage(call, tenderId, 1);
  assert.ok(card1.issues_count > 0, 'стадия 1 обязана что-то найти — иначе сценарий ничего не проверяет');
  assert.ok(llm.callCount > 1, 'большое ТЗ идёт в модель ЧАСТЯМИ, а не одним куском');

  const issues1 = await call(`/api/tenders/${tenderId}/stages/1/issues`);
  assert.equal(issues1.body.items.length, card1.issues_count);

  // Стадии 2–4: замечаний нет, прогон честно завершается.
  llm.respond(() => H.NO_FINDINGS);
  for (const stage of [2, 3, 4]) await passStage(call, tenderId, stage);

  // Стадия 5 — QC над итогом: собирает НОВЫЙ снимок конвейера целиком.
  const stage5 = await H.runStageAndWait(call, tenderId, 5, { timeoutMs: 120_000 });
  assert.equal(stage5.status, 'reviewing', 'самоанализ обязан завершиться успехом');
  assert.equal(stage5.outcome.status, 'completed', 'частичный QC — это warning; здесь ожидается полный успех');
  assert.equal(stage5.outcome.issues_count, 0, 'Стадия 5 — QC, она не порождает issues');

  // Конвейер: исход зафиксирован в снимке и читается после перезагрузки страницы.
  const status = await call(`/api/tenders/${tenderId}/pipeline/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'completed', 'итог конвейера — полный успех');
  assert.equal(status.body.severity, 'success');
  assert.ok(status.body.active_run && status.body.active_run.run_id, 'у итога обязан быть активный снимок');
  assert.equal(status.body.active_run.status, 'completed');
  assert.equal(status.body.active_run.activated, true, 'снимок под указателем — активированный');
  assert.equal(status.body.failed_step, null);

  // Кластеры — основной объект рецензии.
  const clusters = await call(`/api/tenders/${tenderId}/review/clusters`);
  assert.equal(clusters.status, 200);
  assert.ok(clusters.body.count > 0, 'из находок стадии 1 обязаны собраться кластеры');
  const cluster = clusters.body.items[0];

  // Решение инженера по кластеру.
  const decision = await call(`/api/tenders/${tenderId}/review/clusters/${cluster.id}/decision`, {
    method: 'POST',
    body: { decision: 'accept', final_comment: 'Согласовано: уточнить объём при подаче.' },
  });
  assert.equal(decision.status, 200, `решение по кластеру: ${decision.text.slice(0, 200)}`);

  // Выгрузка идёт от кластеров активного снимка.
  const exported = await call(`/api/tenders/${tenderId}/export/issues.json`);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('x-export-source'), 'clusters', 'основной путь выгрузки — кластеры');
  const payload = JSON.parse(exported.text);
  assert.ok(payload.clusters.length > 0);
  const exportedCluster = payload.clusters.find((c) => c.id === cluster.id);
  assert.ok(exportedCluster, 'кластер с решением обязан попасть в выгрузку');
  assert.equal(exportedCluster.review_status, 'decided');
  assert.equal(exportedCluster.decision.decision, 'accept');

  // --- 4. Экспорт использует ТОЛЬКО активный согласованный снимок --------------
  //
  // Рядом собирается прогон-КАНДИДАТ (отладочная одиночная сборка слоя): он
  // пишет свои кластеры, но указатель не переводит. Выгрузка обязана остаться на
  // прежнем — согласованном — снимке, иначе инженер выгрузит то, чего не видел.
  const activeRunId = status.body.active_run.run_id;
  const candidate = await call(`/api/tenders/${tenderId}/pipeline/run`, {
    method: 'POST', body: { mode: 'debug', with_self_analysis: false },
  });
  assert.equal(candidate.status, 200);
  assert.equal(candidate.body.ok, true, `отладочная сборка: ${candidate.text.slice(0, 300)}`);
  assert.equal(candidate.body.activated, false, 'отладочная сборка НЕ переводит указатель снимка');
  const candidateRunId = candidate.body.run_id;
  assert.ok(candidateRunId && candidateRunId !== activeRunId, 'кандидат обязан быть отдельным прогоном');

  const candidateClusters = await db.queryAll(
    'SELECT id FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?', tenderId, candidateRunId,
  );
  assert.ok(candidateClusters.length > 0, 'кандидат должен был собрать свои кластеры — иначе проверять нечего');

  const afterCandidate = await call(`/api/tenders/${tenderId}/pipeline/status`);
  assert.equal(afterCandidate.body.active_run.run_id, activeRunId, 'указатель снимка не двигается кандидатом');

  const exportedAgain = await call(`/api/tenders/${tenderId}/export/issues.json`);
  const payload2 = JSON.parse(exportedAgain.text);
  const exportedIds = new Set(payload2.clusters.map((c) => c.id));
  const candidateIds = candidateClusters.map((c) => c.id);
  assert.ok(
    candidateIds.every((id) => !exportedIds.has(id)),
    'кластеры неактивированного прогона в выгрузке появиться не могут',
  );
  assert.deepEqual(
    [...exportedIds].sort(),
    payload.clusters.map((c) => c.id).sort(),
    'состав выгрузки не изменился: источник — тот же активный снимок',
  );
  const stillDecided = payload2.clusters.find((c) => c.id === cluster.id);
  assert.equal(stillDecided.decision.decision, 'accept', 'решение инженера кандидатом не затёрто');
});

// --- 3. Полный отказ LLM ---------------------------------------------------------

test('полный отказ LLM не отображается как успех', OPTS, async (t) => {
  const db = H.getDb();
  const { call } = await H.startApi(t);
  await H.startWorker(t);
  const llm = H.scriptedLlm(t);

  const tenderId = await newTender(call, 'отказ модели');
  await H.uploadDocument(call, tenderId, { name: 'ТЗ.md', text: H.buildTzMarkdown() });
  await H.seedQaEntries(db, tenderId);

  // Модель недоступна НА ВСЕХ частях ТЗ — полный отказ, а не «одна часть».
  llm.respond(() => new Error('модель недоступна: соединение разорвано'));

  const run = await H.runStageAndWait(call, tenderId, 1);
  assert.ok(llm.callCount > 0, 'стадия обязана была попытаться');

  assert.equal(run.outcome.status, 'failed', 'исход прогона — failed');
  assert.equal(run.run.status, 'failed', 'узкий статус прогона тоже неуспешный');
  assert.match(run.outcome.error, /модель недоступна/);
  assert.equal(run.status, 'open', 'после сбоя стадия снова доступна к запуску');

  // Гейт: сбойную стадию нельзя «закрыть» и пойти дальше.
  const finish = await H.finishStage(call, tenderId, 1);
  assert.equal(finish.status, 400, 'завершить стадию после сбоя нельзя — иначе следующий гейт откроется по сбою');
  const stage2 = await call(`/api/tenders/${tenderId}/stages/2/run`, { method: 'POST' });
  assert.equal(stage2.status, 400, 'стадия 2 не должна открыться после сбоя стадии 1');

  // Ни находок, ни активного снимка, ни зелёного конвейера.
  const issues = await call(`/api/tenders/${tenderId}/stages/1/issues`);
  assert.deepEqual(issues.body.items, [], 'сбойный прогон не оставляет находок в активном снимке');

  const runs = await db.queryAll(
    `SELECT status FROM analysis_runs WHERE tender_id = ? AND kind = 'stage'`, tenderId,
  );
  assert.equal(runs.length, 1, 'на сбой заводится РОВНО ОДИН прогон — тот, что начался до модели');
  assert.equal(runs[0].status, 'failed');

  const pointer = await db.queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = 'stage:1'`, tenderId,
  );
  assert.equal(pointer, undefined, 'провалившийся прогон не становится актуальным снимком');

  const status = await call(`/api/tenders/${tenderId}/pipeline/status`);
  assert.notEqual(status.body.severity, 'success', 'после полного отказа модели итог не может быть зелёным');
});
