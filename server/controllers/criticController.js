'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const critic = require('../services/critic/criticService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/critic/build — оценить draft_issues (собрать issue_reviews).
// ОТЛАДОЧНЫЙ путь: слой собирается в НОВЫЙ прогон-кандидат, указатель НЕ
// переводится — действующий снимок не меняется (читать результат: ?run_id).
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await critic.buildIssueReviews(req.params.id);
  res.json({ ...result, run_id: result.summary.run_id, activated: false });
};

// GET /api/tenders/:id/issue-reviews?mode=important|working|full
// Режим по умолчанию — working (скрывает малозначимые: show_to_engineer=0).
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const mode = req.query.mode || 'working';
  const items = await critic.listIssueReviews(req.params.id, mode, { runId: req.query.run_id || null });
  const byPriority = items.reduce((acc, r) => {
    acc[r.display_priority] = (acc[r.display_priority] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, mode, by_priority: byPriority });
};
