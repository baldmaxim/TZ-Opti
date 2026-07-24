'use strict';

// Обработчики задач конвейера. В отличие от стадии, конвейер разложен на
// ЗАДАЧИ ПО ШАГАМ: begin → draft_issues → critic → clustering → self_analysis →
// finalize. Это и есть чекпойнт на уровне задания: успешный шаг не
// переделывается при повторе, а сбой одного шага не заставляет собирать всё
// заново. Финализатор помечен always_run — он отработает и после сбоя шага
// (иначе pipeline-прогон навсегда остался бы в статусе running).

const db = require('../../../db/connection');
const pipeline = require('../../pipeline/analysisPipeline');
const analysisRuns = require('../../analysisRuns/analysisRunsService');

// Шаг 0: начать снимок (прогон) и запомнить его в задании — следующие задачи
// пишут в него же.
async function runBegin(ctx) {
  const { runId, documentsRevisionId, configVersion } = await pipeline.beginPipelineRun(ctx.job.tender_id);
  await db.queryRun('UPDATE analysis_jobs SET analysis_run_id = ? WHERE id = ?', runId, ctx.job.id);
  return { run_id: runId, documents_revision_id: documentsRevisionId, config_version: configVersion };
}

async function runStep(ctx) {
  const runId = await requireRunId(ctx);
  const step = ctx.payload && ctx.payload.step;
  ctx.guard();
  return pipeline.runPipelineStep(ctx.job.tender_id, runId, step);
}

// Финал: собрать отчёт из результатов задач-шагов и активировать снимок (или
// пометить прогон failed). Отчёт кладём в задание — его отдаёт API.
async function runFinalize(ctx) {
  const runId = await requireRunId(ctx);
  const tasks = await ctx.store.getTasks(ctx.job.id);
  const beginTask = tasks.find((t) => t.task_type === 'pipeline_begin');
  const beginRes = safeParse(beginTask && beginTask.result_json) || {};

  const steps = tasks
    .filter((t) => t.task_type === 'pipeline_step')
    .sort((a, b) => a.seq - b.seq)
    .map((t) => stepReport(t));

  const report = await pipeline.finalizePipelineRun(
    ctx.job.tender_id, runId, steps,
    { documentsRevisionId: beginRes.documents_revision_id, configVersion: beginRes.config_version },
  );
  await db.queryRun('UPDATE analysis_jobs SET result_json = ? WHERE id = ?', JSON.stringify(report), ctx.job.id);
  return report;
}

// Строка отчёта по задаче-шагу: статус задачи очереди → статус шага конвейера.
function stepReport(task) {
  const res = safeParse(task.result_json);
  if (res && res.step) return res;
  const step = (safeParse(task.payload_json) || {}).step || task.task_key;
  if (task.status === 'skipped') {
    return { step, status: 'skipped', reason: task.error || 'предыдущий шаг не выполнен' };
  }
  if (task.status === 'completed') return { step, status: 'done' };
  return { step, status: 'failed', error: task.error || `шаг завершился со статусом «${task.status}»` };
}

async function requireRunId(ctx) {
  const job = await ctx.store.getJob(ctx.job.id);
  const runId = job && job.analysis_run_id;
  if (!runId) {
    const err = new Error('Прогон конвейера не начат (шаг begin не выполнен)');
    err.retryable = false;
    throw err;
  }
  return runId;
}

// Задание оборвано/отменено до финализатора — прогон не должен остаться
// «running» навсегда.
async function onJobSettled({ job }) {
  if (job.status === 'completed' || !job.analysis_run_id) return;
  const run = await db.queryOne('SELECT status FROM analysis_runs WHERE id = ?', job.analysis_run_id);
  if (!run || run.status !== 'running') return;
  await analysisRuns.failRun(job.analysis_run_id, JSON.stringify({ job_status: job.status, error: job.error || null }));
}

function safeParse(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

module.exports = { runBegin, runStep, runFinalize, onJobSettled, stepReport };
