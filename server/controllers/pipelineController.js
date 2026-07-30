'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const pipeline = require('../services/pipeline/analysisPipeline');
const jobService = require('../services/jobs/jobService');
const queue = require('../services/jobs/jobQueue');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/pipeline/run — пересобрать конвейер целиком
// (draft_issues → critic → clustering → self-analysis). Тело (опционально):
//   { with_self_analysis: false } — без QC-шага (он единственный зовёт LLM);
//   { async: true } — не ждать: задание уходит в очередь (шаг = задача со своими
//     повторами), ответ 202 с job_id, статус — через GET /api/jobs/:jobId;
//   { mode: 'debug' } — ЯВНЫЙ режим частичной сборки: допускает неполный/неисправный
//     набор входов, но НЕ двигает основной указатель (портал продолжает читать
//     прежний снимок). Любое другое значение — production (fail-closed).
// В production набор входов (manifest stage-прогонов) проверяется до шагов и перед
// активацией. Ни сбой шага, ни негодные входы не превращаются в HTTP-ошибку —
// возвращается отчёт с ok=false (blocked='inputs' / stale_inputs=true).
exports.run = async (req, res) => {
  await ensureTender(req.params.id);
  const withSelfAnalysis = !(req.body && req.body.with_self_analysis === false);
  const mode = pipeline.resolveMode(req.body || {});
  if (req.body && (req.body.async === true || req.body.async === 'true')) {
    const out = await jobService.enqueuePipeline(req.params.id, {
      withSelfAnalysis,
      mode,
      idempotencyKey: req.get('Idempotency-Key') || req.body.idempotency_key || null,
    });
    return res.status(out.deduped ? 200 : 202).json({
      ok: true, queued: true, mode, deduped: out.deduped || null, job: await queue.describeJob(out.job.id),
    });
  }
  const report = await pipeline.runPipeline(req.params.id, { withSelfAnalysis, mode });
  return res.json(report);
};

// GET /api/tenders/:id/pipeline/impact — карта затронутого (dry-run): какие
// части каких стадий придётся пересчитывать при запуске анализа по текущему
// входу (после активации согласованной версии). Без LLM и без записи; хэши
// частей сверяются с кэшем, включая кэш прошлых ревизий. estimate=true —
// жадная упаковка частей может каскадно сдвинуть нарезку, это оценка.
exports.impact = async (req, res) => {
  await ensureTender(req.params.id);
  // Ленивая загрузка: impactService тянет модули стадий — не грузим на импорте.
  // eslint-disable-next-line global-require
  const impact = require('../services/agreedVersion/impactService');
  res.json(await impact.previewStagesImpact(req.params.id));
};

// GET /api/tenders/:id/pipeline/status — состояние конвейера:
//   • свежесть слоёв (счётчик + время сборки + stale, сводный needs_rebuild);
//   • active_run — прогон под указателем (его читает портал);
//   • last_run — последний прогон оркестратора, в т.ч. НЕуспешный;
//   • status/severity/warnings/partial/failed_step/stage_inputs — исход последней
//     сборки, ЗАФИКСИРОВАННЫЙ в analysis_runs.summary при завершении. Поэтому
//     после перезагрузки страницы и рестарта процесса портал показывает тот же
//     completed / completed_with_warnings / failed, а не выводит его заново.
exports.status = async (req, res) => {
  await ensureTender(req.params.id);
  res.json(await pipeline.pipelineStatus(req.params.id));
};
