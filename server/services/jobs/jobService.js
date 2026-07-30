'use strict';

// Прикладной слой очереди: как именно «прогнать стадию» и «пересобрать
// конвейер» раскладываются в задание + задачи. Здесь же — чтение прогресса для
// портала (раньше это был Map в памяти процесса, теперь строки в БД).

const db = require('../../db/connection');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { planSteps, PIPELINE_STEPS, resolveMode } = require('../pipeline/analysisPipeline');
const queue = require('./jobQueue');
const M = require('./jobModel');

const JOB_TYPE = Object.freeze({ STAGE: 'stage_analysis', PIPELINE: 'pipeline' });

// Контекст снимка (ревизия документов + версия конфигурации) — он же входит в
// ключ идемпотентности и в ключ advisory-lock: «та же стадия той же ревизии».
async function snapshotContext(tenderId) {
  return {
    documentsRevisionId: await analysisRuns.currentDocumentsRevision(tenderId),
    configVersion: analysisRuns.currentConfigVersion(),
  };
}

// Задание «прогнать стадию N»: одна задача (её единица повтора — вся стадия,
// внутри — чекпойнт по сегментам ТЗ, см. handlers/stageAnalysisJob).
async function enqueueStageAnalysis(tenderId, stage, opts = {}) {
  const { documentsRevisionId, configVersion } = await snapshotContext(tenderId);
  return queue.enqueueJob({
    tenderId,
    jobType: JOB_TYPE.STAGE,
    scopeKey: M.stageScopeKey(stage),
    documentsRevisionId,
    configVersion,
    idempotencyKey: opts.idempotencyKey || null,
    createdBy: opts.createdBy || null,
    payload: { stage, prev_status: opts.prevStatus || 'open' },
    busyMessage:
      `Анализ стадии ${stage} уже выполняется. Дождитесь завершения — ` +
      `портал сам покажет результат (вкладку можно закрыть).`,
    tasks: [
      {
        taskKey: `stage:${stage}`,
        taskType: 'stage_analysis',
        seq: 0,
        maxAttempts: opts.maxAttempts ?? 2, // LLM-прогон дорогой: один повтор
        payload: { stage },
      },
    ],
  });
}

// Задание «пересобрать конвейер»: шаги — отдельные задачи (свои попытки и свой
// чекпойнт: успешный шаг не переделывается), плюс финализатор, который активирует
// снимок. Финализатор помечен always_run — он обязан отработать и после сбоя шага
// (иначе прогон навсегда останется в статусе running).
async function enqueuePipeline(tenderId, opts = {}) {
  const { documentsRevisionId, configVersion } = await snapshotContext(tenderId);
  const keys = planSteps({
    withSelfAnalysis: opts.withSelfAnalysis !== false,
    withChallenger: Boolean(opts.withChallenger),
  });
  const tasks = [
    { taskKey: 'begin', taskType: 'pipeline_begin', seq: 0, maxAttempts: 3, payload: {} },
    ...keys.map((key, i) => ({
      taskKey: `step:${key}`,
      taskType: 'pipeline_step',
      seq: i + 1,
      maxAttempts: PIPELINE_STEPS.find((s) => s.key === key)?.optional ? 2 : 3,
      payload: { step: key },
    })),
    { taskKey: 'finalize', taskType: 'pipeline_finalize', seq: keys.length + 1, alwaysRun: true, maxAttempts: 3, payload: {} },
  ];
  return queue.enqueueJob({
    tenderId,
    jobType: JOB_TYPE.PIPELINE,
    scopeKey: M.SCOPE_PIPELINE,
    documentsRevisionId,
    configVersion,
    idempotencyKey: opts.idempotencyKey || null,
    createdBy: opts.createdBy || null,
    // mode пишем в payload задания: begin-задача может исполняться в другом
    // процессе, а режим (production | debug) обязан быть тем же, что запросили.
    payload: {
      with_self_analysis: opts.withSelfAnalysis !== false,
      with_challenger: Boolean(opts.withChallenger),
      steps: keys,
      mode: resolveMode(opts),
    },
    busyMessage: 'Пересборка конвейера уже выполняется. Дождитесь завершения.',
    tasks,
  });
}

// --- Чтение для портала ----------------------------------------------------------

// Прогресс стадии для кольца в UI. Форма ответа сохранена ({total, done,
// startedAt}), но источник теперь БД, а не память процесса: прогресс виден из
// любого процесса и переживает рестарт.
async function stageProgress(tenderId, stage) {
  const job = await queue.getActiveJobForScope(tenderId, M.stageScopeKey(stage));
  if (!job) return null;
  const startedAt = job.started_at || job.created_at;
  return {
    total: Number(job.progress_total) || 0,
    done: Number(job.progress_done) || 0,
    startedAt: startedAt ? Date.parse(startedAt) : null,
    job_id: job.id,
    job_status: job.status,
    cancel_requested: Boolean(Number(job.cancel_requested)),
  };
}

// Последнее задание области (живое или завершённое) — для карточки стадии.
async function latestJobForScope(tenderId, scopeKey) {
  const job = await db.queryOne(
    `SELECT * FROM analysis_jobs WHERE tender_id = ? AND scope_key = ?
      ORDER BY created_at DESC LIMIT 1`,
    tenderId, scopeKey,
  );
  return job ? queue.viewJob(job, await queue.getTasks(job.id)) : null;
}

module.exports = {
  JOB_TYPE,
  snapshotContext,
  enqueueStageAnalysis,
  enqueuePipeline,
  stageProgress,
  latestJobForScope,
};
