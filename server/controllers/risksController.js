'use strict';

const db = require('../db/connection');
const { notFound } = require('../utils/errors');
const risksService = require('../services/risksService');

async function ensureTender(tenderId) {
  const t = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!t) throw notFound('Тендер не найден');
}

exports.list = async (req, res) => {
  await ensureTender(req.params.id);
  const items = await risksService.listForTender(req.params.id);
  res.json({ items });
};

exports.patchState = async (req, res) => {
  await ensureTender(req.params.id);
  await risksService.patchState(req.params.id, req.params.key, req.body || {});
  res.json({ ok: true });
};

exports.reset = async (req, res) => {
  await ensureTender(req.params.id);
  await risksService.reset(req.params.id);
  res.json({ ok: true });
};

exports.matches = async (req, res) => {
  await ensureTender(req.params.id);
  res.json({ matches: await risksService.getMatches(req.params.id) });
};

exports.createCustom = async (req, res) => {
  await ensureTender(req.params.id);
  const id = await risksService.createCustom(req.params.id, req.body || {});
  res.status(201).json({ id });
};

exports.removeCustom = async (req, res) => {
  await ensureTender(req.params.id);
  const ok = await risksService.removeCustom(req.params.id, req.params.customId);
  if (!ok) throw notFound('Свой риск не найден');
  res.json({ ok: true });
};
