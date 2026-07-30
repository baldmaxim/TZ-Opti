'use strict';

// Матрица покрытия существенных условий — DB-слой.
//
// Две таблицы с разными жизненными циклами:
//   condition_coverage           — снимок агента: одна строка на
//     (analysis_run_id, topic_key), пишется Стадией 3 в СВОЙ прогон и не
//     переписывается (история прогонов сохраняется, как у issues);
//   condition_coverage_overrides — знание ИНЖЕНЕРА per tender (переживает
//     прогоны): «есть только в другом документе», «требует проверки проекта
//     договора», «неприменимо к данному тендеру» + выбранное действие.
// Чтение (getCoverage) отдаёт снимок актуального прогона Стадии 3 с наложенными
// override: статус инженера главнее статуса агента.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const audit = require('../audit/auditService');
const {
  COVERAGE_STATUSES,
  RESOLUTIONS,
  STATUS_LABELS,
  RESOLUTION_LABELS,
} = require('../stageAnalysis/conditionCoverage');

// Снимок покрытия прогона: replace всей матрицы ЭТОГО прогона в одной
// транзакции (повторная запись того же прогона идемпотентна).
async function saveCoverage(tenderId, analysisRunId, rows) {
  if (!analysisRunId || !Array.isArray(rows)) return { saved: 0 };
  const createdAt = nowIso();
  await db.transaction(async (tx) => {
    await tx.queryRun('DELETE FROM condition_coverage WHERE analysis_run_id = ?', analysisRunId);
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(
        `INSERT INTO condition_coverage
           (id, tender_id, analysis_run_id, topic_key, topic_name, kind, status,
            evidence, resolution, criticality, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, analysisRunId, r.topic_key, r.name, r.kind, r.status,
        JSON.stringify(r.evidence || []), r.resolution || null, r.criticality || null, createdAt,
      );
    }
  });
  return { saved: rows.length };
}

async function getOverrides(tenderId) {
  const rows = await db.queryAll(
    'SELECT * FROM condition_coverage_overrides WHERE tender_id = ?',
    tenderId,
  );
  return new Map(rows.map((r) => [r.topic_key, r]));
}

function parseEvidence(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (_e) { return []; }
}

// Матрица покрытия тендера: снимок актуального (или явно указанного) прогона
// Стадии 3 + override инженера поверх. run_id=null и пустая матрица — валидный
// ответ («Стадия 3 ещё не считалась с покрытием»), не ошибка.
async function getCoverage(tenderId, { runId = null } = {}) {
  const effectiveRunId = runId || (await analysisRuns.getActiveStageRunId(tenderId, 3));
  const rows = effectiveRunId
    ? await db.queryAll(
      `SELECT * FROM condition_coverage
        WHERE tender_id = ? AND analysis_run_id = ?
        ORDER BY kind ASC, topic_name ASC`,
      tenderId, effectiveRunId,
    )
    : [];
  const overrides = await getOverrides(tenderId);

  const items = rows.map((r) => {
    const ov = overrides.get(r.topic_key) || null;
    const status = (ov && ov.status) || r.status;
    return {
      topic_key: r.topic_key,
      topic_name: r.topic_name,
      kind: r.kind,
      agent_status: r.status,
      status,
      status_label: STATUS_LABELS[status] || status,
      resolution: (ov && ov.resolution) || r.resolution || null,
      resolution_label: RESOLUTION_LABELS[(ov && ov.resolution) || r.resolution] || null,
      criticality: r.criticality || null,
      evidence: parseEvidence(r.evidence),
      override: ov
        ? { status: ov.status, resolution: ov.resolution, note: ov.note, updated_at: ov.updated_at, updated_by: ov.updated_by }
        : null,
    };
  });

  const summary = {};
  for (const it of items) summary[it.status] = (summary[it.status] || 0) + 1;
  return { run_id: effectiveRunId, items, summary };
}

// Инженерский override темы: статус (полный словарь) и/или действие. Пустой
// статус и действие → override снимается.
async function setOverride(tenderId, topicKey, { status = null, resolution = null, note = null } = {}, actor = null) {
  const st = status ? String(status).trim().toLowerCase() : null;
  const rs = resolution ? String(resolution).trim().toLowerCase() : null;
  if (st && !COVERAGE_STATUSES.includes(st)) {
    throw badRequest(`Недопустимый статус покрытия: «${status}» (ожидается ${COVERAGE_STATUSES.join(' | ')})`);
  }
  if (rs && !RESOLUTIONS.includes(rs)) {
    throw badRequest(`Недопустимое действие: «${resolution}» (ожидается ${RESOLUTIONS.join(' | ')})`);
  }

  if (!st && !rs && !note) {
    await db.queryRun(
      'DELETE FROM condition_coverage_overrides WHERE tender_id = ? AND topic_key = ?',
      tenderId, topicKey,
    );
  } else {
    const existing = await db.queryOne(
      'SELECT id FROM condition_coverage_overrides WHERE tender_id = ? AND topic_key = ?',
      tenderId, topicKey,
    );
    if (existing) {
      await db.queryRun(
        `UPDATE condition_coverage_overrides
            SET status = ?, resolution = ?, note = ?, updated_at = ?, updated_by = ?
          WHERE id = ?`,
        st, rs, note || null, nowIso(), (actor && actor.subject) || null, existing.id,
      );
    } else {
      await db.queryRun(
        `INSERT INTO condition_coverage_overrides
           (id, tender_id, topic_key, status, resolution, note, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), tenderId, topicKey, st, rs, note || null, nowIso(), (actor && actor.subject) || null,
      );
    }
  }

  await audit.record({
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'conditions.coverage.override',
    category: 'write',
    outcome: 'allowed',
    tenderId,
    resourceType: 'conditions',
    resourceId: topicKey,
    meta: { status: st, resolution: rs },
  }).catch(() => {});

  return getCoverage(tenderId);
}

module.exports = { saveCoverage, getCoverage, getOverrides, setOverride };
