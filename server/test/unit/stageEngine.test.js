'use strict';

// Юнит-тесты контракта результата стадии (stageAnalysisEngine чистые функции) —
// без БД и LLM. Проверяют:
//  - classifyStageRun: строка analysis_runs → статус контракта (ошибка стадии → failed);
//  - canFinishStage: стадию нельзя завершить после неуспешного прогона.
// Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const { STATUS, severityOf } = require('../../services/analysis/resultStatus');

// --- classifyStageRun ----------------------------------------------------------

test('classifyStageRun: успешный прогон → completed (success)', () => {
  const s = engine.classifyStageRun({ status: 'completed' });
  assert.equal(s, STATUS.COMPLETED);
  assert.equal(severityOf(s), 'success');
});

// Ошибка стадии: recordFailedRun пишет analysis_run со status='failed' — исход
// обязан читаться как failed (error), а не как успех.
test('classifyStageRun: сбойный прогон → failed (error)', () => {
  const s = engine.classifyStageRun({ status: 'failed' });
  assert.equal(s, STATUS.FAILED);
  assert.equal(severityOf(s), 'error');
});

test('classifyStageRun: осиротевший running → interrupted (error)', () => {
  assert.equal(engine.classifyStageRun({ status: 'running' }), STATUS.INTERRUPTED);
  assert.equal(severityOf(STATUS.INTERRUPTED), 'error');
});

// Задание очереди может оборваться (рестарт/потеря воркера) или быть отменено
// инженером — эти исходы пишутся в analysis_runs своим статусом и не должны
// схлопываться в общий 'failed'.
test('classifyStageRun: оборванный и отменённый прогон читаются как есть', () => {
  assert.equal(engine.classifyStageRun({ status: 'interrupted' }), STATUS.INTERRUPTED);
  assert.equal(engine.classifyStageRun({ status: 'cancelled' }), STATUS.CANCELLED);
  assert.equal(severityOf(STATUS.CANCELLED), 'error');
});

test('classifyStageRun: прогона нет (null) → interrupted', () => {
  assert.equal(engine.classifyStageRun(null), STATUS.INTERRUPTED);
});

test('classifyStageRun: неизвестный статус → failed (fail-closed)', () => {
  assert.equal(engine.classifyStageRun({ status: 'weird' }), STATUS.FAILED);
});

// Частичный результат (Стадия 5 QC: часть ТЗ не досчитана): колонка
// analysis_runs.status='completed', но полный контракт лежит в summary. Исход
// обязан читаться как warning, а не полный success — иначе портал отрапортует
// зелёный «завершено» после сбоя части (п.4 аудита: ошибка этапа ≠ успех).
test('classifyStageRun: completed + summary.partial → completed_with_warnings (не success)', () => {
  const summaryObj = { stage: 5, status: STATUS.COMPLETED_WITH_WARNINGS };
  // summary как объект (getStageRunSummary отдаёт разобранным) …
  const asObj = engine.classifyStageRun({ status: 'completed', summary: summaryObj });
  assert.equal(asObj, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(severityOf(asObj), 'warning');
  // … и как JSON-строка (сырой ряд из БД).
  const asStr = engine.classifyStageRun({ status: 'completed', summary: JSON.stringify(summaryObj) });
  assert.equal(asStr, STATUS.COMPLETED_WITH_WARNINGS);
  assert.notEqual(severityOf(asStr), 'success');
});

test('classifyStageRun: completed без warning-контракта → полный completed', () => {
  assert.equal(
    engine.classifyStageRun({ status: 'completed', summary: JSON.stringify({ stage: 1, status: STATUS.COMPLETED }) }),
    STATUS.COMPLETED,
  );
  // битый summary не должен ронять классификацию — остаётся completed.
  assert.equal(engine.classifyStageRun({ status: 'completed', summary: '{not json' }), STATUS.COMPLETED);
});

// --- canFinishStage ------------------------------------------------------------

test('canFinishStage: завершать можно только из reviewing (после успешного прогона)', () => {
  assert.equal(engine.canFinishStage('reviewing'), true);
});

// «Не завершай стадию после неуспешного run»: провал возвращает статус в 'open',
// такую стадию завершать нельзя (иначе следующий гейт откроется по сбою).
test('canFinishStage: open/running/finished/locked завершать нельзя', () => {
  assert.equal(engine.canFinishStage('open'), false);
  assert.equal(engine.canFinishStage('running'), false);
  assert.equal(engine.canFinishStage('finished'), false);
  assert.equal(engine.canFinishStage('locked'), false);
});
