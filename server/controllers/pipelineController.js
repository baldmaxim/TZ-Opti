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

// GET /api/tenders/:id/pipeline/status — свежесть слоёв конвейера
// (счётчик + время сборки + stale на слой, сводный needs_rebuild).
exports.status = async (req, res) => {
  await ensureTender(req.params.id);
  res.json(await pipeline.pipelineStatus(req.params.id));
};
