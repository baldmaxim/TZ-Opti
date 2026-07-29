'use strict';

// Обработчик задачи «прогнать стадию N» + финализатор задания стадии.
//
// ОДНО ЗАДАНИЕ = ОДИН ПРОГОН (analysis_run). Прогон создаётся при постановке в
// очередь (engine.startStageBackground → beginStageRun), его id лежит в
// analysis_jobs.analysis_run_id, и обе попытки задачи пишут в НЕГО ЖЕ. Поэтому:
//   • части ТЗ с самого начала пишут историю в свой прогон, а не в «ничей»;
//   • неуспех задания завершает ТОТ ЖЕ прогон (failed | cancelled | interrupted)
//     с реальными started_at/finished_at, ревизией документов и версией
//     конфигурации — отдельной фиктивной failed-строки больше нет.
//
// Внутри задачи чекпойнт по сегментам ТЗ: посчитанный сегмент кладётся в
// analysis_tasks.checkpoint_json, поэтому повтор после падения/рестарта НЕ
// переспрашивает LLM про уже сделанное. Чекпойнт привязан к хэшу входа сегмента:
// сменился текст ТЗ — старые части не подхватятся.

const engine = require('../../stageAnalysis/stageAnalysisEngine');
const { STATUS } = require('../../analysis/resultStatus');

const CHECKPOINT_KIND = 'stage_segments';

// Мост между задачей очереди и движком стадий (ctx.progress / ctx.jobControl).
// runId — прогон ЗАДАНИЯ: движок в него пишет, но его НЕ завершает (задача может
// быть повторена); терминальный статус ставит onJobSettled ниже.
function makeStageControl(ctx, runId = null) {
  const cp = ctx.checkpoint && ctx.checkpoint.kind === CHECKPOINT_KIND ? ctx.checkpoint : null;
  const segments = { ...((cp && cp.segments) || {}) };
  return {
    runId: runId || (ctx.job && ctx.job.analysis_run_id) || null,
    guard: () => ctx.guard(),
    setTotal: (n) => ctx.setTotal(n),
    tick: () => ctx.tick(),
    // Готовый сегмент из чекпойнта — только если вход совпал побайтово (хэш).
    getSegment(idx, hash) {
      const hit = segments[String(idx)];
      if (!hit || !hash || hit.h !== hash) return null;
      return Array.isArray(hit.f) ? hit.f : null;
    },
    async saveSegment(idx, hash, findings) {
      segments[String(idx)] = { h: hash, f: findings };
      await ctx.saveCheckpoint({ kind: CHECKPOINT_KIND, segments });
    },
  };
}

async function runTask(ctx) {
  const stage = Number(ctx.payload && ctx.payload.stage);
  const tenderId = ctx.job.tender_id;
  const runId = await ensureRunId(ctx, stage);
  const control = makeStageControl(ctx, runId);

  const result = await engine.runStageInner(tenderId, stage, control);
  return { run_id: result.runId, summary: result.summary };
}

// Прогон задания. Обычно он уже создан при постановке в очередь; страховка на
// случай задания, поставленного до этой версии (или созданного в обход движка),
// и на гонку «воркер забрал задачу раньше, чем постановка записала прогон»:
// закрепление условно (attachStageRunToJob), лишний пустой прогон не остаётся.
async function ensureRunId(ctx, stage) {
  const job = await ctx.store.getJob(ctx.job.id);
  if (job && job.analysis_run_id) return job.analysis_run_id;
  const { runId } = await engine.beginStageRun(ctx.job.tender_id, stage, {
    reason: `stage.run job=${ctx.job.id} (worker)`,
  });
  return engine.attachStageRunToJob(ctx.job.id, ctx.job.tender_id, stage, runId);
}

// Финализатор задания: неуспешный исход завершает ТОТ ЖЕ прогон и возвращает
// стадию из 'running' в исходный статус (иначе портал навсегда покажет
// крутящееся кольцо). Успех движок фиксирует сам (publishStageResult: снимок,
// активация и 'reviewing' одной транзакцией).
async function onJobSettled({ job }) {
  if (job.status === 'completed') return;
  const payload = safeParse(job.payload_json) || {};
  const stage = Number(payload.stage);
  if (!stage) return;
  const prevStatus = payload.prev_status || 'open';
  const status = {
    cancelled: STATUS.CANCELLED,
    interrupted: STATUS.INTERRUPTED,
  }[job.status] || STATUS.FAILED;
  await engine.finalizeStageRun(
    job.tender_id,
    stage,
    job.analysis_run_id || null,
    new Error(job.error || messageFor(job.status, stage)),
    { status, prevStatus },
  );
}

function messageFor(jobStatus, stage) {
  if (jobStatus === 'cancelled') return `Анализ стадии ${stage} отменён инженером.`;
  if (jobStatus === 'interrupted') {
    return `Анализ стадии ${stage} оборван (перезапуск сервера / потеря воркера). Запустите заново.`;
  }
  return `Анализ стадии ${stage} завершился ошибкой.`;
}

function safeParse(v) {
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

module.exports = { runTask, onJobSettled, makeStageControl, CHECKPOINT_KIND };
