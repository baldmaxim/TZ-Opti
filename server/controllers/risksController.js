'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const risksService = require('../services/risksService');

function ensureTender(tenderId) {
  const t = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!t) throw notFound('Тендер не найден');
}

exports.list = (req, res) => {
  ensureTender(req.params.id);
  const items = risksService.listForTender(req.params.id);
  res.json({ items });
};

exports.patchState = (req, res) => {
  ensureTender(req.params.id);
  risksService.patchState(req.params.id, req.params.key, req.body || {});
  res.json({ ok: true });
};

exports.reset = (req, res) => {
  ensureTender(req.params.id);
  risksService.reset(req.params.id);
  res.json({ ok: true });
};

exports.matches = (req, res) => {
  ensureTender(req.params.id);
  res.json({ matches: risksService.getMatches(req.params.id) });
};

exports.createCustom = (req, res) => {
  ensureTender(req.params.id);
  const id = risksService.createCustom(req.params.id, req.body || {});
  res.status(201).json({ id });
};

exports.removeCustom = (req, res) => {
  ensureTender(req.params.id);
  const ok = risksService.removeCustom(req.params.id, req.params.customId);
  if (!ok) throw notFound('Свой риск не найден');
  res.json({ ok: true });
};
