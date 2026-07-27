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
