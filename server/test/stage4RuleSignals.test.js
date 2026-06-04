'use strict';

// Юнит-тесты детерминированного слоя сигналов Стадии 4 (без БД/LLM). npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeRuleSignals, actionForRisk, DELTA } = require('../services/stageAnalysis/stage4RuleSignals');

const RISK = {
  key: 'R09',
  category: 'Сроки',
  triggers: ['не позднее', 'срок выполнения работ составляет'],
  negative_patterns: ['с даты передачи', 'от передачи фронта'],
  criticality: 'critical',
};

test('exact: точный триггер → matchKind=exact, есть positives, нет негатива', () => {
  const s = computeRuleSignals({ finding: { fragment: 'Работы сдать не позднее 31.12' }, risk: RISK });
  assert.equal(s.matchKind, 'exact');
  assert.equal(s.positiveCount, 1);
  assert.equal(s.hasStrongNegative, false);
  assert.ok(s.delta > 0);
});

test('multiple: несколько триггеров → больше positives и больше delta', () => {
  const single = computeRuleSignals({ finding: { fragment: 'Сдать не позднее срока' }, risk: RISK });
  const multi = computeRuleSignals({
    finding: { fragment: 'Срок выполнения работ составляет 18 мес, не позднее 31.12' },
    risk: RISK,
  });
  assert.equal(multi.positiveCount, 2);
  assert.ok(multi.delta > single.delta, `${multi.delta} <= ${single.delta}`);
});

test('weak: перефразировка триггера (token-overlap) → matchKind=weak', () => {
  const risk = { category: 'Площадка и доступ', triggers: ['координация подрядчиков заказчика'] };
  const s = computeRuleSignals({
    finding: { fragment: 'Возлагается координация всех подрядчиков и поставщиков заказчика' },
    risk,
  });
  assert.equal(s.matchKind, 'weak');
  assert.equal(s.positiveCount, 0);
  assert.ok(s.delta < 0);
});

test('negative: анти-паттерн в контексте → hasStrongNegative', () => {
  const s = computeRuleSignals({
    finding: { fragment: 'Срок исчисляется с даты передачи фронта работ' },
    risk: RISK,
  });
  assert.equal(s.hasStrongNegative, true);
  assert.ok(s.negatives.length >= 1);
});

test('none: ни триггеров, ни перефразировки → matchKind=none, delta=DELTA.none', () => {
  const s = computeRuleSignals({ finding: { fragment: 'Подрядчик красит фасад в синий цвет' }, risk: RISK });
  assert.equal(s.matchKind, 'none');
  assert.equal(s.delta, DELTA.none);
});

test('explain: содержит сработавшие триггеры', () => {
  const s = computeRuleSignals({ finding: { fragment: 'не позднее 31.12' }, risk: RISK });
  assert.match(s.explain, /не позднее/);
});

test('actionForRisk: действие зависит от категории риска', () => {
  assert.equal(actionForRisk({ category: 'Объём работ' }), 'limit_scope');
  assert.equal(actionForRisk({ category: 'Сроки' }), 'clarify');
  assert.equal(actionForRisk({ category: 'Неизвестная' }), 'comment');
  assert.equal(actionForRisk(null), 'comment');
});
