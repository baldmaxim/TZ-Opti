'use strict';

// Слой signals — первый шаг новой архитектуры анализа ТЗ.
// Стадии 1..4 эмитят сигналы ПАРАЛЛЕЛЬНО с issues, не меняя issue/review/export.
// Запись изолирована: своя транзакция + перехват ошибок, чтобы сбой слоя signals
// никогда не ронял стадию и не откатывал issues.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');

// Стадия -> тип сигнала. Стадия 5 (самоанализ) пока не эмитит сигналов:
// в схеме слоя для неё нет типа (добавим на следующих шагах архитектуры).
const STAGE_SIGNAL_TYPE = {
  1: 'coverage',
  2: 'decision',
  3: 'condition',
  4: 'risk',
};

function signalTypeForStage(stage) {
  return STAGE_SIGNAL_TYPE[stage] || null;
}

// Строит запись сигнала из находки стадии (issue) + сохранённого id этой issue.
function buildSignal({ tenderId, runId, stage, issueId, issue }) {
  const signalType = signalTypeForStage(stage);
  if (!signalType) return null;
  const payload = {
    problem_type: issue.problem_type || null,
    risk_category: issue.risk_category || null,
    criticality: issue.criticality || 'medium',
    suggested_action: issue.suggested_action || null,
    suggested_redaction: issue.suggested_redaction || null,
    basis: issue.basis || null,
    review_comment: issue.review_comment || null,
    paragraph_index: issue.paragraph_index ?? null,
    char_start: issue.char_start ?? null,
    char_end: issue.char_end ?? null,
    section_path: issue.section_path || null,
    source_clause: issue.source_clause || null,
  };
  return {
    id: newId(),
    tenderId,
    runId: runId || null,
    stage,
    signalType,
    sourceEntityType: 'issue',
    sourceEntityId: issueId || null,
    tzClause: issue.section_path || issue.source_clause || null,
    sourceFragment: issue.source_fragment || null,
    payloadJson: JSON.stringify(payload),
    weight: typeof issue.confidence === 'number' ? issue.confidence : 0.6,
    createdAt: nowIso(),
  };
}

// Параллельная запись слоя signals для одной стадии.
// records: [{ issueId, issue }] — id уже сохранённых issue + сами находки.
// Best-effort: своя транзакция, ошибки только логируются (стадия не падает).
async function writeSignalsForStage({ tenderId, runId, stage, records }) {
  if (!signalTypeForStage(stage)) return { written: 0, skipped: true };
  const signals = (records || [])
    .map((r) => buildSignal({ tenderId, runId, stage, issueId: r.issueId, issue: r.issue }))
    .filter(Boolean);
  try {
    await db.transaction(async (tx) => {
      // Идемпотентность повторного прогона стадии: чистим прежние сигналы этой стадии.
      await tx.queryRun(
        `DELETE FROM analysis_signals WHERE tender_id = ? AND analysis_stage = ?`,
        tenderId,
        stage,
      );
      for (const s of signals) {
        await tx.queryRun(
          `INSERT INTO analysis_signals (
             id, tender_id, analysis_run_id, analysis_stage, signal_type,
             source_entity_type, source_entity_id, tz_clause, source_fragment,
             signal_payload_json, weight, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          s.id, s.tenderId, s.runId, s.stage, s.signalType,
          s.sourceEntityType, s.sourceEntityId, s.tzClause, s.sourceFragment,
          s.payloadJson, s.weight, s.createdAt,
        );
      }
    });
    return { written: signals.length };
  } catch (err) {
    // Слой signals не критичен для issue-пайплайна — не валим стадию, только лог.
    // eslint-disable-next-line no-console
    console.warn(
      `[signals] стадия ${stage}: не удалось записать сигналы (${signals.length}) — ${err.message}`,
    );
    return { written: 0, error: err.message };
  }
}

// Backfill: восстановить слой signals из уже существующих issues стадий 1–4.
// Нужен, когда стадии прогонялись раньше (issues есть), а сигналы не записались
// (или были очищены): новый кластерный конвейер читает только signals, и без них
// draft_issues/clusters пустые. Берём те же поля и тот же маппинг, что и живой
// прогон (writeSignalsForStage) — без повторного прогона LLM. Возвращает счётчики.
async function backfillSignalsFromIssues(tenderId) {
  const perStage = {};
  let total = 0;
  for (const stage of [1, 2, 3, 4]) {
    const issues = await db.queryAll(
      `SELECT * FROM issues WHERE tender_id = ? AND analysis_stage = ?`,
      tenderId,
      stage,
    );
    const records = issues.map((i) => ({ issueId: i.id, issue: i }));
    const res = await writeSignalsForStage({ tenderId, runId: null, stage, records });
    perStage[stage] = res.written || 0;
    total += res.written || 0;
  }
  return { written: total, by_stage: perStage };
}

// Чтение сигналов по тендеру (+ опциональный фильтр по типу) для API/дебага.
async function listSignals(tenderId, { signalType } = {}) {
  const params = [tenderId];
  let sql = `SELECT * FROM analysis_signals WHERE tender_id = ?`;
  if (signalType) {
    sql += ` AND signal_type = ?`;
    params.push(signalType);
  }
  sql += ` ORDER BY analysis_stage ASC, created_at ASC`;
  return db.queryAll(sql, ...params);
}

module.exports = { signalTypeForStage, buildSignal, writeSignalsForStage, backfillSignalsFromIssues, listSignals };
