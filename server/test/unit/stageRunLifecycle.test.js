'use strict';

// Юнит-тесты ЧИСТЫХ правил жизненного цикла прогона стадии — без БД и LLM.
// Полные сценарии (сбой в середине документа, рестарт воркера, точечный retry,
// история двух прогонов) — test/integration/stageRunLifecycle.integration.test.js.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const store = require('../../services/stageAnalysis/segments/segmentStore');
const { STATUS, severityOf } = require('../../services/analysis/resultStatus');

// --- runFailureStatus: обрыв, отмена и ошибка — РАЗНЫЕ исходы ------------------

test('runFailureStatus: отмена задания → cancelled, потеря аренды → interrupted, прочее → failed', () => {
  assert.equal(engine.runFailureStatus('cancelled'), STATUS.CANCELLED);
  assert.equal(engine.runFailureStatus('interrupted'), STATUS.INTERRUPTED);
  assert.equal(engine.runFailureStatus({ cancelled: true }), STATUS.CANCELLED);
  assert.equal(engine.runFailureStatus({ leaseLost: true }), STATUS.INTERRUPTED);
  assert.equal(engine.runFailureStatus(new Error('таймаут модели')), STATUS.FAILED);
  // fail-closed: неизвестный источник — ошибка, а не «всё хорошо».
  assert.equal(engine.runFailureStatus(null), STATUS.FAILED);
  assert.equal(severityOf(engine.runFailureStatus(null)), 'error');
});

// --- failureSummary: тот же контракт, что у успешного прогона -------------------

test('failureSummary: контракт статуса + причина + НОМЕР части, на которой встал прогон', () => {
  const err = Object.assign(new Error('Стадия: часть 3/7 — модель недоступна'), { segmentIndex: 2 });
  const s = engine.failureSummary(1, STATUS.FAILED, err);
  assert.equal(s.stage, 1);
  assert.equal(s.status, STATUS.FAILED);
  assert.equal(s.failed, true);
  assert.match(s.error, /модель недоступна/);
  assert.equal(s.failed_segment_index, 2, 'исход обязан показывать, ГДЕ именно упал прогон');
  assert.ok(s.label, 'название стадии берётся из единого источника STAGE_LABELS');
  // Клиент читает summary.error как причину красного тоста (analysisResult.js).
  assert.equal(severityOf(s.status), 'error');
});

test('failureSummary: обрыв и отмена не схлопываются в общий failed', () => {
  const cancelled = engine.failureSummary(2, STATUS.CANCELLED, new Error('отменено инженером'));
  const interrupted = engine.failureSummary(2, STATUS.INTERRUPTED, new Error('воркер потерян'));
  assert.equal(cancelled.status, STATUS.CANCELLED);
  assert.equal(interrupted.status, STATUS.INTERRUPTED);
  assert.equal(interrupted.failed_segment_index, null, 'части не было — поле пустое, а не выдуманное');
});

// --- summarize: «посчитано моделью» ≠ «переиспользовано» ------------------------

test('summarize: переиспользованные части не выдаются за расчёт модели', () => {
  const rows = [
    { status: 'completed', source: 'llm', findings_count: 3 },
    { status: 'completed', source: 'cache', findings_count: 2 },
    { status: 'completed', source: 'checkpoint', findings_count: 1 },
    { status: 'failed', source: null, findings_count: 0 },
    { status: 'skipped', source: null, findings_count: 0 },
  ];
  const s = store.summarize(rows);
  assert.equal(s.total, 5);
  assert.equal(s.completed, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.computed, 1, 'моделью посчитана одна часть');
  assert.equal(s.reused, 2, 'кэш + чекпойнт — переиспользование, а не расчёт');
  assert.equal(s.findings, 6);
  assert.equal(s.by_status.skipped, 1);
});

test('summarize: пустая история — нули, а не падение', () => {
  const s = store.summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.completed, 0);
  assert.equal(s.computed, 0);
  assert.equal(s.reused, 0);
});

// --- Статусы истории частей ------------------------------------------------------

test('статусы части: живые состояния отделены от терминальных', () => {
  assert.deepEqual(store.OPEN_STATUSES, [store.STATUS.PENDING, store.STATUS.RUNNING]);
  // Обрыв прогона переводит живые части в терминальные (finalizeRunSegments):
  // «висящих» pending/running у завершённого прогона быть не может.
  assert.equal(store.STATUS.INTERRUPTED, 'interrupted');
  assert.equal(store.STATUS.SKIPPED, 'skipped');
  assert.deepEqual(
    Object.values(store.SOURCE).sort(),
    ['cache', 'checkpoint', 'llm'],
  );
});
