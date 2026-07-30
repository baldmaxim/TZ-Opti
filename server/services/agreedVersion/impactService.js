'use strict';

// КАРТА ЗАТРОНУТОГО (dry-run селективного пересчёта).
//
// Отвечает на вопрос «что придётся пересчитывать, если запустить анализ сейчас»
// (например, после активации согласованной версии ТЗ): для каждой стадии 1–4
// строится нарезка ТЕКУЩЕГО входа (planOnly-режим runLlmStage — без LLM, без
// записи плана и истории), и хэш каждой части сверяется с кэшем
// analysis_segments по input_hash (включая кэш ПРОШЛЫХ ревизий —
// getCompletedByHash). Часть с совпавшим хэшем поднимется из кэша без вызова
// модели; стадия, у которой таких частей все, «не затронута» — её прогон
// пройдёт целиком из кэша за секунды.
//
// ЭТО ОЦЕНКА, НЕ ГАРАНТИЯ: упаковка частей жадная по токенному бюджету —
// правка в части i может каскадно переупаковать хвост документа, и тогда
// пересчёта потребуют и части после первого изменения. UI обязан подписывать
// карту именно так.
//
// «Стадия не затронута» ≠ «стадию не запускать»: прогон всё равно нужен (новый
// снимок против новой ревизии, координаты локализуются заново) — просто он
// не потратит ни одного вызова модели.

const engine = require('../stageAnalysis/stageAnalysisEngine');
const segmentStore = require('../stageAnalysis/segments/segmentStore');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { runStage1Llm } = require('../stageAnalysis/stage1_llm');
const { runStage2Llm } = require('../stageAnalysis/stage2_llm');
const { runStage3Llm } = require('../stageAnalysis/stage3_llm');
const { runStage4Llm } = require('../stageAnalysis/stage4_llm');

const STAGE_RUNNERS = {
  1: runStage1Llm,
  2: runStage2Llm,
  3: runStage3Llm,
  4: runStage4Llm,
};

// Чистая свёртка: план нарезки + флаги «есть в кэше» → строка карты.
function summarizeStageImpact(stage, planSegments, cachedFlags) {
  const total = planSegments.length;
  let cached = 0;
  const toCompute = [];
  planSegments.forEach((s, i) => {
    if (cachedFlags[i]) cached += 1;
    else toCompute.push({ index: s.index, heading_path: s.heading_path, tokens: s.tokens });
  });
  return {
    stage,
    total,
    cached,
    to_compute: total - cached,
    affected: total - cached > 0,
    segments_to_compute: toCompute,
  };
}

// Карта по стадиям 1–4. Ничего не пишет и не зовёт LLM.
async function previewStagesImpact(tenderId) {
  const configVersion = analysisRuns.currentConfigVersion();
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(tenderId);
  const stages = [];
  for (const stage of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const ctx = await engine.buildContextForStage(tenderId, stage, { runId: null, configVersion });
    ctx.segmentStore = null; // ничего не писать
    ctx.planOnly = true;
    // eslint-disable-next-line no-await-in-loop
    await STAGE_RUNNERS[stage](ctx);
    const plan = (ctx.planReport && ctx.planReport.segments) || [];
    const cachedFlags = [];
    for (const s of plan) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await segmentStore.getCompletedByHash(tenderId, stage, s.input_hash, { configVersion });
      cachedFlags.push(Boolean(hit));
    }
    stages.push(summarizeStageImpact(stage, plan, cachedFlags));
  }
  const affected = stages.filter((s) => s.affected).map((s) => s.stage);
  return {
    documents_revision_id: documentsRevisionId,
    config_version: configVersion,
    stages,
    affected_stages: affected,
    total_to_compute: stages.reduce((sum, s) => sum + s.to_compute, 0),
    // Жадная упаковка частей: правка может каскадно сдвинуть нарезку хвоста —
    // карта показывает ОЦЕНКУ переиспользования, а не обещание.
    estimate: true,
  };
}

module.exports = {
  // чистое ядро (офлайн-тесты)
  summarizeStageImpact,
  // DB + сегментация
  previewStagesImpact,
};
