'use strict';

const db = require('../db/connection');
const { nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');
const {
  defaultsFor,
  getParamsSchema,
  tenderTypeToContractKind,
} = require('../services/conditionsRenderer');
const { PARAMS_SCHEMA } = require('../db/conditionsTemplate');

function getTender(tenderId) {
  return db.prepare('SELECT id, type FROM tenders WHERE id = ?').get(tenderId);
}

function getStored(tenderId) {
  return db.prepare('SELECT * FROM tender_setup_params WHERE tender_id = ?').get(tenderId);
}

function getOrCreate(tenderId) {
  const tender = getTender(tenderId);
  if (!tender) throw notFound('Тендер не найден');
  const kind = tenderTypeToContractKind(tender.type);
  let row = getStored(tenderId);
  if (!row) {
    const def = defaultsFor(kind);
    db.prepare(`
      INSERT INTO tender_setup_params (tender_id, contract_kind, escalation, advance, build_months, transfer_months, kp_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenderId,
      kind,
      def.escalation || null,
      def.advance || null,
      def.build_months || null,
      def.transfer_months || null,
      def.kp_date || null,
      nowIso()
    );
    row = getStored(tenderId);
  } else if (row.contract_kind !== kind) {
    // Тип тендера сменили — пересинхронизируем kind, но сохраняем введённые числа/даты.
    const def = defaultsFor(kind);
    const allowedEsc = PARAMS_SCHEMA[kind].find((f) => f.key === 'escalation').options;
    const newEsc = allowedEsc.includes(row.escalation) ? row.escalation : def.escalation;
    const newAdvance = kind === 'gen' ? (row.advance || def.advance) : null;
    db.prepare(`
      UPDATE tender_setup_params
      SET contract_kind = ?, escalation = ?, advance = ?, updated_at = ?
      WHERE tender_id = ?
    `).run(kind, newEsc, newAdvance, nowIso(), tenderId);
    row = getStored(tenderId);
  }
  return { tender, kind, row };
}

exports.getParams = (req, res) => {
  const { kind, row } = getOrCreate(req.params.id);
  res.json({ kind, params: row });
};

exports.updateParams = (req, res) => {
  const { kind } = getOrCreate(req.params.id);
  const body = req.body || {};
  const schema = getParamsSchema(kind);
  const fields = ['escalation', 'advance', 'build_months', 'transfer_months', 'kp_date'];
  const updates = [];
  const values = [];

  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
    const meta = schema.find((s) => s.key === f);
    if (!meta) {
      // advance для shell — игнорим (поле не в схеме)
      if (kind === 'shell' && f === 'advance') {
        updates.push('advance = NULL');
        continue;
      }
      continue;
    }
    let v = body[f];
    if (v === '' || v === undefined) v = null;
    if (meta.kind === 'enum' && v != null && !meta.options.includes(v)) {
      throw badRequest(`Недопустимое значение для ${f}: ${v}. Допустимые: ${meta.options.join(', ')}`);
    }
    if (meta.kind === 'int' && v != null) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`Поле ${f} должно быть положительным числом`);
      v = Math.round(n);
    }
    if (meta.kind === 'date' && v != null) {
      const d = new Date(v);
      if (Number.isNaN(d.valueOf())) throw badRequest(`Поле ${f} — некорректная дата`);
      v = v.length > 10 ? v.slice(0, 10) : v;
    }
    updates.push(`${f} = ?`);
    values.push(v);
  }

  if (kind === 'shell') {
    // advance в shell всегда NULL — на случай мусора
    updates.push('advance = NULL');
  }

  if (updates.length) {
    updates.push('updated_at = ?');
    values.push(nowIso());
    values.push(req.params.id);
    db.prepare(`UPDATE tender_setup_params SET ${updates.join(', ')} WHERE tender_id = ?`).run(...values);
  }

  const row = getStored(req.params.id);
  res.json({ kind, params: row });
};

exports.getSchema = (req, res) => {
  const { kind } = getOrCreate(req.params.id);
  res.json({ kind, schema: getParamsSchema(kind) });
};

exports.getOrCreate = getOrCreate;
