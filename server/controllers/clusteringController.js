'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const clustering = require('../services/clustering/clusteringService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/clustering/build — собрать кластеры из draft_issues + issue_reviews.
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await clustering.buildClusters(req.params.id);
  res.json(result);
};

// GET /api/tenders/:id/issue-clusters?mode=important|working|full
// Режим по умолчанию — working (скрывает кластеры без значимых элементов).
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const mode = req.query.mode || 'working';
  const items = await clustering.listClusters(req.params.id, mode);
  const byCriticality = items.reduce((acc, c) => {
    acc[c.overall_criticality] = (acc[c.overall_criticality] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, mode, by_criticality: byCriticality });
};
