'use strict';

// Юнит-тесты quality scoring Стадии 4 (без БД и LLM). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreStage4Finding } = require('../services/stageAnalysis/stage4Scoring');

// Эталонный риск из справочника (новые поля: negative_patterns, confidence_weight).
const RISK = {
  key: 'R09',
  category: 'Сроки',
  risk_text: 'Срок установлен абсолютной датой без привязки к старту.',
  triggers: ['не позднее', 'срок выполнения работ составляет'],
  negative_patterns: ['с даты передачи', 'от передачи фронта'],
  recommendation: 'Срок — от передачи фронта работ и исходных данных.',
  criticality: 'critical',
};

const BASIS_OK =
  'Срок задан абсолютной датой без привязки к передаче фронта — риск штрафов и неоплачиваемого ускорения для ГП.';

function goodFinding(extra = {}) {
  return {
    fragment: 'Срок выполнения работ составляет 18 месяцев, не позднее 31.12',
    matched_risk_key: 'R09',
    risk_category: 'Сроки',
    criticality: 'critical',
    confidence: 0.85,
    basis: BASIS_OK,
    review_comment: 'Привязать срок к передаче фронта и РД.',
    ...extra,
  };
}

test('keep: обоснованная находка с точными триггерами проходит', () => {
  const r = scoreStage4Finding({ finding: goodFinding(), risk: RISK });
  assert.equal(r.drop, false);
  assert.equal(r.suppressedByNegative, false);
  assert.ok(r.score >= 0.8, `score=${r.score}`);
});

test('drop: matched_risk_key вне справочника (галлюцинация)', () => {
  const r = scoreStage4Finding({ finding: goodFinding({ matched_risk_key: 'R99' }), risk: null });
  assert.equal(r.drop, true);
  assert.match(r.reason, /вне справочника/i);
});

test('suppress: анти-паттерн в контексте → drop + suppressedByNegative', () => {
  const f = goodFinding({ fragment: 'Срок исчисляется с даты передачи фронта работ Подрядчику' });
  const r = scoreStage4Finding({ finding: f, risk: RISK });
  assert.equal(r.drop, true);
  assert.equal(r.suppressedByNegative, true);
  assert.match(r.reason, /анти-паттерн/i);
});

test('drop: пустая цитата', () => {
  const r = scoreStage4Finding({ finding: goodFinding({ fragment: '   ' }), risk: RISK });
  assert.equal(r.drop, true);
});

test('drop: слабая находка без триггеров + бедный basis + низкая уверенность', () => {
  const f = goodFinding({
    fragment: 'Подрядчик красит фасад в синий цвет',
    confidence: 0.4,
    basis: 'см. выше',
  });
  const r = scoreStage4Finding({ finding: f, risk: RISK });
  assert.equal(r.drop, true);
  assert.equal(r.suppressedByNegative, false);
  assert.match(r.reason, /порога/i);
});

test('boost: несколько positive triggers дают score выше, чем один', () => {
  // conf=0.5, чтобы бусты были видны и не упирались в потолок 1.0.
  const single = scoreStage4Finding({
    finding: goodFinding({ fragment: 'Работы сдать не позднее 31.12.2026 включительно', confidence: 0.5 }),
    risk: RISK,
  });
  const multi = scoreStage4Finding({ finding: goodFinding({ confidence: 0.5 }), risk: RISK }); // 2 триггера
  assert.equal(single.drop, false);
  assert.equal(multi.drop, false);
  assert.ok(multi.score > single.score, `multi=${multi.score} single=${single.score}`);
});

test('confidence_weight: понижает итоговый score', () => {
  const base = scoreStage4Finding({ finding: goodFinding(), risk: RISK });
  const weighted = scoreStage4Finding({ finding: goodFinding(), risk: { ...RISK, confidence_weight: 0.5 } });
  assert.ok(weighted.score < base.score, `weighted=${weighted.score} base=${base.score}`);
});

test('basis с эконом-маркером сильнее, чем без него', () => {
  const withMarker = scoreStage4Finding({ finding: goodFinding(), risk: RISK }).score;
  const noMarker = scoreStage4Finding({
    finding: goodFinding({ basis: 'Формулировка встречается в тексте документа неоднократно везде.' }),
    risk: RISK,
  }).score;
  assert.ok(withMarker > noMarker, `${withMarker} <= ${noMarker}`);
});
