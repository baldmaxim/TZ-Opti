'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound, badRequest } = require('../utils/errors');

const FIELDS = ['category', 'condition', 'criticality', 'comment'];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

exports.list = (req, res) => {
  const rows = db.prepare('SELECT * FROM company_conditions WHERE tender_id = ? ORDER BY rowid ASC').all(req.params.id);
  res.json({ items: rows });
};

exports.create = (req, res) => {
  const tenderId = req.params.id;
  const body = req.body || {};
  if (!body.condition) throw badRequest('Поле condition обязательно');
  const id = newId();
  const data = pick(body);
  const cols = ['id', 'tender_id', ...Object.keys(data)];
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO company_conditions (${cols.join(', ')}) VALUES (${placeholders})`).run(
    id,
    tenderId,
    ...Object.values(data)
  );
  res.status(201).json(db.prepare('SELECT * FROM company_conditions WHERE id = ?').get(id));
};

exports.update = (req, res) => {
  const id = req.params.itemId;
  const existing = db.prepare('SELECT id FROM company_conditions WHERE id = ?').get(id);
  if (!existing) throw notFound('Запись не найдена');
  const data = pick(req.body || {});
  if (!Object.keys(data).length) {
    return res.json(db.prepare('SELECT * FROM company_conditions WHERE id = ?').get(id));
  }
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE company_conditions SET ${sets} WHERE id = ?`).run(...Object.values(data), id);
  res.json(db.prepare('SELECT * FROM company_conditions WHERE id = ?').get(id));
};

exports.remove = (req, res) => {
  const r = db.prepare('DELETE FROM company_conditions WHERE id = ?').run(req.params.itemId);
  if (!r.changes) throw notFound('Запись не найдена');
  res.json({ ok: true });
};
