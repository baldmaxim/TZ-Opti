'use strict';

// ШАГ КОНВЕЙЕРА «challenger» — независимый поиск пропусков основных стадий.
//
// Идёт ПОСЛЕ кластеризации (ему нужен собранный итог «что уже найдено») и ДО
// self-analysis QC. Что делает:
//   1. читает кластеры прогона-кандидата (итог шагов draft → critic → clustering);
//   2. сканирует исходный ТЗ challenger-агентом (stage5Challenger): цитатные
//      находки, НЕ покрытые собранным итогом;
//   3. публикует находки ШТАТНЫМ снимком Стадии 5 (issues + сигналы + активация
//      указателя stage:5) — publishStageResult, как у стадий-добытчиков;
//   4. если находки есть — ПЕРЕСОБИРАЕТ слои кандидата (draft_issues → critic →
//      clustering): сигналы стадии 5 входят в набор активных stage-прогонов, и
//      пропуски становятся ОБЫЧНЫМИ замечаниями — со статусом, вердиктом критика,
//      кластером и решением инженера, а не заметкой в debug-контуре.
//
// Цена: повторная сборка слоёв (в т.ч. повторные LLM-вызовы precision-критика по
// спорным) — поэтому шаг ОПЦИОНАЛЬНЫЙ (withChallenger) и включается вместе с
// самоанализом в основном потоке «Анализ ТЗ».
//
// Сбой сканера/публикации — сбой шага (fail-loud, как у стадий 1–4): прогон
// стадии 5 закрывается failed, шаг конвейера падает, указатели целы.

const db = require('../../db/connection');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { getTzText } = require('../tzActiveTextService');
const { runChallengerScan } = require('../stageAnalysis/stage5Challenger');
const { publishStageResult } = require('../stageAnalysis/publishStageResult');
const { makeStageSegmentStore, finalizeRunSegments } = require('../stageAnalysis/segments/segmentStore');
const { getStageState } = require('../stageAnalysis/stageState');
const { isConfigured } = require('../stageAnalysis/llm/openaiClient');
const { STATUS } = require('../analysis/resultStatus');
const unified = require('../unifiedAnalysis/unifiedIssueBuilder');
const critic = require('../critic/criticService');
const clustering = require('../clustering/clusteringService');

const CHALLENGER_STAGE = 5;

// Исходный документ ТЗ для FK-ссылок issues (как buildContextForStage движка):
// синтетический документ согласованной версии ('agr:…') в documents не существует.
async function resolveSourceDocumentId(tzDoc) {
  if (!tzDoc) return null;
  if (!tzDoc.agreed_version_id) return tzDoc.id;
  if (!tzDoc.base_document_id) return null;
  const base = await db.queryOne('SELECT id FROM documents WHERE id = ?', tzDoc.base_document_id);
  return base ? base.id : null;
}

// Пересборка производных слоёв кандидата с учётом сигналов стадии 5. Билдеры
// идемпотентны в пределах прогона (DELETE+INSERT по runId), прогон ещё running —
// страж assertRunWritable внутри каждого пропустит запись.
async function rebuildLayers(tenderId, pipelineRunId) {
  await unified.buildDraftIssues(tenderId, pipelineRunId);
  await critic.buildIssueReviews(tenderId, pipelineRunId);
  await clustering.buildClusters(tenderId, pipelineRunId);
}

// Раннер шага конвейера: (tenderId, pipelineRunId) → { summary }.
async function runChallengerStep(tenderId, pipelineRunId) {
  if (!isConfigured()) {
    const err = new Error('OPENAI_API_KEY не настроен — challenger-агент недоступен.');
    err.status = 400;
    throw err;
  }
  const tz = await getTzText(tenderId);
  if (tz.missingMd || !tz.document) {
    const err = new Error('Нет .md ТЗ — challenger-агенту нечего сканировать.');
    err.status = 400;
    throw err;
  }

  // Итог, который challenger обязан НЕ повторять, — кластеры ЭТОГО кандидата.
  const clusters = await clustering.listClusters(tenderId, 'full', pipelineRunId);

  // Снимок стадии 5: прогон создаётся ДО работы (как у всех стадий), части ТЗ
  // пишут историю в него. Кэш частей отделён от кэша QC-шага суффиксом ревизии —
  // оба живут в analysis_segments со stage=5, но проверяют разное.
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(tenderId);
  const configVersion = analysisRuns.currentConfigVersion();
  const stageRunId = await analysisRuns.beginRun(tenderId, analysisRuns.stageScope(CHALLENGER_STAGE), {
    stage: CHALLENGER_STAGE, documentsRevisionId, configVersion,
  });
  await db.queryRun(
    'UPDATE analysis_runs SET summary = ? WHERE id = ?',
    JSON.stringify({ stage: CHALLENGER_STAGE, status: 'running', reason: `challenger pipeline=${pipelineRunId}` }),
    stageRunId,
  );
  await analysisRuns.interruptStaleStageRuns(tenderId, CHALLENGER_STAGE, {
    exceptRunId: stageRunId,
    reason: `прогон оборван: challenger начал новый прогон ${stageRunId}`,
  });

  const segmentStore = makeStageSegmentStore({
    tenderId,
    stage: CHALLENGER_STAGE,
    revisionId: tz.revisionId ? `${tz.revisionId}#challenger` : null,
    configVersion,
    runId: stageRunId,
    logTag: 'challenger_segments',
  });

  let issues;
  let publication;
  try {
    issues = await runChallengerScan({
      tenderId,
      blocks: tz.blocks,
      sourceDocumentId: await resolveSourceDocumentId(tz.document),
      analysisRunId: stageRunId,
      segmentStore,
    }, clusters);

    const stageSummary = {
      stage: CHALLENGER_STAGE,
      status: STATUS.COMPLETED,
      result_type: 'Challenger — пропуски основных стадий',
      issues_count: issues.length,
      covered_clusters: clusters.length,
      dropped_covered: issues.droppedCovered || 0,
      segmentation: issues.segmentation || null,
      pipeline_run_id: pipelineRunId,
    };

    // Строка stage-состояния может отсутствовать (тендер без workflow) — создаём.
    await getStageState(tenderId);
    publication = await db.transaction(async (tx) => {
      // publishStageResult переводит стадию строго 'running' → 'reviewing' —
      // выравниваем статус ТОЙ ЖЕ транзакцией (откат публикации вернёт прежний).
      await tx.queryRun(
        `UPDATE tender_stage_state SET stage5_status = 'running', current_stage = ?
          WHERE tender_id = ? AND stage5_status <> 'running'`,
        CHALLENGER_STAGE, tenderId,
      );
      return publishStageResult({
        tx,
        tenderId,
        stage: CHALLENGER_STAGE,
        analysisRunId: stageRunId,
        issues,
        signals: (records) => records,
        summary: stageSummary,
        documentsRevisionId,
        configVersion,
      });
    });
  } catch (err) {
    // Fail-loud: прогон стадии 5 закрывается failed, шаг конвейера падает.
    await finalizeRunSegments(stageRunId, { reason: `challenger не завершён: ${err.message}` }).catch(() => {});
    await analysisRuns.finalizeRun(stageRunId, {
      status: STATUS.FAILED,
      summary: { stage: CHALLENGER_STAGE, status: STATUS.FAILED, failed: true, error: err.message },
    }).catch(() => {});
    throw err;
  }

  // Пропуски найдены — включаем их в снимок кандидата пересборкой слоёв.
  // Ничего не нашлось — пересборка не нужна (сигналов не прибавилось), но
  // снимок стадии 5 опубликован: «проверено независимо, пропусков нет» — тоже
  // результат, и он виден в истории прогонов.
  const rebuilt = issues.length > 0;
  if (rebuilt) await rebuildLayers(tenderId, pipelineRunId);

  return {
    summary: {
      status: STATUS.COMPLETED,
      stage_run_id: stageRunId,
      found: issues.length,
      published: publication.issues_written,
      signals: (publication.signals && publication.signals.written) || 0,
      covered_clusters: clusters.length,
      dropped_covered: issues.droppedCovered || 0,
      rebuilt,
      segmentation: issues.segmentation || null,
    },
  };
}

module.exports = { runChallengerStep, rebuildLayers, CHALLENGER_STAGE };
