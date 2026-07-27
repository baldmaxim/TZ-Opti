'use strict';

// Integration: ЖИЗНЕННЫЙ ЦИКЛ ПРОГОНА СТАДИИ на живой PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем инварианты, ради которых цикл перестроен:
//   1. analysis_run создаётся со status='running' ДО запуска LLM-оркестратора, и
//      его runId идёт во ВСЕ части ТЗ (analysis_run_segments.analysis_run_id).
//   2. Сбой в СЕРЕДИНЕ документа завершает ТОТ ЖЕ прогон (failed) с реальными
//      started_at / finished_at / documents_revision_id / config_version /
//      error в summary. Отдельной «фиктивной» failed-строки НЕ появляется.
//   3. Рестарт воркера: прогон, оставшийся running без живого задания, честно
//      закрывается как interrupted (не failed) вместе со своими частями.
//   4. Точечный retry: гасится кэш ОДНОЙ части — следующий прогон зовёт модель
//      ровно один раз, остальные части приходят из кэша (source='cache').
//   5. История двух последовательных прогонов лежит рядом и не перетирается.
//
// Сеть и реальный LLM не используются: провайдер chatJson подменён fakeLlm.

// Настройки читаются модулями при загрузке — задаём ДО require().
process.env.STAGE_SEGMENT_TOKENS = '500';   // мелкая нарезка: несколько частей ТЗ
process.env.STAGE_CROSS_SEGMENT_REVIEW = '0'; // без LLM-шага сверки: счёт вызовов детерминирован
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { installFakeLlm } = require('../helpers/fakeLlm');

const OPTS = dbTestOptions();
const TENDER_ID = 'stage-lifecycle-tender';
const STAGE = 1;

const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const segmentStore = require('../../services/stageAnalysis/segments/segmentStore');
const stageJob = require('../../services/jobs/handlers/stageAnalysisJob');

// --- Синтетическое ТЗ: несколько разделов, у каждого свой маркер --------------

const FILLER = [
  'Подрядчик выполняет работы в объёме, определённом проектной документацией и настоящим',
  'техническим заданием, с соблюдением требований действующих норм, правил охраны труда',
  'и промышленной безопасности, а также утверждённого графика производства работ.',
].join(' ');

function buildTzMarkdown({ sections = 8, clauses = 4 } = {}) {
  const out = [];
  for (let s = 1; s <= sections; s += 1) {
    out.push(`# ${s}. Раздел ${s}. Требования к производству работ`, '');
    for (let c = 1; c <= clauses; c += 1) {
      out.push(`${s}.${c} МАРКЕР-${s}-${c}. ${FILLER} ${FILLER}`, '');
    }
  }
  return out.join('\n');
}

// Ответ «модели» на часть ТЗ: находка с цитатой ИЗ ЭТОЙ ЖЕ части (иначе она не
// локализуется и будет отброшена). Домен стадии 1 — покрытие расчёта.
function findingFor(call) {
  const marker = (String(call.user).match(/МАРКЕР-\d+-\d+/) || [])[0];
  if (!marker) return { findings: [] };
  return {
    findings: [{
      fragment: marker,
      problem_type: 'не_учтено_в_вор',
      criticality: 'medium',
      basis: 'работа описана в ТЗ, но не найдена в ведомости',
      review_comment: `Проверить объём по ${marker}`,
      suggested_action: 'clarify',
      confidence: 0.7,
    }],
  };
}

async function resetTender() {
  const db = getDb();
  await db.queryRun('DELETE FROM analysis_run_segments WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_segments WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_tasks WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_jobs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_signals WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM issues WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_runs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun(
    `UPDATE tender_stage_state SET stage1_status = 'open', current_stage = 1 WHERE tender_id = ?`,
    TENDER_ID,
  );
}

const runsOf = (db) => db.queryAll(
  `SELECT * FROM analysis_runs WHERE tender_id = ? AND stage = ? ORDER BY started_at ASC, id ASC`,
  TENDER_ID, STAGE,
);

const parse = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_e) { return null; }
};

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Жизненный цикл прогона стадии', 'draft', new Date().toISOString(),
  );
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', ?, ?, ?, ?, 'extracted')`,
    'stage-lifecycle-tz', TENDER_ID, 'ТЗ.md', '/tmp/ТЗ.md',
    new Date().toISOString(), buildTzMarkdown(),
  );
  await engine.getStageState(TENDER_ID); // завести строку tender_stage_state
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  // Очередь в тестовой БД общая для всех файлов: не оставляем после себя ни
  // одной задачи, иначе чужой воркер заберёт её и уронит соседний тест.
  await db.queryRun('DELETE FROM analysis_tasks WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM analysis_jobs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

// --- 1. Сбой в СЕРЕДИНЕ документа ------------------------------------------------

test('сбой в середине документа: завершается ТОТ ЖЕ прогон (failed), второй строки нет', OPTS, async (t) => {
  const db = getDb();
  await resetTender();

  // Первые две части считаются, третья роняет прогон (fail-loud у стадий 1–4).
  installFakeLlm(t, (call, i) => (i < 2 ? findingFor(call) : new Error('модель недоступна: таймаут')));

  const before = (await runsOf(db)).length;
  await assert.rejects(
    () => engine.runStageInner(TENDER_ID, STAGE),
    /часть 3\/|модель недоступна/,
    'упавшая часть обязана уронить прогон стадии-добытчика',
  );

  const runs = await runsOf(db);
  assert.equal(runs.length, before + 1, 'на сбой заводится РОВНО ОДИН прогон — тот, что начался до оркестратора');
  const run = runs[runs.length - 1];

  assert.equal(run.status, 'failed');
  assert.ok(run.started_at, 'started_at — реальное начало прогона');
  assert.ok(run.finished_at, 'finished_at проставлен');
  assert.ok(
    Date.parse(run.finished_at) >= Date.parse(run.started_at),
    'прогон не может закончиться раньше, чем начался',
  );
  assert.notEqual(run.started_at, run.finished_at, 'started_at ≠ finished_at: прогон реально шёл, а не «мгновенно упал»');
  assert.ok(run.documents_revision_id, 'ревизия документов зафиксирована на старте прогона');
  assert.ok(run.config_version, 'версия конфигурации зафиксирована на старте прогона');

  const summary = parse(run.summary);
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /модель недоступна|часть 3/);
  assert.equal(summary.failed_segment_index, 2, 'в отчёте видно, на какой части ТЗ встал прогон');

  // Части: 0–1 посчитаны, 2 упала, остальные до выполнения не дошли.
  const segs = await segmentStore.listRunSegments(TENDER_ID, STAGE, run.id);
  assert.ok(segs.length >= 4, 'ТЗ должно резаться минимум на 4 части — иначе «середина документа» не проверяется');
  assert.equal(segs[0].status, 'completed');
  assert.equal(segs[1].status, 'completed');
  assert.equal(segs[2].status, 'failed');
  assert.match(segs[2].error, /модель недоступна/);
  assert.ok(segs.slice(3).every((s) => s.status === 'skipped'), 'части после сбоя — skipped, а не «висят» pending');
  assert.ok(segs.every((s) => s.analysis_run_id === run.id), 'runId прогона проставлен во ВСЕ части');

  // Указатель стадии не переведён: пригодного снимка нет.
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, STAGE), null);
  const state = await engine.getStageState(TENDER_ID);
  assert.notEqual(state.stage1_status, 'reviewing', 'после сбоя стадию завершать нельзя');

  // Кэш: только реально посчитанные части.
  const cacheOf = (s) => segmentStore.getCompleted(TENDER_ID, STAGE, s.segment_index, s.input_hash, {
    revisionId: s.document_revision_id, configVersion: s.config_version,
  });
  assert.ok(await cacheOf(segs[0]), 'посчитанная часть попадает в кэш');
  assert.equal(await cacheOf(segs[2]), null, 'упавшая часть в кэш не попадает');
});

// --- 2. Рестарт воркера ------------------------------------------------------------

test('рестарт воркера: осиротевший прогон закрывается как interrupted, а не как failed', OPTS, async () => {
  const db = getDb();
  await resetTender();

  // Прогон начат (как это делает постановка стадии в очередь), часть считается.
  const { runId } = await engine.beginStageRun(TENDER_ID, STAGE, { reason: 'test.restart' });
  await segmentStore.planRunSegments(runId, TENDER_ID, STAGE, {
    revisionId: 'rev_restart',
    segments: [0, 1, 2].map((i) => ({ index: i, inputHash: `h${i}` })),
  });
  await segmentStore.markRunSegmentDone(runId, 0, { count: 2, source: 'llm' });
  await segmentStore.markRunSegmentRunning(runId, 1);

  // Живое задание защищает прогон: чужой воркер может его вести прямо сейчас.
  await db.queryRun(
    `INSERT INTO analysis_jobs (id, tender_id, job_type, scope_key, idempotency_key, lock_key, status,
                                cancel_requested, progress_total, progress_done, created_at, updated_at)
     VALUES (?, ?, 'stage_analysis', ?, ?, 'lock', 'running', 0, 0, 0, ?, ?)`,
    'job-alive', TENDER_ID, `stage:${STAGE}`, 'idem-job-alive',
    new Date().toISOString(), new Date().toISOString(),
  );
  assert.deepEqual(await engine.recoverOrphanedStageRuns({ tenderId: TENDER_ID }), [], 'прогон с живым заданием трогать нельзя');
  assert.equal((await analysisRuns.getRun(runId)).status, 'running');

  // Воркер умер: задание больше не живое — прогон осиротел.
  await db.queryRun(`UPDATE analysis_jobs SET status = 'interrupted' WHERE id = 'job-alive'`);
  const before = (await runsOf(db)).length;
  const recovered = await engine.recoverOrphanedStageRuns({ tenderId: TENDER_ID });
  assert.ok(recovered.includes(runId));
  assert.equal((await runsOf(db)).length, before, 'восстановление НЕ создаёт новых строк прогонов');

  const run = await analysisRuns.getRun(runId);
  assert.equal(run.status, 'interrupted', 'обрыв ≠ ошибка анализа: статус должен их различать');
  assert.ok(run.finished_at, 'у оборванного прогона обязан быть реальный finished_at');
  assert.ok(run.started_at && run.started_at !== run.finished_at, 'started_at сохранён от начала прогона');
  assert.equal(parse(run.summary).status, 'interrupted');
  assert.equal(engine.classifyStageRun(run), 'interrupted');

  const segs = await segmentStore.listRunSegments(TENDER_ID, STAGE, runId);
  assert.equal(segs[0].status, 'completed', 'успевшая часть остаётся посчитанной');
  assert.equal(segs[1].status, 'interrupted', 'часть, считавшаяся в момент обрыва');
  assert.equal(segs[2].status, 'skipped', 'часть, до которой не дошли');
});

test('финализатор задания завершает ТОТ ЖЕ прогон (cancelled/interrupted), не заводя новый', OPTS, async () => {
  const db = getDb();
  await resetTender();

  const { runId } = await engine.beginStageRun(TENDER_ID, STAGE, { reason: 'test.job' });
  const before = (await runsOf(db)).length;

  await stageJob.onJobSettled({
    job: {
      id: 'job-cancelled',
      tender_id: TENDER_ID,
      status: 'cancelled',
      analysis_run_id: runId,
      error: 'отменено инженером',
      payload_json: JSON.stringify({ stage: STAGE, prev_status: 'open' }),
    },
  });

  assert.equal((await runsOf(db)).length, before, 'фиктивная вторая строка после сбоя не создаётся');
  const run = await analysisRuns.getRun(runId);
  assert.equal(run.status, 'cancelled');
  assert.match(parse(run.summary).error, /отменено инженером/);
  assert.equal((await engine.getStageState(TENDER_ID)).stage1_status, 'open', 'стадия возвращена в исходный статус');
});

test('гонка «постановка против воркера»: у задания ровно один прогон', OPTS, async () => {
  const db = getDb();
  await resetTender();
  await db.queryRun(
    `INSERT INTO analysis_jobs (id, tender_id, job_type, scope_key, idempotency_key, lock_key, status,
                                cancel_requested, progress_total, progress_done, created_at, updated_at)
     VALUES (?, ?, 'stage_analysis', ?, ?, 'lock', 'running', 0, 0, 0, ?, ?)`,
    'job-race', TENDER_ID, `stage:${STAGE}`, 'idem-job-race',
    new Date().toISOString(), new Date().toISOString(),
  );

  // Двое одновременно завели прогон и оба пытаются закрепить его за заданием.
  const a = await engine.beginStageRun(TENDER_ID, STAGE, { reason: 'race.a' });
  const b = await engine.beginStageRun(TENDER_ID, STAGE, { reason: 'race.b' });
  const [winA, winB] = await Promise.all([
    engine.attachStageRunToJob('job-race', TENDER_ID, STAGE, a.runId),
    engine.attachStageRunToJob('job-race', TENDER_ID, STAGE, b.runId),
  ]);

  assert.equal(winA, winB, 'оба участника обязаны работать с ОДНИМ прогоном');
  const job = await db.queryOne('SELECT analysis_run_id FROM analysis_jobs WHERE id = ?', 'job-race');
  assert.equal(job.analysis_run_id, winA);
  const alive = (await runsOf(db)).filter((r) => r.status === 'running');
  assert.deepEqual(alive.map((r) => r.id), [winA], 'вторая «начатая» строка не остаётся висеть');

  await db.queryRun('DELETE FROM analysis_jobs WHERE id = ?', 'job-race');
});

// --- 3. Точечный retry одной части + 4. История двух прогонов ---------------------

test('точечный retry: модель зовут ровно на одну часть, остальные — из кэша', OPTS, async (t) => {
  const db = getDb();
  await resetTender();

  // Прогон №1 — полный успех.
  const llm1 = installFakeLlm(t, (call) => findingFor(call));
  const first = await engine.runStageInner(TENDER_ID, STAGE);
  const parts = (await segmentStore.listRunSegments(TENDER_ID, STAGE, first.runId)).length;
  assert.ok(parts >= 4);
  assert.equal(llm1.callCount, parts, 'первый прогон считает все части');
  llm1.restore();

  const firstRun = await analysisRuns.getRun(first.runId);
  assert.equal(firstRun.status, 'completed');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, STAGE), first.runId, 'успех переводит указатель');

  // Инженер просит пересчитать ОДНУ часть (№2, индекс 1).
  const retry = await engine.retryStageSegment(TENDER_ID, STAGE, 1);
  assert.equal(retry.retried, true);
  assert.ok(retry.job_id, 'retry ставит стадию в очередь');
  assert.ok(retry.run_id, 'у поставленного задания сразу есть свой прогон');
  // Задачу исполняем здесь же (см. ниже), поэтому убираем её из ОБЩЕЙ очереди:
  // тестовая БД одна на все файлы, и чужой воркер не должен её подхватить.
  await db.queryRun('DELETE FROM analysis_tasks WHERE job_id = ?', retry.job_id);
  await db.queryRun(`UPDATE analysis_jobs SET status = 'completed' WHERE id = ?`, retry.job_id);

  // Воркер исполняет задание: прогон уже создан постановкой, движок пишет в него.
  const llm2 = installFakeLlm(t, (call) => findingFor(call));
  const second = await engine.runStageInner(TENDER_ID, STAGE, { runId: retry.run_id });
  assert.equal(second.runId, retry.run_id, 'повтор пишет в прогон ЗАДАНИЯ, а не заводит новый');
  assert.equal(llm2.callCount, 1, 'модель зовут ровно на пересчитываемую часть');
  llm2.restore();

  const segs2 = await segmentStore.listRunSegments(TENDER_ID, STAGE, second.runId);
  assert.equal(segs2[1].source, 'llm', 'пересчитанная часть посчитана моделью');
  assert.ok(
    segs2.filter((_s, i) => i !== 1).every((s) => s.source === 'cache'),
    'остальные части взяты из кэша ревизии',
  );
  assert.ok(segs2.every((s) => s.status === 'completed'));

  const summary2 = segmentStore.summarize(segs2);
  assert.equal(summary2.computed, 1);
  assert.equal(summary2.reused, parts - 1);

  // --- История двух последовательных прогонов -----------------------------------
  const runs = await runsOf(db);
  assert.equal(runs.length, 2, 'два запуска — два прогона');
  assert.equal(runs[0].id, first.runId);
  assert.equal(runs[1].id, second.runId);

  // Строки первого прогона НЕ перетёрты вторым.
  const segs1 = await segmentStore.listRunSegments(TENDER_ID, STAGE, first.runId);
  assert.equal(segs1.length, parts);
  assert.ok(segs1.every((s) => s.source === 'llm'), 'в первом прогоне все части считались моделью');
  assert.ok(
    segs1.every((s) => s.analysis_run_id === first.runId) && segs2.every((s) => s.analysis_run_id === second.runId),
    'части каждого прогона принадлежат своему прогону',
  );

  const history = await segmentStore.listSegmentRuns(TENDER_ID, STAGE);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, second.runId, 'история — новыми сверху');
  assert.equal(history[0].computed, 1);
  assert.equal(history[0].reused, parts - 1);
  assert.equal(history[1].computed, parts);

  // API-представление: части КОНКРЕТНОГО прогона + список прогонов.
  const view = await engine.listStageSegments(TENDER_ID, STAGE, { runId: first.runId });
  assert.equal(view.run_id, first.runId);
  assert.equal(view.items.length, parts);
  assert.equal(view.runs.length, 2);
  const latest = await engine.listStageSegments(TENDER_ID, STAGE);
  assert.equal(latest.run_id, second.runId, 'без run_id показывается последний прогон');
});

// --- Кэш скоуплен ревизией --------------------------------------------------------

test('кэш скоуплен ревизией: новая версия ТЗ не переиспользует части прошлой', OPTS, async () => {
  const opts = { revisionId: 'rev_A', configVersion: 'cfg_1' };
  await segmentStore.planCache(TENDER_ID, 4, { ...opts, segments: [{ index: 0, inputHash: 'h0' }] });
  await segmentStore.saveCache(TENDER_ID, 4, 0, { findings: [{ fragment: 'A' }], ...opts });
  assert.deepEqual(await segmentStore.getCompleted(TENDER_ID, 4, 0, 'h0', opts), [{ fragment: 'A' }]);

  // Другая ревизия — своя строка кэша, чужой результат не подставляется.
  const optsB = { revisionId: 'rev_B', configVersion: 'cfg_1' };
  await segmentStore.planCache(TENDER_ID, 4, { ...optsB, segments: [{ index: 0, inputHash: 'h0' }] });
  assert.equal(await segmentStore.getCompleted(TENDER_ID, 4, 0, 'h0', optsB), null);
  assert.deepEqual(
    await segmentStore.getCompleted(TENDER_ID, 4, 0, 'h0', opts),
    [{ fragment: 'A' }],
    'кэш прошлой ревизии не затёрт новой',
  );

  // Смена версии конфигурации (модель/вариант промта) обесценивает кэш.
  assert.equal(
    await segmentStore.getCompleted(TENDER_ID, 4, 0, 'h0', { revisionId: 'rev_A', configVersion: 'cfg_2' }),
    null,
  );
});
