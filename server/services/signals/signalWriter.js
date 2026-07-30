'use strict';

// Слой signals — первый шаг новой архитектуры анализа ТЗ.
// Стадии 1..4 эмитят сигналы ПАРАЛЛЕЛЬНО с issues, не меняя issue/review/export.
// Запись изолирована: своя транзакция + перехват ошибок, чтобы сбой слоя signals
// никогда не ронял стадию и не откатывал issues.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');

// Стадия -> тип сигнала. Стадия 5 эмитит сигналы challenger-находок
// (независимый поиск пропусков, pipeline/challengerStep): его цитатные находки
// идут в конвейер тем же путём, что у стадий 1–4. QC-заметки самоанализа
// сигналов по-прежнему не порождают (они пишутся в self_analysis_results).
const STAGE_SIGNAL_TYPE = {
  1: 'coverage',
  2: 'decision',
  3: 'condition',
  4: 'risk',
  5: 'challenger',
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

// --- Нормализация входа --------------------------------------------------------

// На вход принимаем и готовые строки сигналов (buildSignal), и записи стадии
// { issueId, issue }: писать может как движок сразу после сохранения issues, так
// и backfill из уже существующих строк.
function isSignalRow(item) {
  return !!item && (typeof item.payloadJson === 'string' || !!item.signalType);
}

function buildSignalRows({ tenderId, analysisRunId, stage, items }) {
  const rows = [];
  for (const item of items || []) {
    if (!item) continue;
    const row = isSignalRow(item)
      ? item
      : buildSignal({
        tenderId, runId: analysisRunId, stage,
        issueId: item.issueId ?? item.id ?? null,
        issue: item.issue || item,
      });
    if (row) rows.push(row);
  }
  return rows;
}

function signalsError(message, code = 'SIGNALS_WRITE_FAILED') {
  const err = new Error(`[signals] ${message}`);
  err.code = code;
  return err;
}

// ПРИВЯЗКА К ПРОГОНУ — проверяется у КАЖДОЙ строки, а не один раз на пачку.
// Сигнал без analysis_run_id (или с чужим) не попадает ни в один снимок: чтения
// берут только сигналы актуальных stage-прогонов (getActiveStageRunIds), поэтому
// такая строка — молча потерянная находка. В strict это ошибка публикации;
// в legacy — предупреждение + приведение к прогону-владельцу (как раньше).
function ensureRunScope(rows, analysisRunId, { stage, strict }) {
  if (!analysisRunId) {
    const msg = `стадия ${stage}: analysis_run_id не передан — сигналы не принадлежат ни одному снимку`;
    if (strict) throw signalsError(msg, 'SIGNALS_RUN_ID_REQUIRED');
    // eslint-disable-next-line no-console
    console.warn(`[signals] ${msg}`);
    return rows;
  }
  const scoped = [];
  for (const row of rows) {
    if (row.runId && row.runId !== analysisRunId) {
      const msg = `стадия ${stage}: сигнал ${row.id} привязан к чужому прогону ${row.runId} `
        + `(прогон-владелец ${analysisRunId})`;
      if (strict) throw signalsError(msg, 'SIGNALS_RUN_ID_MISMATCH');
      // eslint-disable-next-line no-console
      console.warn(`[signals] ${msg}`);
    }
    scoped.push(row.runId === analysisRunId ? row : { ...row, runId: analysisRunId });
  }
  return scoped;
}

// --- Запись --------------------------------------------------------------------

// exec — исполнитель запросов: переданная транзакция или своя. ВСЕ запросы идут
// через него: при tx запись живёт и падает вместе с транзакцией вызывающего.
async function insertSignals(exec, { tenderId, analysisRunId, rows }) {
  // Неизменяемый снимок: сигналы пишутся с analysis_run_id нового stage-прогона,
  // прежние прогоны НЕ удаляются (архив). Идемпотентность — в пределах ПРОГОНА:
  // чистим только сигналы этого прогона (повторная запись того же прогона), чтения
  // берут лишь сигналы актуальных stage-прогонов (getActiveStageRunIds).
  if (analysisRunId) {
    await exec.queryRun(
      `DELETE FROM analysis_signals WHERE tender_id = ? AND analysis_run_id = ?`,
      tenderId, analysisRunId,
    );
  }
  for (const s of rows) {
    // eslint-disable-next-line no-await-in-loop
    await exec.queryRun(
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
  return rows.length;
}

// Запись слоя signals для одной стадии.
//
//   tenderId, stage  — чей снимок и чья стадия;
//   analysisRunId    — ПРОГОН-ВЛАДЕЛЕЦ строк (алиас runId — старая форма вызова);
//   signals          — строки сигналов ИЛИ записи стадии [{ issueId, issue }]
//                      (алиас records — старая форма вызова);
//   tx               — транзакция вызывающего: если передана, ВСЕ запросы идут
//                      только через неё (своей транзакции слой не открывает);
//   strict           — режим публикации: SQL-ошибки НЕ перехватываются, ложного
//                      успеха не возвращается, ошибка уходит вызывающему.
//
// strict=false — legacy-режим (прежнее поведение: своя транзакция, ошибка только
// логируется, стадия не падает). Он остаётся ради существующих вызовов, но каждый
// такой вызов помечается предупреждением: снимок стадии может быть активирован
// без сигналов, и это молчаливая потеря находок.
async function writeSignalsForStage({
  tenderId,
  stage,
  analysisRunId = null,
  runId = null, // legacy-имя того же параметра
  signals = null,
  records = null, // legacy-имя того же параметра
  tx = null,
  strict = false,
} = {}) {
  const rid = analysisRunId || runId || null;
  if (!signalTypeForStage(stage)) return { written: 0, skipped: true, run_id: rid };

  const rows = ensureRunScope(
    buildSignalRows({ tenderId, analysisRunId: rid, stage, items: signals || records || [] }),
    rid,
    { stage, strict },
  );

  if (strict) {
    // Ошибки не глушим и результат не подменяем: неудачная запись сигналов
    // обязана дойти до вызывающего (снимок без сигналов публиковать нельзя).
    const written = tx
      ? await insertSignals(tx, { tenderId, analysisRunId: rid, rows })
      : await db.transaction((t) => insertSignals(t, { tenderId, analysisRunId: rid, rows }));
    return { written, run_id: rid, strict: true };
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[signals] стадия ${stage}: запись сигналов в legacy-режиме (strict=false) — `
      + `сбой будет проглочен, снимок ${rid || '(без прогона)'} может остаться без сигналов`,
  );
  try {
    const written = tx
      ? await insertSignals(tx, { tenderId, analysisRunId: rid, rows })
      : await db.transaction((t) => insertSignals(t, { tenderId, analysisRunId: rid, rows }));
    return { written, run_id: rid };
  } catch (err) {
    // Слой signals не критичен для issue-пайплайна — не валим стадию, только лог.
    // eslint-disable-next-line no-console
    console.warn(
      `[signals] стадия ${stage}: не удалось записать сигналы (${rows.length}) — ${err.message}`,
    );
    return { written: 0, error: err.message, run_id: rid };
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
    // Backfill остаётся best-effort (strict=false): он чинит уже существующий
    // снимок, а не публикует новый — падать на одной стадии здесь нечего.
    const res = await writeSignalsForStage({
      tenderId, stage, analysisRunId: runId, signals: records,
    });
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
