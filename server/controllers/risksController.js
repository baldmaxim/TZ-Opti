'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound, badRequest } = require('../utils/errors');

const FIELDS = ['category', 'risk_text', 'recommendation', 'criticality'];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

exports.list = (req, res) => {
  const tenderId = req.params.id;
  const rows = db
    .prepare(`SELECT * FROM risk_templates WHERE tender_id = ? OR is_global = 1 ORDER BY is_global DESC, rowid ASC`)
    .all(tenderId);
  res.json({ items: rows });
};

exports.listGlobal = (_req, res) => {
  const rows = db.prepare("SELECT * FROM risk_templates WHERE is_global = 1 ORDER BY rowid ASC").all();
  res.json({ items: rows });
};

exports.create = (req, res) => {
  const tenderId = req.params.id;
  const body = req.body || {};
  if (!body.risk_text) throw badRequest('Поле risk_text обязательно');
  const id = newId();
  const data = pick(body);
  const cols = ['id', 'tender_id', 'is_global', ...Object.keys(data)];
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO risk_templates (${cols.join(', ')}) VALUES (${placeholders})`).run(
    id,
    tenderId,
    0,
    ...Object.values(data)
  );
  res.status(201).json(db.prepare('SELECT * FROM risk_templates WHERE id = ?').get(id));
};

exports.update = (req, res) => {
  const id = req.params.itemId;
  const existing = db.prepare('SELECT id FROM risk_templates WHERE id = ?').get(id);
  if (!existing) throw notFound('Запись не найдена');
  const data = pick(req.body || {});
  if (!Object.keys(data).length) {
    return res.json(db.prepare('SELECT * FROM risk_templates WHERE id = ?').get(id));
  }
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE risk_templates SET ${sets} WHERE id = ?`).run(...Object.values(data), id);
  res.json(db.prepare('SELECT * FROM risk_templates WHERE id = ?').get(id));
};

exports.remove = (req, res) => {
  const r = db.prepare('DELETE FROM risk_templates WHERE id = ?').run(req.params.itemId);
  if (!r.changes) throw notFound('Запись не найдена');
  res.json({ ok: true });
};
