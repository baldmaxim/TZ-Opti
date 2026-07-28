'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const clustering = require('../services/clustering/clusteringService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/clustering/build — собрать кластеры из draft_issues + issue_reviews.
// ОТЛАДОЧНЫЙ путь: кластеры собираются в НОВЫЙ прогон-кандидат, указатель НЕ
// переводится — действующий снимок и решения инженера не меняются
// (читать результат: ?run_id). Production-сборка — POST …/pipeline/run.
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await clustering.buildClusters(req.params.id);
  res.json({ ...result, run_id: result.summary.run_id, activated: false });
};

// GET /api/tenders/:id/issue-clusters?mode=important|working|verify|full
// Режим по умолчанию — working: только МАТЕРИАЛЬНЫЕ кластеры (verdict='publish').
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const mode = req.query.mode || 'working';
  const items = await clustering.listClusters(req.params.id, mode, req.query.run_id || undefined);
  const byCriticality = items.reduce((acc, c) => {
    acc[c.overall_criticality] = (acc[c.overall_criticality] || 0) + 1;
    return acc;
  }, {});
  const byVerdict = items.reduce((acc, c) => {
    if (c.verdict) acc[c.verdict] = (acc[c.verdict] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, mode, by_criticality: byCriticality, by_verdict: byVerdict });
};
