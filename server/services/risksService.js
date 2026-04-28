'use strict';

const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { STANDARD_RISKS } = require('../db/standardRisks');
const { tenderTypeToContractKind } = require('./conditionsRenderer');
const { findInParagraphs, normalize } = require('./stageAnalysis/shared/fragmentMatcher');
const { getActiveTzText } = require('./tzActiveTextService');

const CUSTOM_PREFIX = 'custom:';

function autoAppliesFor(risk, ctx) {
  const w = risk.applies_when;
  if (!w) return true;
  if (w.contract_kind && w.contract_kind !== ctx.contract_kind) return false;
  if (w.escalation && w.escalation !== ctx.escalation) return false;
  if (w.advance && w.advance !== ctx.advance) return false;
  return true;
}

function getTenderCtx(tenderId) {
  const tender = db.prepare('SELECT id, type FROM tenders WHERE id = ?').get(tenderId);
  if (!tender) return null;
  const params = db.prepare('SELECT * FROM tender_setup_params WHERE tender_id = ?').get(tenderId);
  return {
    contract_kind: tenderTypeToContractKind(tender.type),
    escalation: params ? params.escalation : null,
    advance: params ? params.advance : null,
  };
}

function getStateMap(tenderId) {
  const rows = db
    .prepare('SELECT risk_key, applies, comment FROM tender_risk_state WHERE tender_id = ?')
    .all(tenderId);
  const out = new Map();
  for (const r of rows) out.set(r.risk_key, r);
  return out;
}

function loadCustomRisks(tenderId) {
  const rows = db
    .prepare('SELECT * FROM tender_custom_risks WHERE tender_id = ? ORDER BY created_at ASC')
    .all(tenderId);
  return rows.map((r) => {
    let triggers = [];
    if (r.triggers) {
      try { triggers = JSON.parse(r.triggers); }
      catch (_e) { triggers = String(r.triggers).split(/[\n,]/).map((s) => s.trim()).filter(Boolean); }
    }
    return {
      id: r.id,
      key: CUSTOM_PREFIX + r.id,
      category: r.category || 'Прочее',
      risk_text: r.risk_text,
      triggers,
      recommendation: '',
      criticality: r.criticality || 'medium',
      applies_when: null,
      is_custom: true,
    };
  });
}

function listForTender(tenderId) {
  const ctx = getTenderCtx(tenderId);
  if (!ctx) return [];
  const state = getStateMap(tenderId);
  const std = STANDARD_RISKS.map((r) => ({
    key: r.key,
    category: r.category,
    risk_text: r.risk_text,
    triggers: r.triggers || [],
    recommendation: r.recommendation,
    criticality: r.criticality,
    applies_when: r.applies_when || null,
    is_custom: false,
  }));
  const custom = loadCustomRisks(tenderId);
  return [...std, ...custom].map((r) => {
    const apply_default = autoAppliesFor(r, ctx);
    const s = state.get(r.key);
    const applies = s ? s.applies : null;
    const effective = applies != null ? applies === 1 : apply_default;
    return {
      key: r.key,
      category: r.category,
      risk_text: r.risk_text,
      triggers: r.triggers || [],
      recommendation: r.recommendation,
      criticality: r.criticality,
      applies_when: r.applies_when || null,
      is_custom: !!r.is_custom,
      custom_id: r.is_custom ? r.id : null,
      apply_default,
      applies,
      effective,
      comment: s ? s.comment || '' : '',
    };
  });
}

function patchState(tenderId, riskKey, patch) {
  const isCustom = riskKey.startsWith(CUSTOM_PREFIX);
  const known = isCustom
    ? db.prepare('SELECT id FROM tender_custom_risks WHERE id = ? AND tender_id = ?')
        .get(riskKey.slice(CUSTOM_PREFIX.length), tenderId)
    : STANDARD_RISKS.find((r) => r.key === riskKey);
  if (!known) {
    const err = new Error('Неизвестный risk_key: ' + riskKey);
    err.status = 400;
    throw err;
  }
  const existing = db
    .prepare('SELECT * FROM tender_risk_state WHERE tender_id = ? AND risk_key = ?')
    .get(tenderId, riskKey);

  let applies = existing ? existing.applies : null;
  let comment = existing ? existing.comment : null;
  if (Object.prototype.hasOwnProperty.call(patch, 'applies')) {
    const v = patch.applies;
    if (v === null || v === undefined || v === '') applies = null;
    else if (v === 1 || v === 0) applies = v;
    else if (v === true) applies = 1;
    else if (v === false) applies = 0;
    else applies = v ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'comment')) {
    comment = patch.comment ?? null;
  }

  if (existing) {
    db.prepare(`
      UPDATE tender_risk_state SET applies = ?, comment = ?, updated_at = ?
      WHERE tender_id = ? AND risk_key = ?
    `).run(applies, comment, nowIso(), tenderId, riskKey);
  } else {
    db.prepare(`
      INSERT INTO tender_risk_state (tender_id, risk_key, applies, comment, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenderId, riskKey, applies, comment, nowIso());
  }
}

function reset(tenderId) {
  db.prepare('DELETE FROM tender_risk_state WHERE tender_id = ?').run(tenderId);
}

function createCustom(tenderId, data) {
  const risk_text = (data.risk_text || '').trim();
  if (!risk_text) {
    const err = new Error('Поле risk_text обязательно');
    err.status = 400;
    throw err;
  }
  const category = (data.category || 'Прочее').trim() || 'Прочее';
  const criticality = ['low', 'medium', 'high', 'critical'].includes(data.criticality)
    ? data.criticality : 'medium';

  let triggers = [];
  if (Array.isArray(data.triggers)) {
    triggers = data.triggers.map((t) => String(t || '').trim()).filter(Boolean);
  } else if (typeof data.triggers === 'string') {
    triggers = data.triggers.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }

  const id = newId();
  db.prepare(`
    INSERT INTO tender_custom_risks (id, tender_id, category, risk_text, triggers, criticality, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenderId, category, risk_text, JSON.stringify(triggers), criticality, nowIso());
  return id;
}

function removeCustom(tenderId, customId) {
  // Подчистить overlay по этому ключу.
  db.prepare('DELETE FROM tender_risk_state WHERE tender_id = ? AND risk_key = ?')
    .run(tenderId, CUSTOM_PREFIX + customId);
  const r = db
    .prepare('DELETE FROM tender_custom_risks WHERE id = ? AND tender_id = ?')
    .run(customId, tenderId);
  return r.changes > 0;
}

function getMatches(tenderId) {
  const tz = getActiveTzText(tenderId, 99);
  if (!tz.document) return {};
  const out = {};
  const tzNorm = normalize(tz.activeText || '');
  const all = [
    ...STANDARD_RISKS.map((r) => ({ key: r.key, triggers: r.triggers || [] })),
    ...loadCustomRisks(tenderId).map((r) => ({ key: r.key, triggers: r.triggers || [] })),
  ];
  for (const r of all) {
    let total = 0;
    const samples = [];
    for (const trig of r.triggers) {
      if (!trig) continue;
      if (!tzNorm.includes(normalize(trig))) continue;
      const hits = findInParagraphs(tz.paragraphs, trig);
      total += hits.length;
      for (const h of hits) {
        if (samples.length < 3) {
          samples.push({
            paragraph_index: h.paragraph_index,
            fragment: h.fragment,
            full_paragraph: (h.full_paragraph || '').slice(0, 200),
          });
        }
      }
    }
    if (total > 0) out[r.key] = { count: total, samples };
  }
  return out;
}

module.exports = {
  listForTender,
  patchState,
  reset,
  createCustom,
  removeCustom,
  getMatches,
};
