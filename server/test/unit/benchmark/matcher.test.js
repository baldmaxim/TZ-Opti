'use strict';

// Юнит-тесты сопоставления находки с эталоном: место / смысл / категория /
// направление действия, без требования текстового совпадения формулировок.
// Без БД, без сети, без LLM.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const matcher = require('../../../services/benchmark/matcher');

const SOURCE = [
  '# ТЗ (фрагмент)',
  'п. 2.1. Подрядчик обеспечивает ежедневную уборку строительной площадки и вывоз строительного мусора за свой счёт.',
  'п. 2.2. Оплата выполненных работ производится в течение 45 банковских дней после подписания справки КС-3.',
  'п. 2.3. Демонтаж существующего покрытия площадью 450 м2 выполняется силами Подрядчика.',
].join('\n\n');

const doc = matcher.prepareDocument(SOURCE);

const EXPECTED_CLEANING = {
  id: 'e1',
  kind: 'critical',
  quote: 'Подрядчик обеспечивает ежедневную уборку строительной площадки и вывоз строительного мусора за свой счёт.',
  tz_clause: 'п. 2.1',
  risk_category: 'обязанности_гп',
  problem_type: 'обязанность_за_счёт_подрядчика',
  expected_impact: 'high',
  required_action: 'amend_tz',
  accepted_phrasings: ['Открытая обязанность ГП по уборке и вывозу мусора без ограничения объёма'],
  required_basis: 'Объём обязанности не ограничен',
};

function finding(overrides = {}) {
  return {
    id: 'f1',
    rank: 1,
    quote: EXPECTED_CLEANING.quote,
    tz_clause: 'п. 2.1',
    problem_type: 'силами_подрядчика_без_ограничения',
    risk_category: 'обязанности_гп',
    required_action: 'amend_tz',
    summary: 'Содержание территории в чистоте возложено на подрядчика, границы обязанности не заданы',
    basis: 'Формулировка открытая, стоимость не поддаётся расчёту',
    verdict: 'publish',
    ...overrides,
  };
}

test('совпадение без текстового равенства: перефразированное замечание закрывает эталон', () => {
  const e = matcher.prepareExpected(EXPECTED_CLEANING, doc);
  const f = matcher.prepareFinding(finding(), 0, doc);
  const m = matcher.matchScore(f, e);
  assert.equal(m.eligible, true);
  assert.ok(m.axes.place >= matcher.PLACE_GATE);
  // Смысл подтверждён таксономией объекта работ (уборка), а не равенством слов.
  assert.ok(m.axes.meaning >= 0.8);
});

test('чужое место документа не проходит place-гейт', () => {
  const e = matcher.prepareExpected(EXPECTED_CLEANING, doc);
  const f = matcher.prepareFinding(finding({
    quote: 'Демонтаж существующего покрытия площадью 450 м2 выполняется силами Подрядчика.',
    tz_clause: 'п. 2.3',
  }), 0, doc);
  const m = matcher.matchScore(f, e);
  assert.equal(m.eligible, false);
  assert.ok(matcher.failedAxes(m.axes, m.score).includes('place_mismatch'));
});

test('категория: свободные формулировки одного семейства рисков совпадают', () => {
  // «не_учтено_в_вор» и «отсутствует в ВОР» → одно семейство coverage_gap.
  const a = matcher.categoryKeys('не_учтено_в_вор', null);
  const b = matcher.categoryKeys('отсутствует в ВОР', 'покрытие расчёта');
  assert.ok([...a].some((k) => b.has(k)));
});

test('направление действия: ask_customer и add_assumption — одно, amend_tz и exclude_scope — разные', () => {
  const e = matcher.prepareExpected({ ...EXPECTED_CLEANING, required_action: 'ask_customer' }, doc);
  const clarify = matcher.prepareFinding(finding({ required_action: 'add_assumption' }), 0, doc);
  assert.equal(matcher.actionScore(clarify, e), 1);
  const e2 = matcher.prepareExpected({ ...EXPECTED_CLEANING, required_action: 'amend_tz' }, doc);
  const remove = matcher.prepareFinding(finding({ required_action: 'exclude_scope' }), 0, doc);
  assert.equal(matcher.actionScore(remove, e2), 0);
});

test('отсутствие действия у эталона нейтрально (0.5), а не провал', () => {
  const e = matcher.prepareExpected({ ...EXPECTED_CLEANING, required_action: null }, doc);
  const f = matcher.prepareFinding(finding(), 0, doc);
  assert.equal(matcher.actionScore(f, e), 0.5);
});

test('якорь: цитата, которой нет в документе, оставляет находку без опоры', () => {
  const f = matcher.prepareFinding(finding({
    quote: 'Источник временного электроснабжения определяется Подрядчиком самостоятельно.',
    tz_clause: null,
  }), 0, doc);
  assert.equal(f.anchored, false);
  assert.equal(f.paragraph, null);
});

test('published: verdict=suppress не публикует, published=true перебивает', () => {
  const suppressed = matcher.prepareFinding(finding({ verdict: 'suppress' }), 0, doc);
  assert.equal(suppressed.published, false);
  const forced = matcher.prepareFinding(finding({ verdict: 'suppress', published: true }), 0, doc);
  assert.equal(forced.published, true);
});

test('запрещённое замечание: категория и действие нейтральны, решают место и смысл', () => {
  const forb = matcher.prepareForbidden({
    id: 'forb-1',
    quote: 'Оплата выполненных работ производится в течение 45 банковских дней после подписания справки КС-3.',
    reason: 'standard_requirement',
    accepted_phrasings: ['Срок оплаты 45 дней после КС-3 указан в ТЗ'],
  }, doc);
  const f = matcher.prepareFinding(finding({
    quote: 'Оплата выполненных работ производится в течение 45 банковских дней после подписания справки КС-3.',
    tz_clause: 'п. 2.2',
    problem_type: 'типовой_риск',
    risk_category: 'оплата',
    summary: 'В ТЗ указан срок оплаты 45 дней после подписания КС-3',
    basis: 'Указание срока оплаты присутствует',
  }), 0, doc);
  const m = matcher.matchScore(f, forb);
  assert.equal(m.axes.category, 0.5);
  assert.equal(m.axes.action, 0.5);
  assert.equal(m.eligible, true);
});

test('clauseKey нормализует форматы номеров пунктов', () => {
  assert.equal(matcher.clauseKey('п. 3.2'), '3.2');
  assert.equal(matcher.clauseKey('3.2.'), '3.2');
  assert.equal(matcher.clauseKey('раздел 3)2'), '3.2');
  assert.equal(matcher.clauseKey('без номера'), null);
});
