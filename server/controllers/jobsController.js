'use strict';

// API очереди фоновых заданий: посмотреть, что считается, с каким прогрессом,
// сколько было попыток — и отменить. Раньше всего этого не существовало:
// состояние прогона жило в памяти процесса и наружу отдавалось одним числом.

const db = require('../db/connection');
const { notFound, badRequest } = require('../utils/errors');
const queue = require('../services/jobs/jobQueue');
const jobService = require('../services/jobs/jobService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// GET /api/tenders/:id/jobs?limit=&status=
exports.listForTender = async (req, res) => {
  await ensureTender(req.params.id);
  const items = await queue.listJobs(req.params.id, {
    limit: req.query.limit,
    status: req.query.status || null,
  });
  res.json({ items });
};

// GET /api/jobs/:jobId — задание + его задачи (попытки, аренда, прогресс).
exports.get = async (req, res) => {
  const job = await queue.describeJob(req.params.jobId);
  if (!job) throw notFound('Задание не найдено');
  res.json(job);
};

// POST /api/jobs/:jobId/cancel — кооперативная отмена: очередь снимается сразу,
// бегущая задача — на ближайшем heartbeat воркера.
exports.cancel = async (req, res) => {
  const out = await queue.requestCancel(req.params.jobId, {
    reason: (req.body && req.body.reason) || 'отменено инженером',
  });
  res.json({ ok: true, ...out });
};

// POST /api/tenders/:id/jobs — постановка задания вручную (debug/интеграции).
// { type: 'stage_analysis', stage: 1 } | { type: 'pipeline', with_self_analysis: false }
exports.enqueue = async (req, res) => {
  await ensureTender(req.params.id);
  const type = (req.body && req.body.type) || '';
  const idempotencyKey = req.get('Idempotency-Key') || (req.body && req.body.idempotency_key) || null;
  let out;
  if (type === jobService.JOB_TYPE.STAGE) {
    const stage = Number(req.body.stage);
    if (![1, 2, 3, 4, 5].includes(stage)) throw badRequest('Допустимы стадии 1..5');
    out = await jobService.enqueueStageAnalysis(req.params.id, stage, { idempotencyKey });
  } else if (type === jobService.JOB_TYPE.PIPELINE) {
    out = await jobService.enqueuePipeline(req.params.id, {
      withSelfAnalysis: !(req.body && req.body.with_self_analysis === false),
      idempotencyKey,
    });
  } else {
    throw badRequest("Неизвестный тип задания: ожидается 'stage_analysis' или 'pipeline'");
  }
  res.status(out.deduped ? 200 : 202).json({
    ok: true,
    deduped: out.deduped || null,
    job: await queue.describeJob(out.job.id),
  });
};

// GET /api/jobs/queue/stats — сводка очереди (debug-страница/мониторинг).
exports.stats = async (_req, res) => {
  res.json({ tasks: await queue.queueStats() });
};
