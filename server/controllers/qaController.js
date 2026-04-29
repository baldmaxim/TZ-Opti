'use strict';

const db = require('../db/connection');
const { badRequest, notFound } = require('../utils/errors');
const { newId } = require('../utils/ids');
const { importQaXlsx } = require('../services/qaImportService');
const { autoLinkAll } = require('../services/qaTzLinkService');

exports.import = async (req, res) => {
  if (!req.file) throw badRequest('Файл не передан');
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const result = await importQaXlsx(tenderId, req.file.path);
  res.status(201).json({ ok: true, ...result });
};

exports.listQa = async (req, res) => {
  const items = await db.queryAll('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC', req.params.id);
  res.json({ items });
};

exports.listCharacteristics = async (req, res) => {
  const items = await db.queryAll('SELECT * FROM characteristics WHERE tender_id = ? ORDER BY name ASC', req.params.id);
  res.json({ items });
};

const QA_PATCH_FIELDS = [
  'tz_clause',
  'tz_reflected',
  'tz_contradicts',
  'affects_calc',
  'affects_kp',
  'affects_contract',
  'affects_schedule',
  'accepted_decision',
];

exports.autoLink = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const overwrite = !!(req.body && req.body.overwrite);
  const result = await autoLinkAll(tenderId, { overwrite });
  if (result.reason === 'no_tz') {
    throw badRequest('В тендере не загружен ТЗ (doc_type=tz). Авто-привязка невозможна.');
  }
  res.json(result);
};

exports.patchQaEntry = async (req, res) => {
  const { id, entryId } = req.params;
  const existing = await db.queryOne('SELECT id FROM qa_entries WHERE id = ? AND tender_id = ?', entryId, id);
  if (!existing) throw notFound('Запись Q&A не найдена');
  const data = {};
  for (const f of QA_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
      const v = req.body[f];
      if (f === 'tz_clause' || f === 'accepted_decision') {
        data[f] = v == null ? null : String(v);
      } else {
        data[f] = v ? 1 : 0;
      }
    }
  }
  if (!Object.keys(data).length) {
    return res.json(await db.queryOne('SELECT * FROM qa_entries WHERE id = ?', entryId));
  }
  const sets = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  await db.queryRun(`UPDATE qa_entries SET ${sets} WHERE id = ?`, ...Object.values(data), entryId);
  res.json(await db.queryOne('SELECT * FROM qa_entries WHERE id = ?', entryId));
};

exports.createCharacteristic = async (req, res) => {
  const tenderId = req.params.id;
  const tender = await db.queryOne('SELECT id FROM tenders WHERE id = ?', tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const name = (req.body && req.body.name != null) ? String(req.body.name) : '';
  const value = (req.body && req.body.value != null) ? String(req.body.value) : null;
  const comment = (req.body && req.body.comment != null) ? String(req.body.comment) : null;
  if (!name.trim()) throw badRequest('Название характеристики обязательно');
  const id = newId();
  await db.queryRun(
    'INSERT INTO characteristics (id, tender_id, name, value, comment) VALUES (?, ?, ?, ?, ?)',
    id, tenderId, name, value, comment,
  );
  res.status(201).json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
};

exports.deleteCharacteristic = async (req, res) => {
  const id = req.params.charId;
  const existing = await db.queryOne('SELECT id FROM characteristics WHERE id = ?', id);
  if (!existing) throw notFound('Характеристика не найдена');
  await db.queryRun('DELETE FROM characteristics WHERE id = ?', id);
  res.status(204).end();
};

exports.patchCharacteristic = async (req, res) => {
  const id = req.params.charId;
  const existing = await db.queryOne('SELECT id FROM characteristics WHERE id = ?', id);
  if (!existing) throw notFound('Характеристика не найдена');
  const fields = ['name', 'value', 'source', 'comment'];
  const data = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) data[f] = req.body[f];
  if (!Object.keys(data).length) {
    return res.json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
  }
  const sets = Object.keys(data)
    .map((k) => `${k} = ?`)
    .join(', ');
  await db.queryRun(`UPDATE characteristics SET ${sets} WHERE id = ?`, ...Object.values(data), id);
  res.json(await db.queryOne('SELECT * FROM characteristics WHERE id = ?', id));
};
