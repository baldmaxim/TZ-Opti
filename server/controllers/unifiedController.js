'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const builder = require('../services/unifiedAnalysis/unifiedIssueBuilder');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/unified/build — запустить единый анализатор (собрать draft_issues).
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await builder.buildDraftIssues(req.params.id);
  res.json(result);
};

// GET /api/tenders/:id/draft-issues — прочитать собранные draft_issues.
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const items = await builder.listDraftIssues(req.params.id);
  const byCategory = items.reduce((acc, d) => {
    acc[d.category] = (acc[d.category] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, by_category: byCategory });
};
