'use strict';

const db = require('../db/connection');
const { newId } = require('../utils/ids');
const { notFound, badRequest } = require('../utils/errors');
const { renderConditions } = require('../services/conditionsRenderer');
const { getOrCreate } = require('./setupParamsController');

async function getOverlayMap(tenderId) {
  const rows = await db.queryAll(
    'SELECT condition_idx, text_override, comment, criticality FROM company_conditions WHERE tender_id = ? AND condition_idx IS NOT NULL',
    tenderId,
  );
  const out = new Map();
  for (const r of rows) out.set(r.condition_idx, r);
  return out;
}

async function upsertOverlay(tenderId, idx, name, patch) {
  const existing = await db.queryOne(
    'SELECT id FROM company_conditions WHERE tender_id = ? AND condition_idx = ?',
    tenderId,
    idx,
  );
  if (existing) {
    const sets = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'text_override')) {
      sets.push('text_override = ?');
      params.push(patch.text_override);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'comment')) {
      sets.push('comment = ?');
      params.push(patch.comment);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'criticality')) {
      sets.push('criticality = ?');
      params.push(patch.criticality);
    }
    if (sets.length) {
      params.push(existing.id);
      await db.queryRun(`UPDATE company_conditions SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }
  } else {
    await db.queryRun(
      `
      INSERT INTO company_conditions (id, tender_id, condition_idx, condition, category, text_override, comment, criticality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      newId(),
      tenderId,
      idx,
      name || '',
      'template',
      patch.text_override ?? null,
      patch.comment ?? null,
      patch.criticality ?? 'medium',
    );
  }
}

exports.list = async (req, res) => {
  const { kind, row: params } = await getOrCreate(req.params.id);
  const rendered = renderConditions(kind, params);
  const overlay = await getOverlayMap(req.params.id);
  const items = rendered.map((c) => {
    const o = overlay.get(c.idx);
    return {
      ...c,
      text_template: c.text,
      text: o && o.text_override != null ? o.text_override : c.text,
      isOverridden: !!(o && o.text_override != null && o.text_override !== ''),
      comment: o ? o.comment || '' : '',
      criticality: o ? o.criticality || null : null,
    };
  });
  res.json({ kind, items });
};

exports.patch = async (req, res) => {
  const idx = Number(req.params.idx);
  if (!Number.isFinite(idx) || idx <= 0) throw badRequest('Некорректный idx');
  const { kind, row: params } = await getOrCreate(req.params.id);
  const rendered = renderConditions(kind, params);
  const tpl = rendered.find((c) => c.idx === idx);
  if (!tpl) throw notFound('Условие не найдено в шаблоне');

  const body = req.body || {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'text_override')) {
    let v = body.text_override;
    if (v === undefined) v = null;
    patch.text_override = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'comment')) patch.comment = body.comment ?? null;
  if (Object.prototype.hasOwnProperty.call(body, 'criticality')) patch.criticality = body.criticality ?? null;

  if (Object.keys(patch).length === 0) {
    return res.json({ ok: true });
  }

  await upsertOverlay(req.params.id, idx, tpl.name, patch);
  res.json({ ok: true });
};

exports.removeOverride = async (req, res) => {
  const idx = Number(req.params.idx);
  if (!Number.isFinite(idx) || idx <= 0) throw badRequest('Некорректный idx');
  await db.queryRun(
    'UPDATE company_conditions SET text_override = NULL WHERE tender_id = ? AND condition_idx = ?',
    req.params.id,
    idx,
  );
  res.json({ ok: true });
};

exports.reset = async (req, res) => {
  await db.queryRun('DELETE FROM company_conditions WHERE tender_id = ?', req.params.id);
  res.json({ ok: true });
};
