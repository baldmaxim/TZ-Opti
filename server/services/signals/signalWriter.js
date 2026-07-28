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
    // Полный абзац ТЗ (context_text из llmStage.buildIssue) — сохраняем в
    // payload, чтобы не потерять контекст цитаты (source_fragment теперь = точная
    // цитата, а не весь абзац). Backfill из issues его не несёт (нет колонки).
    context_text: issue.context_text || null,
    section_path: issue.section_path || null,
    source_clause: issue.source_clause || null,
    // Оценка материальности от агента стадии (llmStage.buildIssue): impact/
    // evidence/измерения/флаг «не материально». В таблице issues колонок под них
    // нет — путь в конвейер идёт ЧЕРЕЗ payload сигнала, поэтому backfill из
    // issues их не несёт (сервер тогда считает всё сам, fail-closed).
    impact_level: issue.impact_level || null,
    evidence_level: issue.evidence_level || null,
    impact_dimensions: Array.isArray(issue.impact_dimensions) ? issue.impact_dimensions : [],
    materiality_flags: Array.isArray(issue.materiality_flags) ? issue.materiality_flags : [],
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
      // Неизменяемый снимок: сигналы пишутся с analysis_run_id нового stage-прогона,
      // прежние прогоны НЕ удаляются (архив). Идемпотентность — в пределах ПРОГОНА:
      // чистим только сигналы этого runId (повторная запись того же прогона), чтения
      // берут лишь сигналы актуальных stage-прогонов (getActiveStageRunIds).
      if (runId) {
        await tx.queryRun(
          `DELETE FROM analysis_signals WHERE tender_id = ? AND analysis_run_id = ?`,
          tenderId, runId,
        );
      }
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
  // Лениво, чтобы не жёстко связывать слой signals с реестром прогонов.
  const { getActiveStageRunId } = require('../analysisRuns/analysisRunsService');
  const perStage = {};
  let total = 0;
  for (const stage of [1, 2, 3, 4]) {
    // Сигналы восстанавливаем из issues АКТУАЛЬНОГО stage-прогона и привязываем к нему.
    const runId = await getActiveStageRunId(tenderId, stage);
    if (!runId) { perStage[stage] = 0; continue; }
    const issues = await db.queryAll(
      `SELECT * FROM issues WHERE tender_id = ? AND analysis_stage = ? AND analysis_run_id = ?`,
      tenderId,
      stage,
      runId,
    );
    const records = issues.map((i) => ({ issueId: i.id, issue: i }));
    const res = await writeSignalsForStage({ tenderId, runId, stage, records });
    perStage[stage] = res.written || 0;
    total += res.written || 0;
  }
  return { written: total, by_stage: perStage };
}

// Чтение сигналов АКТУАЛЬНЫХ stage-прогонов (+ опц. фильтр по типу) для API/дебага.
async function listSignals(tenderId, { signalType } = {}) {
  const { getActiveStageRunIds } = require('../analysisRuns/analysisRunsService');
  const stageRunIds = await getActiveStageRunIds(tenderId);
  if (!stageRunIds.length) return [];
  const params = [tenderId, ...stageRunIds];
  let sql = `SELECT * FROM analysis_signals
    WHERE tender_id = ? AND analysis_run_id IN (${stageRunIds.map(() => '?').join(', ')})`;
  if (signalType) {
    sql += ` AND signal_type = ?`;
    params.push(signalType);
  }
  sql += ` ORDER BY analysis_stage ASC, created_at ASC`;
  return db.queryAll(sql, ...params);
}

module.exports = { signalTypeForStage, buildSignal, writeSignalsForStage, backfillSignalsFromIssues, listSignals };
