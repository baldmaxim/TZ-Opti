'use strict';

// Админ-операции над историей анализа. Единственный HTTP-путь, которым снимки
// удаляются физически; рабочие действия портала историю только архивируют.

const db = require('../db/connection');
const { notFound, badRequest } = require('../utils/errors');
const purge = require('../services/admin/purgeService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

function options(req) {
  const body = req.body || {};
  const keepLast = body.keep_last === undefined ? 1 : Number(body.keep_last);
  if (!Number.isFinite(keepLast) || keepLast < 0) throw badRequest('keep_last: ожидается неотрицательное число');
  return {
    keepLast,
    olderThan: body.older_than || null,
    confirm: body.confirm || null,
    actor: req.principal || null,
    requestId: req.requestId || null,
  };
}

// GET /api/admin/tenders/:id/analysis-history/purge — ПЛАН (ничего не удаляет).
exports.planPurge = async (req, res) => {
  await ensureTender(req.params.id);
  const keepLast = req.query.keep_last === undefined ? 1 : Number(req.query.keep_last);
  const plan = await purge.planPurge(req.params.id, {
    keepLast: Number.isFinite(keepLast) && keepLast >= 0 ? keepLast : 1,
    olderThan: req.query.older_than || null,
  });
  res.json({ ...plan, dry_run: true });
};

// POST /api/admin/tenders/:id/analysis-history/purge — удалить архивные прогоны.
// Требует { confirm: "<id тендера>" }; без него отвечает планом (dry-run).
// Активный (по указателю) и выполняющийся прогон не удаляются никогда.
exports.purge = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await purge.purgeTenderHistory(req.params.id, options(req));
  req.auditMeta = {
    runs_deleted: result.runs_deleted || 0,
    dry_run: result.dry_run,
    keep_last: result.keep_last,
  };
  res.json(result);
};
