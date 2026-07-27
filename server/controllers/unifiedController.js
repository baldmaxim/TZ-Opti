'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const builder = require('../services/unifiedAnalysis/unifiedIssueBuilder');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/unified/build — запустить единый анализатор (собрать draft_issues).
// ОТЛАДОЧНЫЙ путь: слой собирается в НОВЫЙ прогон-кандидат и указатель НЕ
// переводится — действующий снимок не меняется. Читать результат: ?run_id из ответа.
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await builder.buildDraftIssues(req.params.id);
  res.json({ ...result, run_id: result.summary.run_id, activated: false });
};

// GET /api/tenders/:id/draft-issues[?run_id=…] — прочитать собранные draft_issues.
// run_id — конкретный прогон (кандидат, собранный одиночным build); без него —
// актуальный снимок.
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const items = await builder.listDraftIssues(req.params.id, { runId: req.query.run_id || null });
  const byCategory = items.reduce((acc, d) => {
    acc[d.category] = (acc[d.category] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, by_category: byCategory });
};
