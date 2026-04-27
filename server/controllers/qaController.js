'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const { importQaXlsx } = require('../services/qaImportService');

exports.import = (req, res) => {
  if (!req.file) throw badRequest('Файл не передан');
  const tenderId = req.params.id;
  const tender = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const result = importQaXlsx(tenderId, req.file.path);
  res.status(201).json({ ok: true, ...result });
};

exports.listQa = (req, res) => {
  const items = db.prepare('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC').all(req.params.id);
  res.json({ items });
};

exports.listCharacteristics = (req, res) => {
  const items = db.prepare('SELECT * FROM characteristics WHERE tender_id = ? ORDER BY rowid ASC').all(req.params.id);
  res.json({ items });
};

exports.patchCharacteristic = (req, res) => {
  const id = req.params.charId;
  const existing = db.prepare('SELECT id FROM characteristics WHERE id = ?').get(id);
  if (!existing) throw notFound('Характеристика не найдена');
  const fields = ['name', 'value', 'source', 'comment'];
  const data = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) data[f] = req.body[f];
  if (!Object.keys(data).length) {
    return res.json(db.prepare('SELECT * FROM characteristics WHERE id = ?').get(id));
  }
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE characteristics SET ${sets} WHERE id = ?`).run(...Object.values(data), id);
  res.json(db.prepare('SELECT * FROM characteristics WHERE id = ?').get(id));
};
