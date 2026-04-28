'use strict';

const db = require('../db/connection');
const { nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');

const ALLOWED_SECTIONS = ['checklist', 'conditions', 'risks', 'qa', 'documents'];

function getLocksMap(tenderId) {
  const rows = db.prepare('SELECT section, locked_at FROM setup_locks WHERE tender_id = ?').all(tenderId);
  const out = {};
  for (const s of ALLOWED_SECTIONS) out[s] = false;
  for (const r of rows) out[r.section] = { locked_at: r.locked_at };
  return out;
}

function ensureSection(section) {
  if (!ALLOWED_SECTIONS.includes(section)) {
    throw badRequest(`Неизвестный раздел подготовки: ${section}. Допустимы: ${ALLOWED_SECTIONS.join(', ')}`);
  }
}

function ensureTender(tenderId) {
  const t = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!t) throw notFound('Тендер не найден');
}

exports.list = (req, res) => {
  ensureTender(req.params.id);
  res.json({ locks: getLocksMap(req.params.id) });
};

exports.lock = (req, res) => {
  ensureTender(req.params.id);
  ensureSection(req.params.section);
  db.prepare(`
    INSERT INTO setup_locks (tender_id, section, locked_at) VALUES (?, ?, ?)
    ON CONFLICT(tender_id, section) DO UPDATE SET locked_at = excluded.locked_at
  `).run(req.params.id, req.params.section, nowIso());
  res.json({ ok: true, locks: getLocksMap(req.params.id) });
};

exports.unlock = (req, res) => {
  ensureTender(req.params.id);
  ensureSection(req.params.section);
  db.prepare('DELETE FROM setup_locks WHERE tender_id = ? AND section = ?').run(req.params.id, req.params.section);
  res.json({ ok: true, locks: getLocksMap(req.params.id) });
};

exports.getLocksMap = getLocksMap;
exports.ALLOWED_SECTIONS = ALLOWED_SECTIONS;
