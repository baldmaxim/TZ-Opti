'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const pipeline = require('../services/pipeline/analysisPipeline');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/pipeline/run — пересобрать конвейер целиком
// (draft_issues → critic → clustering → self-analysis). Тело (опционально):
// { with_self_analysis: false } — без QC-шага (он единственный зовёт LLM).
// Сбой шага не превращается в HTTP-ошибку — возвращается отчёт с ok=false.
exports.run = async (req, res) => {
  await ensureTender(req.params.id);
  const withSelfAnalysis = !(req.body && req.body.with_self_analysis === false);
  const report = await pipeline.runPipeline(req.params.id, { withSelfAnalysis });
  res.json(report);
};

// GET /api/tenders/:id/pipeline/status — свежесть слоёв конвейера
// (счётчик + время сборки + stale на слой, сводный needs_rebuild).
exports.status = async (req, res) => {
  await ensureTender(req.params.id);
  res.json(await pipeline.pipelineStatus(req.params.id));
};
