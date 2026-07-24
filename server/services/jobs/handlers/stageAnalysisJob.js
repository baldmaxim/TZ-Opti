'use strict';

// Обработчик задачи «прогнать стадию N» + финализатор задания стадии.
//
// Задача = весь прогон стадии. Внутри неё чекпойнт по сегментам ТЗ: каждый
// посчитанный сегмент сразу кладётся в analysis_tasks.checkpoint_json, поэтому
// повтор после падения/рестарта НЕ переспрашивает LLM про уже сделанное.
// Чекпойнт привязан к хэшу входа сегмента: сменился текст ТЗ — старые части
// не подхватятся (лучше пересчитать, чем собрать снимок из разных ревизий).

const db = require('../../../db/connection');
const engine = require('../../stageAnalysis/stageAnalysisEngine');
const { STATUS } = require('../../analysis/resultStatus');

const CHECKPOINT_KIND = 'stage_segments';

// Мост между задачей очереди и движком стадий (ctx.progress / ctx.jobControl).
function makeStageControl(ctx) {
  const cp = ctx.checkpoint && ctx.checkpoint.kind === CHECKPOINT_KIND ? ctx.checkpoint : null;
  const segments = { ...((cp && cp.segments) || {}) };
  return {
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
  const control = makeStageControl(ctx);

  const { runId, summary } = await engine.runStageInner(tenderId, stage, control);

  // Связь задания со снимком анализа (для «какой прогон собрало это задание»).
  await db.queryRun('UPDATE analysis_jobs SET analysis_run_id = ? WHERE id = ?', runId, ctx.job.id);
  return { run_id: runId, summary };
}

// Финализатор задания: статус стадии в tender_stage_state — производная от
// исхода. Успех переводит стадию в 'reviewing' сам движок; любой другой исход
// обязан вернуть её из 'running' в исходный статус, иначе портал навсегда
// покажет крутящееся кольцо.
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
  await engine.recordFailedRun(
    job.tender_id,
    stage,
    prevStatus,
    new Error(job.error || messageFor(job.status, stage)),
    status,
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
