'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound, badRequest } = require('../utils/errors');
const { populateStandardChecklist } = require('./tendersController');

const FIELDS = [
  'section',
  'work_name',
  'in_tz',
  'in_pd_rd',
  'in_vor',
  'in_calc',
  'in_kp',
  'in_contract',
  'affects_schedule',
  'decision',
  'comment',
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

exports.list = async (req, res) => {
  const rows = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ? ORDER BY section ASC, work_name ASC', req.params.id);
  res.json({ items: rows });
};

exports.create = async (req, res) => {
  const tenderId = req.params.id;
  const body = req.body || {};
  if (!body.work_name) throw badRequest('Поле work_name обязательно');
  const id = newId();
  const data = normalize(body);
  const cols = ['id', 'tender_id', ...Object.keys(data)];
  const placeholders = cols.map(() => '?').join(', ');
  const values = [id, tenderId, ...Object.values(data)];
  await db.queryRun(`INSERT INTO work_checklist_items (${cols.join(', ')}) VALUES (${placeholders})`, ...values);
  res.status(201).json(await db.queryOne('SELECT * FROM work_checklist_items WHERE id = ?', id));
};

exports.update = async (req, res) => {
  const id = req.params.itemId;
  const existing = await db.queryOne('SELECT id FROM work_checklist_items WHERE id = ?', id);
  if (!existing) throw notFound('Запись не найдена');
  const data = normalize(req.body || {});
  if (!Object.keys(data).length) {
    return res.json(await db.queryOne('SELECT * FROM work_checklist_items WHERE id = ?', id));
  }
  const sets = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  await db.queryRun(`UPDATE work_checklist_items SET ${sets} WHERE id = ?`, ...Object.values(data), id);
  res.json(await db.queryOne('SELECT * FROM work_checklist_items WHERE id = ?', id));
};

exports.remove = async (req, res) => {
  const r = await db.queryRun('DELETE FROM work_checklist_items WHERE id = ?', req.params.itemId);
  if (!r.rowCount) throw notFound('Запись не найдена');
  res.json({ ok: true });
};

exports.resetToStandard = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  await db.transaction(async (tx) => {
    await tx.queryRun('DELETE FROM work_checklist_items WHERE tender_id = ?', tenderId);
  });
  await populateStandardChecklist(tenderId);
  const items = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ? ORDER BY section ASC, work_name ASC', tenderId);
  res.json({ items });
};
