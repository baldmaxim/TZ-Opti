'use strict';

// Согласованные версии ТЗ (tz_agreed_versions). Тонкий контроллер над
// services/agreedVersion/agreedVersionService.js.

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const svc = require('../services/agreedVersion/agreedVersionService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

const actorOpts = (req) => ({ actor: req.principal || null, requestId: req.requestId || null });

// POST /api/tenders/:id/agreed-versions — сформировать версию (draft) из
// текущих решений активного pipeline-прогона.
exports.create = async (req, res) => {
  await ensureTender(req.params.id);
  const version = await svc.createAgreedVersion(req.params.id, actorOpts(req));
  res.status(201).json(version);
};

// GET /api/tenders/:id/agreed-versions — список версий (без текста).
exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const items = await svc.listVersions(req.params.id);
  const active = items.find((v) => v.status === 'active') || null;
  res.json({ items, count: items.length, active_id: active ? active.id : null });
};

// GET /api/tenders/:id/agreed-versions/:versionId — версия с текстом и отчётом.
exports.get = async (req, res) => {
  await ensureTender(req.params.id);
  const version = await svc.getVersion(req.params.id, req.params.versionId, { withText: true });
  res.json(version);
};

// POST /api/tenders/:id/agreed-versions/:versionId/activate — сделать версию
// активной (вход следующего раунда анализа). Прежняя active уходит в archived.
exports.activate = async (req, res) => {
  await ensureTender(req.params.id);
  const version = await svc.activateVersion(req.params.id, req.params.versionId, actorOpts(req));
  res.json(version);
};

// POST /api/tenders/:id/agreed-versions/:versionId/archive — снять версию
// (анализ снова пойдёт от оригинального .md, если активной не осталось).
exports.archive = async (req, res) => {
  await ensureTender(req.params.id);
  const version = await svc.archiveVersion(req.params.id, req.params.versionId, actorOpts(req));
  res.json(version);
};
