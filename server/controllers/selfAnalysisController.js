'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const selfAnalysis = require('../services/selfAnalysis/selfAnalysisService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/self-analysis/build — QC над итогом (кластеры + ТЗ).
// ОТЛАДОЧНЫЙ путь: QC собирается в НОВЫЙ прогон-кандидат (со своими слоями),
// указатель НЕ переводится — действующий снимок не меняется. Рабочий путь —
// Стадия 5 / POST …/pipeline/run: там снимок собирается целиком и активируется.
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await selfAnalysis.buildSelfAnalysis(req.params.id);
  res.json({ ...result, run_id: result.summary.run_id, activated: false });
};

// GET /api/tenders/:id/self-analysis?finding_type=…&run_id=…
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const findingType = req.query.finding_type || null;
  const items = await selfAnalysis.listSelfAnalysis(req.params.id, {
    findingType, runId: req.query.run_id || null,
  });
  const byType = items.reduce((acc, f) => {
    acc[f.finding_type] = (acc[f.finding_type] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, count: items.length, by_type: byType });
};
