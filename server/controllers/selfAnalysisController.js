'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const selfAnalysis = require('../services/selfAnalysis/selfAnalysisService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/self-analysis/build — QC над итогом (кластеры + ТЗ).
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await selfAnalysis.buildSelfAnalysis(req.params.id);
  res.json(result);
};

// GET /api/tenders/:id/self-analysis?finding_type=missed_coverage|weak_cluster|cluster_contradiction|needs_enrichment
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const findingType = req.query.finding_type || null;
  const items = await selfAnalysis.listSelfAnalysis(req.params.id, { findingType });
  const byType = items.reduce((acc, f) => {
    acc[f.finding_type] = (acc[f.finding_type] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, by_type: byType });
};
