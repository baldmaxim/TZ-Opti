'use strict';

// SHADOW-РЕЖИМ квалификационного gate (findingQualificationGate) в
// production-процессе.
//
// Что делает: после того как конвейер сформировал ИТОГОВЫЕ замечания
// (issue_clusters прогона), gate НЕЗАВИСИМО квалифицирует каждое —
// publish | review | hide | reject — и результат сохраняется в
// finding_qualifications. Решение инженера по shadow-оценке (accepted /
// accepted_with_edit / rejected / deferred / merged + структурированная
// причина) пишется в finding_qualification_decisions и сравнивается с gate.
//
// ЖЁСТКИЕ ИНВАРИАНТЫ SHADOW-РЕЖИМА:
//   • состав, статус, порядок и приоритет публикуемых замечаний НЕ меняются:
//     сервис пишет ТОЛЬКО в свои две таблицы (никаких UPDATE production-слоёв);
//   • active pointer, решения critic, review_decisions и экспорт не трогаются;
//   • сбой gate НЕ ломает анализ: evaluateRunSafe глотает любую ошибку,
//     пишет её в audit (diagnostics) и помечает оценки evaluation_failed;
//   • повторная оценка НЕ перезаписывает старые строки (уникальный ключ
//     (analysis_run_id, cluster_id, gate_version) + ON CONFLICT DO NOTHING);
//     переоценить прогон можно только НОВОЙ версией gate (rerun);
//   • вход gate — ОБЯЗАТЕЛЬНЫЙ Markdown ТЗ (tzActiveTextService): без .md
//     оценка честно становится evaluation_failed, а не считается по суррогату.
//
// Чистое ядро (маппинг кластера в находку gate, строки оценок, валидация
// override) тестируется офлайн; статистика — qualificationStats.js.

const db = require('../../db/connection');
const audit = require('../audit/auditService');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest, notFound } = require('../../utils/errors');
const { qualifyFindings } = require('./findingQualificationGate');
const stats = require('./qualificationStats');

// Версия алгоритма gate. Менять при ЛЮБОМ изменении правил/сигналов gate —
// оценки разных версий сосуществуют и сравниваются, старые не перезаписываются.
const GATE_VERSION = 'fq-gate-v1';

const EVALUATION_FAILED = stats.EVALUATION_FAILED;

const ENGINEER_DECISIONS = Object.freeze([
  'accepted', 'accepted_with_edit', 'rejected', 'deferred', 'merged',
]);
const DECISIONS_REQUIRING_REASON = Object.freeze(['rejected', 'accepted_with_edit']);
const OVERRIDE_REASON_CODES = Object.freeze([
  'no_material_impact',
  'already_covered_by_vor',
  'standard_requirement',
  'incorrect_interpretation',
  'insufficient_evidence',
  'duplicate',
  'outside_tender_scope',
  'too_minor',
  'wrong_priority',
  'wrong_action',
  'other',
]);

// Kill-switch продакшн-хука (сам shadow-режим): '0' выключает вызов gate из
// конвейера. Прямые вызовы API (rerun) флаг не читают — они явные.
function shadowEnabled(env = process.env) {
  return String(env.QUALIFICATION_GATE_SHADOW ?? '1').trim() !== '0';
}

// --- Чистое ядро ---------------------------------------------------------------

function parseJsonArray(raw, fallback = []) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch (_e) {
    return fallback;
  }
}

// Кластер (+ его primary draft_issue) → находка в формате gate. Только чтение:
// входные объекты не мутируются (shadow mode).
function clusterToGateFinding(cluster, primaryDraft = {}, index = 0) {
  const p = primaryDraft || {};
  return {
    id: cluster.id,
    rank: index + 1,
    quote: p.source_fragment || cluster.representative_fragment || '',
    summary: cluster.cluster_title || p.review_comment || '',
    basis: cluster.merged_basis || p.basis || '',
    problem_type: cluster.final_problem_type || p.problem_type || '',
    category: p.category || null,
    impact_dimensions: parseJsonArray(cluster.impact_dimensions, null) || undefined,
    required_action: cluster.required_action || p.suggested_action || null,
    impact_level: cluster.overall_impact_level || null,
  };
}

// Приоритет production-снимка кластера для сравнения с proposed_priority gate.
function productionPriorityOf(cluster) {
  return cluster.overall_impact_level || cluster.overall_criticality || null;
}

// Строка shadow-оценки из решения gate. evaluated_at/gate_version приходят из
// контекста — одна партия оценок получает одинаковую метку.
function buildEvaluationRow(cluster, gateDecision, ctx = {}) {
  return {
    id: ctx.id || null,
    tender_id: cluster.tender_id,
    analysis_run_id: ctx.runId,
    cluster_id: cluster.id,
    cluster_key: cluster.cluster_key || null,
    gate_version: ctx.gateVersion || GATE_VERSION,
    qualification: gateDecision.qualification,
    proposed_priority: gateDecision.priority || null,
    confidence: gateDecision.confidence ?? null,
    evidence_strength: gateDecision.evidence_strength || null,
    impact_types: JSON.stringify(gateDecision.impact_types || []),
    source_strength: gateDecision.source_strength ?? null,
    missing_requirements: JSON.stringify(gateDecision.missing_requirements || []),
    reasons: JSON.stringify(gateDecision.reasons || []),
    score_breakdown: JSON.stringify(gateDecision.score_breakdown || {}),
    rule_key: gateDecision.rule || null,
    production_verdict: cluster.verdict || null,
    production_priority: productionPriorityOf(cluster),
    category: cluster.final_problem_type || null,
    source_stages: JSON.stringify(ctx.sourceStages || []),
    error: null,
    evaluated_at: ctx.evaluatedAt || nowIso(),
  };
}

// Строка «оценка не посчиталась»: замечание сохраняется как есть, quality-слой
// честно фиксирует сбой (требование 2 ТЗ).
function failedEvaluationRow(cluster, ctx = {}) {
  const message = String(ctx.error || 'gate evaluation failed');
  return {
    id: ctx.id || null,
    tender_id: cluster.tender_id,
    analysis_run_id: ctx.runId,
    cluster_id: cluster.id,
    cluster_key: cluster.cluster_key || null,
    gate_version: ctx.gateVersion || GATE_VERSION,
    qualification: EVALUATION_FAILED,
    proposed_priority: null,
    confidence: null,
    evidence_strength: null,
    impact_types: JSON.stringify([]),
    source_strength: null,
    missing_requirements: JSON.stringify([]),
    reasons: JSON.stringify([message]),
    score_breakdown: JSON.stringify({}),
    rule_key: null,
    production_verdict: cluster.verdict || null,
    production_priority: productionPriorityOf(cluster),
    category: cluster.final_problem_type || null,
    source_stages: JSON.stringify(ctx.sourceStages || []),
    error: message,
    evaluated_at: ctx.evaluatedAt || nowIso(),
  };
}

// Валидация решения инженера по shadow-оценке. Возвращает нормализованное тело
// либо бросает badRequest (структурированная причина ОБЯЗАТЕЛЬНА для rejected и
// accepted_with_edit).
function validateOverride(body = {}) {
  const decision = String(body.decision || '').trim();
  if (!ENGINEER_DECISIONS.includes(decision)) {
    throw badRequest(`Допустимые решения: ${ENGINEER_DECISIONS.join(', ')}`);
  }
  const reasonCode = (body.reason_code || '').toString().trim() || null;
  if (DECISIONS_REQUIRING_REASON.includes(decision)) {
    if (!reasonCode) {
      throw badRequest(`Для «${decision}» обязательна структурированная причина (reason_code)`);
    }
    if (!OVERRIDE_REASON_CODES.includes(reasonCode)) {
      throw badRequest(`Допустимые причины: ${OVERRIDE_REASON_CODES.join(', ')}`);
    }
  }
  const finalText = (body.final_text || '').toString().trim() || null;
  if (decision === 'accepted_with_edit' && !finalText) {
    throw badRequest('Для «accepted_with_edit» обязательна финальная редакция (final_text)');
  }
  return {
    decision,
    reason_code: reasonCode,
    final_text: finalText,
    comment: (body.comment || '').toString().trim() || null,
  };
}

// Разбор строки finding_qualifications: JSON-поля → значения.
function parseEvaluationRow(row) {
  if (!row) return row;
  return {
    ...row,
    impact_types: parseJsonArray(row.impact_types),
    missing_requirements: parseJsonArray(row.missing_requirements),
    reasons: parseJsonArray(row.reasons),
    score_breakdown: (() => {
      try { return row.score_breakdown ? JSON.parse(row.score_breakdown) : {}; } catch (_e) { return {}; }
    })(),
    source_stages: parseJsonArray(row.source_stages),
  };
}

// --- DB: загрузка контекста прогона ---------------------------------------------

async function requireRun(tenderId, runId) {
  const run = await db.queryOne(
    'SELECT id, tender_id, kind, status FROM analysis_runs WHERE id = ? AND tender_id = ?',
    runId, tenderId,
  );
  if (!run) throw notFound('Прогон анализа не найден');
  return run;
}

async function loadClustersForRun(tenderId, runId) {
  return db.queryAll(
    `SELECT * FROM issue_clusters
      WHERE tender_id = ? AND analysis_run_id = ?
      ORDER BY paragraph_index ASC NULLS LAST, created_at ASC, id ASC`,
    tenderId, runId,
  );
}

async function loadPrimaryDrafts(clusterIds) {
  const map = new Map();
  if (!clusterIds.length) return map;
  const ph = clusterIds.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT ci.cluster_id, d.*
       FROM issue_cluster_items ci
       JOIN draft_issues d ON d.id = ci.draft_issue_id
      WHERE ci.cluster_id IN (${ph}) AND ci.item_role = 'primary'`,
    ...clusterIds,
  );
  for (const r of rows) map.set(r.cluster_id, r);
  return map;
}

// Стадии 1–4, породившие кластер: cluster → draft_issues → signal ids → стадии.
// Best-effort: сбой этого справочного шага не должен ронять оценку.
async function loadSourceStages(clusterIds) {
  const map = new Map();
  if (!clusterIds.length) return map;
  try {
    const ph = clusterIds.map(() => '?').join(', ');
    const items = await db.queryAll(
      `SELECT ci.cluster_id, d.created_from_signal_ids
         FROM issue_cluster_items ci
         JOIN draft_issues d ON d.id = ci.draft_issue_id
        WHERE ci.cluster_id IN (${ph})`,
      ...clusterIds,
    );
    const signalIds = new Set();
    const idsByCluster = new Map();
    for (const it of items) {
      const ids = parseJsonArray(it.created_from_signal_ids);
      for (const id of ids) signalIds.add(id);
      if (!idsByCluster.has(it.cluster_id)) idsByCluster.set(it.cluster_id, []);
      idsByCluster.get(it.cluster_id).push(...ids);
    }
    const stageBySignal = new Map();
    const all = [...signalIds];
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const cph = chunk.map(() => '?').join(', ');
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.queryAll(
        `SELECT id, analysis_stage FROM analysis_signals WHERE id IN (${cph})`,
        ...chunk,
      );
      for (const r of rows) {
        if (r.analysis_stage != null) stageBySignal.set(r.id, Number(r.analysis_stage));
      }
    }
    for (const [clusterId, ids] of idsByCluster) {
      const set = new Set();
      for (const id of ids) if (stageBySignal.has(id)) set.add(stageBySignal.get(id));
      map.set(clusterId, [...set].sort((a, b) => a - b));
    }
  } catch (err) {
    console.error(`[qualification] стадии-источники не загружены: ${err.message}`);
  }
  return map;
}

// Вставка партии оценок. НИКОГДА не перезаписывает: конфликт по
// (analysis_run_id, cluster_id, gate_version) молча пропускается (требование 5).
async function insertEvaluations(rows) {
  let inserted = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const res = await db.queryRun(
      `INSERT INTO finding_qualifications
         (id, tender_id, analysis_run_id, cluster_id, cluster_key, gate_version,
          qualification, proposed_priority, confidence, evidence_strength,
          impact_types, source_strength, missing_requirements, reasons,
          score_breakdown, rule_key, production_verdict, production_priority,
          category, source_stages, error, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (analysis_run_id, cluster_id, gate_version) DO NOTHING`,
      row.id || newId(), row.tender_id, row.analysis_run_id, row.cluster_id,
      row.cluster_key, row.gate_version, row.qualification, row.proposed_priority,
      row.confidence, row.evidence_strength, row.impact_types, row.source_strength,
      row.missing_requirements, row.reasons, row.score_breakdown, row.rule_key,
      row.production_verdict, row.production_priority, row.category,
      row.source_stages, row.error, row.evaluated_at,
    );
    inserted += Number(res.changes || 0);
  }
  return inserted;
}

// --- Оценка прогона ---------------------------------------------------------------

// Оценить все итоговые замечания (кластеры) прогона версией gate.
// Read-only к production; пишет ТОЛЬКО finding_qualifications. Существующие
// оценки той же версии сохраняются как есть (evaluated=0 для них).
async function evaluateRun(tenderId, runId, { gateVersion = GATE_VERSION, trigger = 'api' } = {}) {
  // Ленивая загрузка: tzActiveTextService тянет mdParser — не грузим на импорте.
  // eslint-disable-next-line global-require
  const { getActiveTzText } = require('../tzActiveTextService');

  await requireRun(tenderId, runId);
  const clusters = await loadClustersForRun(tenderId, runId);
  const summary = {
    run_id: runId, gate_version: gateVersion, total: clusters.length,
    evaluated: 0, skipped_existing: 0, failed: 0,
  };
  if (!clusters.length) return summary;

  const existing = new Set(
    (await db.queryAll(
      'SELECT cluster_id FROM finding_qualifications WHERE analysis_run_id = ? AND gate_version = ?',
      runId, gateVersion,
    )).map((r) => r.cluster_id),
  );
  const pending = clusters.filter((c) => !existing.has(c.id));
  summary.skipped_existing = clusters.length - pending.length;
  if (!pending.length) return summary;

  const ids = clusters.map((c) => c.id);
  const [primaries, stages] = await Promise.all([loadPrimaryDrafts(ids), loadSourceStages(ids)]);
  const evaluatedAt = nowIso();
  const ctxFor = (c) => ({
    runId, gateVersion, evaluatedAt, sourceStages: stages.get(c.id) || [],
  });

  // ОБЯЗАТЕЛЬНЫЙ Markdown-вход: без .md ТЗ gate не считается по суррогату —
  // оценка фиксируется как evaluation_failed с явной причиной.
  const tz = await getActiveTzText(tenderId);
  let rows = null;
  if (tz.missingMd) {
    rows = pending.map((c) => failedEvaluationRow(c, {
      ...ctxFor(c), error: 'TZ_MD_MISSING: .md-документ ТЗ не загружен — вход gate обязателен',
    }));
  } else {
    // Gate видит ВСЕ кластеры прогона (междунаходочная проверка дублей), но
    // сохраняются только недостающие строки этой версии.
    let decisions = null;
    try {
      const findings = clusters.map((c, i) => clusterToGateFinding(c, primaries.get(c.id), i));
      decisions = qualifyFindings(findings, { sourceText: tz.rawText || '' });
    } catch (err) {
      rows = pending.map((c) => failedEvaluationRow(c, { ...ctxFor(c), error: err.message }));
    }
    if (!rows) {
      const byId = new Map(decisions.map((d) => [d.finding_id, d]));
      rows = pending.map((c) => {
        const d = byId.get(c.id);
        if (!d) return failedEvaluationRow(c, { ...ctxFor(c), error: 'gate не вернул решение по находке' });
        try {
          return buildEvaluationRow(c, d, ctxFor(c));
        } catch (err) {
          return failedEvaluationRow(c, { ...ctxFor(c), error: err.message });
        }
      });
    }
  }

  summary.failed = rows.filter((r) => r.qualification === EVALUATION_FAILED).length;
  summary.evaluated = await insertEvaluations(rows);

  // Диагностика: успех — обычная запись; частичный сбой оценок — отдельная
  // error-запись (best-effort, audit не ломает вызов).
  await audit.record({
    action: 'qualification.gate.evaluate', category: 'analysis',
    outcome: summary.failed ? 'error' : 'allowed',
    tenderId, resourceType: 'qualification', resourceId: runId,
    reason: summary.failed ? `оценок не посчиталось: ${summary.failed}` : null,
    meta: { ...summary, trigger },
  });
  return summary;
}

// Пометить оценки прогона evaluation_failed (после сбоя evaluateRun): только
// недостающие строки, существующие оценки не трогаются.
async function markRunEvaluationFailed(tenderId, runId, gateVersion, message) {
  const clusters = await loadClustersForRun(tenderId, runId);
  if (!clusters.length) return 0;
  const evaluatedAt = nowIso();
  const rows = clusters.map((c) => failedEvaluationRow(c, {
    runId, gateVersion, evaluatedAt, error: message,
  }));
  return insertEvaluations(rows);
}

// Best-effort обёртка для вызова из production-конвейера: ЛЮБАЯ ошибка gate
// глотается (замечания уже сохранены production-путём), уходит в audit и
// помечает оценки evaluation_failed. Анализ не ломается никогда (требование 2).
async function evaluateRunSafe(tenderId, runId, opts = {}) {
  if (!shadowEnabled()) return { skipped: true, reason: 'QUALIFICATION_GATE_SHADOW=0' };
  const gateVersion = opts.gateVersion || GATE_VERSION;
  try {
    return await evaluateRun(tenderId, runId, { gateVersion, trigger: opts.trigger || 'pipeline' });
  } catch (err) {
    console.error(`[qualification] shadow gate не выполнен (run ${runId}): ${err.message}`);
    try {
      await audit.record({
        action: 'qualification.gate.error', category: 'analysis', outcome: 'error',
        tenderId, resourceType: 'qualification', resourceId: runId,
        reason: err.message, meta: { gate_version: gateVersion, trigger: opts.trigger || 'pipeline' },
      });
    } catch (_e) { /* журнал недоступен — сбой уже в консоли */ }
    try {
      await markRunEvaluationFailed(tenderId, runId, gateVersion, err.message);
    } catch (_e) { /* БД недоступна — оценок не будет, анализ не трогаем */ }
    return { ok: false, error: err.message, run_id: runId, gate_version: gateVersion };
  }
}

// --- Чтение / решения инженера / статистика ---------------------------------------

async function resolveRunId(tenderId, runId) {
  if (runId) return runId;
  // eslint-disable-next-line global-require
  const analysisRuns = require('../analysisRuns/analysisRunsService');
  return analysisRuns.getActivePipelineRunId(tenderId);
}

// Версии gate, которыми оценивался прогон (свежие первыми).
async function listGateVersions(runId) {
  const rows = await db.queryAll(
    `SELECT gate_version, MAX(evaluated_at) AS last_evaluated_at, COUNT(*) AS c
       FROM finding_qualifications WHERE analysis_run_id = ?
      GROUP BY gate_version ORDER BY MAX(evaluated_at) DESC`,
    runId,
  );
  return rows.map((r) => ({
    gate_version: r.gate_version,
    last_evaluated_at: r.last_evaluated_at,
    count: Number(r.c) || 0,
  }));
}

async function loadDecisionsForRun(tenderId, runId) {
  return db.queryAll(
    `SELECT * FROM finding_qualification_decisions
      WHERE tender_id = ? AND analysis_run_id = ?
      ORDER BY decided_at ASC, id ASC`,
    tenderId, runId,
  );
}

// Shadow-оценки прогона (по умолчанию — активный прогон и последняя версия
// gate) + актуальное решение инженера на каждый кластер.
async function listEvaluations(tenderId, { runId = null, gateVersion = null } = {}) {
  const rid = await resolveRunId(tenderId, runId);
  if (!rid) return { run_id: null, gate_version: null, versions: [], items: [] };
  const versions = await listGateVersions(rid);
  const gv = gateVersion || (versions.length ? versions[0].gate_version : GATE_VERSION);
  const rows = await db.queryAll(
    `SELECT * FROM finding_qualifications
      WHERE tender_id = ? AND analysis_run_id = ? AND gate_version = ?
      ORDER BY evaluated_at ASC, cluster_id ASC`,
    tenderId, rid, gv,
  );
  const latest = stats.latestDecisionsByCluster(await loadDecisionsForRun(tenderId, rid));
  return {
    run_id: rid,
    gate_version: gv,
    versions,
    items: rows.map((r) => ({
      ...parseEvaluationRow(r),
      engineer_decision: latest.get(r.cluster_id) || null,
    })),
  };
}

// Одна shadow-оценка кластера: все версии gate + история решений инженера.
async function getEvaluation(tenderId, clusterId, { runId = null } = {}) {
  const cluster = await db.queryOne(
    'SELECT * FROM issue_clusters WHERE id = ? AND tender_id = ?', clusterId, tenderId,
  );
  const rid = await resolveRunId(tenderId, runId || (cluster && cluster.analysis_run_id));
  if (!rid) throw notFound('Прогон анализа не найден');
  const evaluations = await db.queryAll(
    `SELECT * FROM finding_qualifications
      WHERE tender_id = ? AND analysis_run_id = ? AND cluster_id = ?
      ORDER BY evaluated_at DESC, gate_version DESC`,
    tenderId, rid, clusterId,
  );
  const decisions = await db.queryAll(
    `SELECT * FROM finding_qualification_decisions
      WHERE tender_id = ? AND analysis_run_id = ? AND cluster_id = ?
      ORDER BY decided_at DESC, id DESC`,
    tenderId, rid, clusterId,
  );
  if (!evaluations.length && !cluster) throw notFound('Shadow-оценка не найдена');
  return {
    cluster_id: clusterId,
    run_id: rid,
    evaluations: evaluations.map(parseEvaluationRow),
    decisions,
  };
}

// Решение инженера по shadow-оценке. Append-only журнал СВОЕГО слоя:
// review_decisions (production-рецензия) не читается на запись и не меняется.
async function saveOverride(tenderId, clusterId, body = {}, actor = {}) {
  const norm = validateOverride(body);
  const cluster = await db.queryOne(
    'SELECT * FROM issue_clusters WHERE id = ? AND tender_id = ?', clusterId, tenderId,
  );
  if (!cluster) throw notFound('Кластер не найден');
  const runId = cluster.analysis_run_id;
  if (!runId) throw badRequest('Кластер без analysis_run_id — shadow-решение не к чему привязать');

  const versionCond = body.gate_version ? 'AND gate_version = ?' : '';
  const evalRow = await db.queryOne(
    `SELECT * FROM finding_qualifications
      WHERE analysis_run_id = ? AND cluster_id = ? ${versionCond}
      ORDER BY evaluated_at DESC LIMIT 1`,
    runId, clusterId, ...(body.gate_version ? [body.gate_version] : []),
  );

  const primaries = await loadPrimaryDrafts([clusterId]);
  const primary = primaries.get(clusterId) || {};
  const originalText = primary.suggested_redaction
    || cluster.merged_recommendation || cluster.representative_fragment || null;

  const row = {
    id: newId(),
    tender_id: tenderId,
    analysis_run_id: runId,
    cluster_id: clusterId,
    qualification_id: evalRow ? evalRow.id : null,
    gate_version: evalRow ? evalRow.gate_version : null,
    gate_qualification: evalRow ? evalRow.qualification : null,
    decision: norm.decision,
    reason_code: norm.reason_code,
    agrees_with_gate: stats.decisionAgreement(evalRow ? evalRow.qualification : null, norm.decision),
    original_text: originalText,
    final_text: norm.final_text,
    comment: norm.comment,
    decided_by: actor.subject || actor.sub || null,
    decided_by_email: actor.email || null,
    decided_at: nowIso(),
  };
  await db.queryRun(
    `INSERT INTO finding_qualification_decisions
       (id, tender_id, analysis_run_id, cluster_id, qualification_id, gate_version,
        gate_qualification, decision, reason_code, agrees_with_gate, original_text,
        final_text, comment, decided_by, decided_by_email, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.tender_id, row.analysis_run_id, row.cluster_id, row.qualification_id,
    row.gate_version, row.gate_qualification, row.decision, row.reason_code,
    row.agrees_with_gate == null ? null : Number(row.agrees_with_gate),
    row.original_text, row.final_text, row.comment,
    row.decided_by, row.decided_by_email, row.decided_at,
  );
  return { cluster_id: clusterId, run_id: runId, decision: row };
}

// Повторная оценка прогона (по умолчанию — активного) ЯВНО заданной или текущей
// версией gate. Исходные findings/кластеры не меняются; старые оценки не
// перезаписываются — та же версия лишь дозаполняет недостающие строки.
async function rerunGate(tenderId, { runId = null, gateVersion = null } = {}) {
  const rid = await resolveRunId(tenderId, runId);
  if (!rid) throw notFound('Активный прогон конвейера не найден');
  const gv = (gateVersion || '').toString().trim() || GATE_VERSION;
  return evaluateRun(tenderId, rid, { gateVersion: gv, trigger: 'rerun' });
}

// Агрегированная статистика прогона: квалификации gate × решения инженера.
async function runStats(tenderId, { runId = null, gateVersion = null } = {}) {
  const { run_id: rid, gate_version: gv, versions, items } =
    await listEvaluations(tenderId, { runId, gateVersion });
  if (!rid) return { run_id: null, gate_version: null, versions: [], stats: null };
  const decisions = await loadDecisionsForRun(tenderId, rid);
  return {
    run_id: rid,
    gate_version: gv,
    versions,
    stats: stats.computeRunStats({ evaluations: items, decisions }),
  };
}

module.exports = {
  // константы
  GATE_VERSION,
  EVALUATION_FAILED,
  ENGINEER_DECISIONS,
  DECISIONS_REQUIRING_REASON,
  OVERRIDE_REASON_CODES,
  // чистое ядро (офлайн-тесты)
  shadowEnabled,
  clusterToGateFinding,
  buildEvaluationRow,
  failedEvaluationRow,
  validateOverride,
  parseEvaluationRow,
  // DB
  evaluateRun,
  evaluateRunSafe,
  markRunEvaluationFailed,
  listEvaluations,
  getEvaluation,
  saveOverride,
  rerunGate,
  runStats,
};
