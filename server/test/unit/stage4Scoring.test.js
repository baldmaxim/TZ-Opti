'use strict';

// Юнит-тесты quality scoring Стадии 4 (без БД и LLM). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreStage4Finding } = require('../../services/stageAnalysis/stage4Scoring');

// Эталонный риск из справочника.
const RISK = {
  key: 'R09',
  category: 'Сроки',
  risk_text: 'Срок установлен абсолютной датой без привязки к старту.',
  triggers: ['не позднее', 'срок выполнения работ составляет'],
  negative_triggers: ['с даты передачи', 'от передачи фронта'],
  recommendation: 'Срок — от передачи фронта работ и исходных данных.',
  criticality: 'critical',
};

// Хорошая, обоснованная находка с эконом-последствием.
function goodFinding(extra = {}) {
  return {
    fragment: 'Срок выполнения работ составляет 18 месяцев, не позднее 31.12',
    matched_risk_key: 'R09',
    risk_category: 'Сроки',
    criticality: 'critical',
    confidence: 0.85,
    basis: 'Срок задан абсолютной датой без привязки к передаче фронта — риск штрафов и неоплачиваемого ускорения для ГП.',
    review_comment: 'Привязать срок к передаче фронта и РД.',
    ...extra,
  };
}

test('keep: обоснованная high-confidence находка проходит', () => {
  const r = scoreStage4Finding({ finding: goodFinding(), risk: RISK });
  assert.equal(r.drop, false);
  assert.ok(r.score >= 0.8, `score=${r.score}`);
});

test('drop: matched_risk_key вне справочника (галлюцинация)', () => {
  const r = scoreStage4Finding({ finding: goodFinding({ matched_risk_key: 'R99' }), risk: null });
  assert.equal(r.drop, true);
  assert.match(r.reason, /вне справочника/i);
});

test('drop: сработал анти-триггер риска', () => {
  const f = goodFinding({
    fragment: 'Срок исчисляется с даты передачи фронта работ Подрядчику',
  });
  const r = scoreStage4Finding({ finding: f, risk: RISK });
  assert.equal(r.drop, true);
  assert.match(r.reason, /анти-триггер/i);
});

test('drop: пустая цитата', () => {
  const r = scoreStage4Finding({ finding: goodFinding({ fragment: '   ' }), risk: RISK });
  assert.equal(r.drop, true);
});

test('drop: бедный basis + низкая уверенность уводят ниже порога', () => {
  const f = goodFinding({ confidence: 0.4, basis: 'риск' }); // короткий basis, без эконом-смысла + низкий conf
  const r = scoreStage4Finding({ finding: f, risk: RISK });
  assert.equal(r.drop, true);
  assert.match(r.reason, /порога/i);
});

test('basis без эконом-маркера слабее, чем с маркером', () => {
  const withMarker = scoreStage4Finding({ finding: goodFinding(), risk: RISK }).score;
  const noMarker = scoreStage4Finding({
    finding: goodFinding({ basis: 'Формулировка встречается в тексте документа неоднократно.' }),
    risk: RISK,
  }).score;
  assert.ok(withMarker > noMarker, `${withMarker} <= ${noMarker}`);
});

test('STAGE4_MIN_SCORE поднимает порог отсева', () => {
  const f = goodFinding({ confidence: 0.5, basis: 'риск для гп по объёму работ' });
  const lenient = scoreStage4Finding({ finding: f, risk: RISK });
  process.env.STAGE4_MIN_SCORE = '0.95';
  try {
    const strict = scoreStage4Finding({ finding: f, risk: RISK });
    assert.equal(strict.drop, true);
    assert.equal(strict.score, lenient.score); // тот же score, другой порог
  } finally {
    delete process.env.STAGE4_MIN_SCORE;
  }
});
