'use strict';

// Карта сопоставления «требование ТЗ ↔ позиции ВОР» — DB-слой поверх чистого
// ядра requirementMatchModel.js.
//
// Две таблицы с разными жизненными циклами (по образцу condition_coverage):
//   requirement_matches               — снимок агента: одна строка на
//     (analysis_run_id стадии 1, match_key), история прогонов сохраняется;
//   requirement_match_confirmations   — решение ИНЖЕНЕРА per tender (переживает
//     прогоны, ключ — стабильный хэш цитаты требования): подтверждено /
//     отклонено / скорректировано + заметка.
// Чтение (getMatches) отдаёт снимок актуального прогона Стадии 1 с наложенными
// подтверждениями.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const audit = require('../audit/auditService');
const {
  CONFIRM_STATUSES,
  STATUS_LABELS,
  CONFIRM_LABELS,
} = require('./requirementMatchModel');

async function saveMatches(tenderId, analysisRunId, rows) {
  if (!analysisRunId || !Array.isArray(rows)) return { saved: 0 };
  const createdAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.queryRun('DELETE FROM requirement_matches WHERE analysis_run_id = ?', analysisRunId);
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(
        `INSERT INTO requirement_matches
           (id, tender_id, analysis_run_id, match_key, requirement_fragment, section_path,
            coverage_status, problem_type, positions, operations_included, operations_missing,
            exclusions, unit_note, quantity_note, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, analysisRunId, r.match_key, r.requirement_fragment, r.section_path,
        r.coverage_status, r.problem_type || null,
        JSON.stringify(r.positions || []),
        JSON.stringify(r.operations_included || []),
        JSON.stringify(r.operations_missing || []),
        JSON.stringify(r.exclusions || []),
        r.unit_note || null, r.quantity_note || null, r.confidence, createdAt,
      );
    }
  });
  return { saved: rows.length };
}

const parseJson = (raw, fallback) => {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_e) { return fallback; }
};

async function getConfirmations(tenderId) {
  const rows = await db.queryAll(
    'SELECT * FROM requirement_match_confirmations WHERE tender_id = ?', tenderId,
  );
  return new Map(rows.map((r) => [r.match_key, r]));
}

// Карта тендера: снимок актуального (или указанного) прогона Стадии 1 +
// подтверждения инженера поверх. run_id=null и пустая карта — валидный ответ.
async function getMatches(tenderId, { runId = null } = {}) {
  const effectiveRunId = runId || (await analysisRuns.getActiveStageRunId(tenderId, 1));
  const rows = effectiveRunId
    ? await db.queryAll(
      `SELECT * FROM requirement_matches
        WHERE tender_id = ? AND analysis_run_id = ?
        ORDER BY coverage_status DESC, requirement_fragment ASC`,
      tenderId, effectiveRunId,
    )
    : [];
  const confirmations = await getConfirmations(tenderId);

  const items = rows.map((r) => {
    const c = confirmations.get(r.match_key) || null;
    return {
      match_key: r.match_key,
      requirement_fragment: r.requirement_fragment,
      section_path: r.section_path,
      coverage_status: r.coverage_status,
      coverage_label: STATUS_LABELS[r.coverage_status] || r.coverage_status,
      problem_type: r.problem_type,
      positions: parseJson(r.positions, []),
      operations_included: parseJson(r.operations_included, []),
      operations_missing: parseJson(r.operations_missing, []),
      exclusions: parseJson(r.exclusions, []),
      unit_note: r.unit_note,
      quantity_note: r.quantity_note,
      confidence: r.confidence == null ? null : Number(r.confidence),
      confirmation: c
        ? {
          status: c.status,
          label: CONFIRM_LABELS[c.status] || c.status,
          note: c.note,
          updated_at: c.updated_at,
          updated_by: c.updated_by,
        }
        : null,
    };
  });

  const summary = {};
  for (const it of items) summary[it.coverage_status] = (summary[it.coverage_status] || 0) + 1;
  summary.confirmed = items.filter((i) => i.confirmation && i.confirmation.status === 'confirmed').length;
  return { run_id: effectiveRunId, items, summary };
}

// Решение инженера по связи. Пустые status+note снимают подтверждение.
async function setConfirmation(tenderId, matchKey, { status = null, note = null } = {}, actor = null) {
  const st = status ? String(status).trim().toLowerCase() : null;
  if (st && !CONFIRM_STATUSES.includes(st)) {
    throw badRequest(`Недопустимый статус подтверждения: «${status}» (ожидается ${CONFIRM_STATUSES.join(' | ')})`);
  }
  if (!st && !note) {
    await db.queryRun(
      'DELETE FROM requirement_match_confirmations WHERE tender_id = ? AND match_key = ?',
      tenderId, matchKey,
    );
  } else {
    const existing = await db.queryOne(
      'SELECT id FROM requirement_match_confirmations WHERE tender_id = ? AND match_key = ?',
      tenderId, matchKey,
    );
    if (existing) {
      await db.queryRun(
        `UPDATE requirement_match_confirmations
            SET status = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        st || 'adjusted', note || null, nowIso(), (actor && actor.subject) || null, existing.id,
      );
    } else {
      await db.queryRun(
        `INSERT INTO requirement_match_confirmations
           (id, tender_id, match_key, status, note, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, matchKey, st || 'adjusted', note || null, nowIso(),
        (actor && actor.subject) || null,
      );
    }
  }

  await audit.record({
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'vor.requirement_match.confirm',
    category: 'decision',
    outcome: 'allowed',
    tenderId,
    resourceType: 'vor',
    resourceId: matchKey,
    meta: { status: st },
  }).catch(() => {});

  return getMatches(tenderId);
}

module.exports = { saveMatches, getMatches, setConfirmation };
