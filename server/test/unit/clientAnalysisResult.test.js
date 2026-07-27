'use strict';

// Клиентский контракт результата анализа (client/src/utils/analysisResult.js) —
// ЗЕРКАЛО server/services/analysis/resultStatus.js. Тест держит их согласованными
// и защищает п.12 аудита: клиент обязан различать completed,
// completed_with_warnings, failed, cancelled, interrupted (а не схлопывать
// отмену/обрыв/частичный итог в один исход). Импортируем ESM клиента напрямую.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT_UTIL = pathToFileURL(
  path.join(__dirname, '..', '..', '..', 'client', 'src', 'utils', 'analysisResult.js'),
).href;

// Серверный источник истины — сравниваем severity клиента с ним.
const server = require('../../services/analysis/resultStatus');

test('severityOf клиента совпадает с сервером для всех 5 статусов + unknown', async () => {
  const { severityOf, ANALYSIS_STATUS } = await import(CLIENT_UTIL);
  const cases = [
    ANALYSIS_STATUS.COMPLETED,
    ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
    ANALYSIS_STATUS.FAILED,
    ANALYSIS_STATUS.CANCELLED,
    ANALYSIS_STATUS.INTERRUPTED,
    'weird-unknown',
  ];
  for (const s of cases) {
    assert.equal(severityOf(s), server.severityOf(s), `severity расходится для «${s}»`);
  }
  // completed — единственный success; warnings — жёлтый; всё остальное — красный.
  assert.equal(severityOf(ANALYSIS_STATUS.COMPLETED), 'success');
  assert.equal(severityOf(ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS), 'warning');
  assert.equal(severityOf(ANALYSIS_STATUS.CANCELLED), 'error');
  assert.equal(severityOf(ANALYSIS_STATUS.INTERRUPTED), 'error');
});

test('stageOutcome: completed+summary.partial → warning; отмена/обрыв — свои исходы', async () => {
  const { stageOutcome, ANALYSIS_STATUS } = await import(CLIENT_UTIL);
  // Частичный QC: колонка completed, но контракт в summary — warning (дефект №1).
  assert.equal(
    stageOutcome({ status: 'completed', summary: { status: ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS } }),
    ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
  );
  assert.equal(stageOutcome({ status: 'completed', summary: { status: 'completed' } }), ANALYSIS_STATUS.COMPLETED);
  assert.equal(stageOutcome({ status: 'completed' }), ANALYSIS_STATUS.COMPLETED);
  // Отмена и обрыв — не схлопываются в failed (дефект №2, п.12).
  assert.equal(stageOutcome({ status: 'cancelled' }), ANALYSIS_STATUS.CANCELLED);
  assert.equal(stageOutcome({ status: 'interrupted' }), ANALYSIS_STATUS.INTERRUPTED);
  assert.equal(stageOutcome({ status: 'running' }), ANALYSIS_STATUS.INTERRUPTED);
  assert.equal(stageOutcome({ status: 'failed' }), ANALYSIS_STATUS.FAILED);
  assert.equal(stageOutcome(null), ANALYSIS_STATUS.INTERRUPTED);
});

// --- Уведомление по итогу стадии (_pollStage) ----------------------------------
//
// Защищаемый дефект: частичный итог (QC Стадии 5 не досчитал часть ТЗ) раньше
// показывался КРАСНОЙ ошибкой «анализ не удался» — врёт про пригодный результат;
// а полный успех показывался при любом completed — врёт в другую сторону.
// Правило: success → зелёный, warning → ЖЁЛТЫЙ, всё остальное → красный.

test('stageToast: частичный итог — жёлтый warning с числом недосчитанных частей', async () => {
  const { stageToast, ANALYSIS_STATUS } = await import(CLIENT_UTIL);
  const run = {
    status: 'completed',
    summary: {
      status: ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
      self_analysis: {
        llm_status: ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
        llm_reason: 'не досчитано частей ТЗ: 1 из 3',
        failed_parts: [{ part: 2, error: 'таймаут' }],
      },
    },
  };
  const toast = stageToast(5, run);
  assert.equal(toast.severity, 'warning', 'частичный итог не красный и не зелёный');
  assert.notEqual(toast.severity, 'error');
  assert.equal(toast.status, ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS);
  assert.match(toast.message, /Стадия 5/);
  assert.match(toast.message, /частично/i);
  assert.match(toast.message, /не досчитано частей ТЗ: 1/);
  assert.doesNotMatch(toast.message, /не удался/, 'warning не должен звучать как сбой');
});

test('stageToast: QC пропущен (skipped) без failed_parts — тоже жёлтый, с причиной', async () => {
  const { stageToast, ANALYSIS_STATUS } = await import(CLIENT_UTIL);
  const toast = stageToast(5, {
    status: 'completed',
    summary: {
      status: ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
      self_analysis: { llm_status: 'skipped', llm_reason: 'LLM не настроен (OPENAI_API_KEY)', failed_parts: null },
    },
  });
  assert.equal(toast.severity, 'warning');
  assert.match(toast.message, /LLM не настроен/);
});

test('stageToast: полный успех — зелёный; сбой/обрыв/отмена — красный с причиной', async () => {
  const { stageToast, ANALYSIS_STATUS } = await import(CLIENT_UTIL);

  const ok = stageToast(1, { status: 'completed', summary: { status: ANALYSIS_STATUS.COMPLETED } });
  assert.equal(ok.severity, 'success');
  assert.match(ok.message, /Стадия 1: анализ завершён$/);

  const failed = stageToast(5, { status: 'failed', summary: { error: 'Самоанализ (QC) не выполнен: LLM недоступен' } });
  assert.equal(failed.severity, 'error');
  assert.match(failed.message, /не удался — Самоанализ \(QC\) не выполнен/);

  const interrupted = stageToast(3, { status: 'running' });
  assert.equal(interrupted.severity, 'error');
  assert.match(interrupted.message, /оборван/);

  const cancelled = stageToast(3, { status: 'cancelled' });
  assert.equal(cancelled.severity, 'error');
  assert.match(cancelled.message, /отменён/);

  // Прогона не было вовсе — тоже не успех.
  assert.equal(stageToast(2, null).severity, 'error');
});

// --- Гейт production-сборки на клиенте (runAnalysis) ----------------------------
//
// После failed / cancelled / interrupted стадии клиент НЕ должен запускать
// production-сборку конвейера: она взяла бы СТАРЫЙ активный снимок этой стадии и
// выдала бы его за свежий итог. Частичная сборка — только явным debug-режимом.

// Исходы всех четырёх стадий-добытчиков одним значением.
const allFour = (s) => [s, s, s, s];

test('checkProductionPipeline: сборка запускается только при всех успешных стадиях', async () => {
  const { checkProductionPipeline, ANALYSIS_STATUS } = await import(CLIENT_UTIL);

  const ok = checkProductionPipeline({ stageStatuses: allFour(ANALYSIS_STATUS.COMPLETED) });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, null);

  // Частичный итог стадии (warning) не блокирует — результат пригоден.
  assert.equal(
    checkProductionPipeline({
      stageStatuses: [
        ANALYSIS_STATUS.COMPLETED, ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
        ANALYSIS_STATUS.COMPLETED, ANALYSIS_STATUS.COMPLETED,
      ],
    }).allowed,
    true,
  );
});

test('checkProductionPipeline: failed/cancelled/interrupted стадия блокирует сборку', async () => {
  const { checkProductionPipeline, ANALYSIS_STATUS } = await import(CLIENT_UTIL);

  // Стадия 3 упала — добыча прервалась, стадий всего три.
  const failed = checkProductionPipeline({
    stageStatuses: [ANALYSIS_STATUS.COMPLETED, ANALYSIS_STATUS.COMPLETED, ANALYSIS_STATUS.FAILED],
  });
  assert.equal(failed.allowed, false);
  assert.match(failed.reason, /шаг 3/);
  assert.match(failed.reason, /не запускалась/);

  // Отмена и обрыв — свои причины, тоже блокируют.
  const cancelled = checkProductionPipeline({
    stageStatuses: [ANALYSIS_STATUS.COMPLETED], aborted: ANALYSIS_STATUS.CANCELLED,
  });
  assert.equal(cancelled.allowed, false);
  assert.match(cancelled.reason, /отменена/);

  const interrupted = checkProductionPipeline({
    stageStatuses: allFour(ANALYSIS_STATUS.COMPLETED), aborted: ANALYSIS_STATUS.INTERRUPTED,
  });
  assert.equal(interrupted.allowed, false);
  assert.match(interrupted.reason, /прервана/);

  // Стадии кончились раньше четырёх (гейт не пустил дальше) — тоже нет сборки.
  const short = checkProductionPipeline({ stageStatuses: [ANALYSIS_STATUS.COMPLETED, ANALYSIS_STATUS.COMPLETED] });
  assert.equal(short.allowed, false);
  assert.match(short.reason, /2 из 4/);

  // Пустой прогон не считается основанием для сборки.
  assert.equal(checkProductionPipeline({}).allowed, false);
});

test('aggregateRun клиента совпадает с сервером (в т.ч. warnings и aborted)', async () => {
  const { aggregateRun, ANALYSIS_STATUS } = await import(CLIENT_UTIL);
  const S = server.STATUS;
  // Полный успех.
  assert.equal(
    aggregateRun({ stageStatuses: [ANALYSIS_STATUS.COMPLETED], pipelineStatus: ANALYSIS_STATUS.COMPLETED }),
    server.aggregateRun({ stageStatuses: [S.COMPLETED], pipelineStatus: S.COMPLETED }),
  );
  // Частичная сборка конвейера → warnings, а не success.
  assert.equal(
    aggregateRun({ stageStatuses: [ANALYSIS_STATUS.COMPLETED], pipelineStatus: ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS }),
    ANALYSIS_STATUS.COMPLETED_WITH_WARNINGS,
  );
  // Отмена/обрыв прогона доминируют.
  assert.equal(
    aggregateRun({ stageStatuses: [], pipelineStatus: null, aborted: ANALYSIS_STATUS.CANCELLED }),
    ANALYSIS_STATUS.CANCELLED,
  );
  assert.equal(
    aggregateRun({ stageStatuses: [], pipelineStatus: null, aborted: ANALYSIS_STATUS.INTERRUPTED }),
    ANALYSIS_STATUS.INTERRUPTED,
  );
  // Конвейер не собрался → failed.
  assert.equal(
    aggregateRun({ stageStatuses: [ANALYSIS_STATUS.COMPLETED], pipelineStatus: ANALYSIS_STATUS.FAILED }),
    ANALYSIS_STATUS.FAILED,
  );
});
