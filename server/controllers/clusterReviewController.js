'use strict';

// Cluster-review (этап 6): issue_clusters как основной объект рецензии.
// Тонкий контроллер над services/review/clusterReviewService.js.

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const svc = require('../services/review/clusterReviewService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

// POST /api/tenders/:id/review/clusters/build — достроить/пересобрать конвейер до кластеров.
// ?force=1 — пересобрать целиком (подхватить новые сигналы стадий).
exports.build = async (req, res) => {
  await ensureTender(req.params.id);
  const force = req.query.force === '1' || req.query.force === 'true';
  const result = await svc.ensureReviewPipeline(req.params.id, { force });
  res.json(result);
};

// GET /api/tenders/:id/review/clusters?mode=working|full — список кластеров для рецензии
// (с сохранёнными решениями, дочерними draft_issues и заметками self-analysis).
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const mode = req.query.mode || 'working';
  const items = await svc.listReviewClusters(req.params.id, mode);
  const decided = items.filter((c) => c.decision).length;
  res.json({ items, count: items.length, decided, pending: items.length - decided, mode });
};

// GET /api/tenders/:id/review/clusters/:clusterId — один кластер, полная объяснимость.
exports.get = async (req, res) => {
  await ensureTender(req.params.id);
  const item = await svc.getReviewCluster(req.params.id, req.params.clusterId);
  res.json(item);
};

// POST /api/tenders/:id/review/clusters/:clusterId/decision — сохранить решение по кластеру.
exports.decide = async (req, res) => {
  await ensureTender(req.params.id);
  const result = await svc.saveClusterDecision(req.params.id, req.params.clusterId, req.body || {});
  res.json(result);
};
