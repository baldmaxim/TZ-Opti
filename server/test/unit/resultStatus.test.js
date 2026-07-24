'use strict';

// Юнит-тесты единого контракта результата (services/analysis/resultStatus.js) —
// без БД и LLM. Проверяют severity-маппинг и свёртку исхода целого прогона
// «Анализ ТЗ» (aggregateRun): success только при полном успехе, warning — при
// частичном (неполный анализ), error — при сбое/обрыве. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STATUS, severityOf, aggregateRun } = require('../../services/analysis/resultStatus');

// --- severity-маппинг ----------------------------------------------------------

test('severityOf: контракт статусов → success | warning | error', () => {
  assert.equal(severityOf(STATUS.COMPLETED), 'success');
  assert.equal(severityOf(STATUS.COMPLETED_WITH_WARNINGS), 'warning');
  assert.equal(severityOf(STATUS.FAILED), 'error');
  assert.equal(severityOf(STATUS.CANCELLED), 'error');
  assert.equal(severityOf(STATUS.INTERRUPTED), 'error');
});

test('severityOf: неизвестный статус — fail-closed (error, не success)', () => {
  assert.equal(severityOf('whatever'), 'error');
  assert.equal(severityOf(undefined), 'error');
});

// --- aggregateRun --------------------------------------------------------------

test('aggregateRun: все стадии + сборка успешны → completed (success)', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.COMPLETED, STATUS.COMPLETED, STATUS.COMPLETED, STATUS.COMPLETED],
    pipelineStatus: STATUS.COMPLETED,
  });
  assert.equal(s, STATUS.COMPLETED);
  assert.equal(severityOf(s), 'success');
});

// «Неполный анализ»: часть стадий не добыта, но сборка кластеров прошла — итог
// частичный, показываем warning (а НЕ success).
test('aggregateRun: стадия провалилась, но сборка прошла → completed_with_warnings (warning)', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.COMPLETED, STATUS.FAILED, STATUS.COMPLETED, STATUS.COMPLETED],
    pipelineStatus: STATUS.COMPLETED,
  });
  assert.equal(s, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(severityOf(s), 'warning');
});

test('aggregateRun: стадия оборвана (interrupted), сборка прошла → warning', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.COMPLETED, STATUS.INTERRUPTED],
    pipelineStatus: STATUS.COMPLETED,
  });
  assert.equal(severityOf(s), 'warning');
});

// Сборка кластеров — обязательный финал: без неё итога нет, даже если стадии
// добыты. Это ключевой кейс «портал рапортует успех после сбоя конвейера».
test('aggregateRun: сборка провалилась → failed (error), несмотря на успешные стадии', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.COMPLETED, STATUS.COMPLETED, STATUS.COMPLETED, STATUS.COMPLETED],
    pipelineStatus: STATUS.FAILED,
  });
  assert.equal(s, STATUS.FAILED);
  assert.equal(severityOf(s), 'error');
});

test('aggregateRun: до сборки не дошли (pipelineStatus=null) → failed', () => {
  const s = aggregateRun({ stageStatuses: [STATUS.COMPLETED], pipelineStatus: null });
  assert.equal(s, STATUS.FAILED);
});

test('aggregateRun: отмена гейтом → cancelled (error), сборку игнорируем', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.CANCELLED],
    pipelineStatus: STATUS.COMPLETED,
    aborted: STATUS.CANCELLED,
  });
  assert.equal(s, STATUS.CANCELLED);
  assert.equal(severityOf(s), 'error');
});

test('aggregateRun: уход со страницы → interrupted (error)', () => {
  const s = aggregateRun({ stageStatuses: [], pipelineStatus: null, aborted: STATUS.INTERRUPTED });
  assert.equal(s, STATUS.INTERRUPTED);
  assert.equal(severityOf(s), 'error');
});

test('aggregateRun: сборка с предупреждениями → warning даже при полных стадиях', () => {
  const s = aggregateRun({
    stageStatuses: [STATUS.COMPLETED],
    pipelineStatus: STATUS.COMPLETED_WITH_WARNINGS,
  });
  assert.equal(s, STATUS.COMPLETED_WITH_WARNINGS);
});
