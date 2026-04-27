'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound } = require('../utils/errors');

const FIELDS = [
  'tender_type', 'package_scope', 'terms', 'staging',
  'blocks_sections', 'site_constraints', 'special_conditions', 'comment',
];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

exports.get = (req, res) => {
  const tenderId = req.params.id;
  let row = db.prepare('SELECT * FROM additional_object_info WHERE tender_id = ?').get(tenderId);
  if (!row) {
    const tender = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
    if (!tender) throw notFound('Тендер не найден');
    row = {
      id: null,
      tender_id: tenderId,
      tender_type: null,
      package_scope: null,
      terms: null,
      staging: null,
      blocks_sections: null,
      site_constraints: null,
      special_conditions: null,
      comment: null,
    };
  }
  res.json(row);
};

exports.upsert = (req, res) => {
  const tenderId = req.params.id;
  const tender = db.prepare('SELECT id FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const data = pick(req.body || {});
  const existing = db.prepare('SELECT id FROM additional_object_info WHERE tender_id = ?').get(tenderId);
  if (existing) {
    if (Object.keys(data).length) {
      const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE additional_object_info SET ${sets} WHERE tender_id = ?`).run(...Object.values(data), tenderId);
    }
  } else {
    const id = newId();
    const cols = ['id', 'tender_id', ...Object.keys(data)];
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(`INSERT INTO additional_object_info (${cols.join(', ')}) VALUES (${placeholders})`).run(
      id,
      tenderId,
      ...Object.values(data)
    );
  }
  res.json(db.prepare('SELECT * FROM additional_object_info WHERE tender_id = ?').get(tenderId));
};
