'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound, badRequest } = require('../utils/errors');
const { populateStandardChecklist } = require('./tendersController');

const FIELDS = [
  'section', 'work_name', 'in_tz', 'in_pd_rd', 'in_vor',
  'in_calc', 'in_kp', 'in_contract', 'affects_schedule', 'decision', 'comment',
];
const BOOL_FIELDS = ['in_tz', 'in_pd_rd', 'in_vor', 'in_kp', 'in_contract', 'affects_schedule'];
// in_calc — тристат: 1 (учтено) / 0 (не учтено) / null (не указано).

function normalize(body) {
  const out = {};
  for (const f of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
    const v = body[f];
    if (BOOL_FIELDS.includes(f)) {
      out[f] = v ? 1 : 0;
    } else if (f === 'in_calc') {
      if (v === null || v === undefined || v === '') out[f] = null;
      else if (v === 1 || v === 0) out[f] = v;
      else out[f] = v ? 1 : 0;
    } else {
      out[f] = v;
    }
  }
  return out;
}

exports.list = (req, res) => {
  const rows = db
    .prepare('SELECT * FROM work_checklist_items WHERE tender_id = ? ORDER BY rowid ASC')
    .all(req.params.id);
  res.json({ items: rows });
};

exports.create = (req, res) => {
  const tenderId = req.params.id;
  const body = req.body || {};
  if (!body.work_name) throw badRequest('Поле work_name обязательно');
  const id = newId();
  const data = normalize(body);
  const cols = ['id', 'tender_id', ...Object.keys(data)];
  const placeholders = cols.map(() => '?').join(', ');
  const values = [id, tenderId, ...Object.values(data)];
  db.prepare(`INSERT INTO work_checklist_items (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
  res.status(201).json(db.prepare('SELECT * FROM work_checklist_items WHERE id = ?').get(id));
};

exports.update = (req, res) => {
  const id = req.params.itemId;
  const existing = db.prepare('SELECT id FROM work_checklist_items WHERE id = ?').get(id);
  if (!existing) throw notFound('Запись не найдена');
  const data = normalize(req.body || {});
  if (!Object.keys(data).length) {
    return res.json(db.prepare('SELECT * FROM work_checklist_items WHERE id = ?').get(id));
  }
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE work_checklist_items SET ${sets} WHERE id = ?`).run(...Object.values(data), id);
  res.json(db.prepare('SELECT * FROM work_checklist_items WHERE id = ?').get(id));
};

exports.remove = (req, res) => {
  const r = db.prepare('DELETE FROM work_checklist_items WHERE id = ?').run(req.params.itemId);
  if (!r.changes) throw notFound('Запись не найдена');
  res.json({ ok: true });
};

exports.resetToStandard = (req, res) => {
  const tenderId = req.params.id;
  const tender = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM work_checklist_items WHERE tender_id = ?').run(tenderId);
    populateStandardChecklist(tenderId);
  });
  tx();
  const items = db
    .prepare('SELECT * FROM work_checklist_items WHERE tender_id = ? ORDER BY rowid ASC')
    .all(tenderId);
  res.json({ items });
};
