'use strict';

// Покрытие существенных условий (stageAnalysis/conditionCoverage) — чистое ядро:
// агрегация статусов по частям ТЗ, темы покрытия, находка «условие отсутствует»
// и согласованность словарей действий с реестрами системы.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  COVERAGE_TOPICS,
  COVERAGE_STATUSES,
  CLOSING_STATUSES,
  isClosingStatus,
  isTopicClosedByOverride,
  selectMissingTopics,
  RESOLUTIONS,
  RESOLUTION_TO_REQUIRED_ACTION,
  RESOLUTION_TO_SUGGESTED_ACTION,
  buildTopicList,
  aggregateCoverage,
  buildMissingFinding,
  normalizePartStatus,
  STATUS_LABELS,
} = require('../../services/stageAnalysis/conditionCoverage');
const { REQUIRED_ACTIONS } = require('../../services/review/materiality');
const { ALL_ACTIONS } = require('../../services/analysis/actions');
const { STANDARD_REQUIREMENT_RE } = require('../../services/critic/precision/patterns');

const CONDS = [
  { idx: 6, name: 'Авансы', text: 'Аванс 20% с зачётом пропорционально', criticality: 'high' },
  { idx: 12, name: 'Гарантийный срок', text: 'Гарантийный срок 5 лет', criticality: 'high' },
];

function topics() {
  return buildTopicList(CONDS);
}

// --- Справочник тем -----------------------------------------------------------

test('справочник = условия компании + темы покрытия (все 16 договорных тем)', () => {
  const list = topics();
  assert.equal(list.filter((t) => t.kind === 'condition').length, 2);
  assert.equal(list.filter((t) => t.kind === 'topic').length, COVERAGE_TOPICS.length);
  assert.ok(COVERAGE_TOPICS.length >= 16, 'темы из ТЗ пользователя присутствуют');
  const names = list.map((t) => t.name);
  for (const expected of [
    'Порядок оформления дополнительных работ',
    'Последствия задержки РД и исходных данных',
    'Лимит совокупной ответственности',
    'Приёмка работ по молчанию',
    'Приоритет документов при противоречии',
  ]) {
    assert.ok(names.includes(expected), `тема «${expected}» в справочнике`);
  }
});

// --- Агрегация по частям -------------------------------------------------------

test('«отсутствует» — только если тема не затронута НИ В ОДНОЙ части', () => {
  const list = topics();
  const cov = aggregateCoverage(list, [
    { name: 'Авансы', status: 'соответствует', fragment: 'аванс 20%', segment: 3 },
  ]);
  assert.equal(cov.get('cond:6').status, 'matches');
  assert.equal(cov.get('cond:12').status, 'missing', 'гарантия нигде не затронута');
  assert.equal(cov.get('topic:liability_cap').status, 'missing');
});

test('приоритет статусов: противоречит > неоднозначно > соответствует', () => {
  const list = topics();
  const cov = aggregateCoverage(list, [
    { name: 'Авансы', status: 'соответствует', segment: 0 },
    { name: 'Авансы', status: 'противоречит', fragment: 'аванс не предусмотрен', segment: 4 },
    { name: 'Гарантийный срок', status: 'соответствует', segment: 1 },
    { name: 'Гарантийный срок', status: 'неоднозначно', fragment: 'гарантия по согласованию', segment: 2 },
  ]);
  assert.equal(cov.get('cond:6').status, 'contradicts');
  assert.equal(cov.get('cond:12').status, 'ambiguous');
  // Вхождения всех частей сохранены как evidence.
  assert.equal(cov.get('cond:6').evidence.length, 2);
});

test('легаси-статус «отражено_корректно» принимается как «соответствует»', () => {
  assert.equal(normalizePartStatus('отражено_корректно'), 'соответствует');
  assert.equal(normalizePartStatus('ПРОТИВОРЕЧИТ'), 'противоречит');
  assert.equal(normalizePartStatus('что-то ещё'), null);
});

test('запись с именем вне справочника игнорируется (модель не выдумывает тем)', () => {
  const list = topics();
  const cov = aggregateCoverage(list, [
    { name: 'Выдуманное условие', status: 'противоречит', fragment: 'x', segment: 0 },
  ]);
  for (const row of cov.values()) assert.equal(row.status, 'missing');
});

test('resolution назначается только отсутствующим темам', () => {
  const list = topics();
  const cov = aggregateCoverage(list, [
    { name: 'Авансы', status: 'соответствует', segment: 0 },
  ]);
  assert.equal(cov.get('cond:6').resolution, null);
  assert.ok(RESOLUTIONS.includes(cov.get('topic:liability_cap').resolution));
});

// --- Находка «условие отсутствует» --------------------------------------------

test('находка отсутствия безъякорна, с обоснованием и действием (не правкой текста)', () => {
  const list = topics();
  const cond = list.find((t) => t.topic_key === 'cond:12');
  const f = buildMissingFinding(cond, { segmentsTotal: 7 });
  assert.equal(f.fragment, null, 'цитаты нет по определению');
  assert.equal(f.problem_type, 'условие_отсутствует');
  assert.match(f.basis, /не обнаружена ни в одной из 7 частей/);
  assert.equal(f.suggested_redaction, 'Гарантийный срок 5 лет', 'готовая формулировка для КП/договора');
  assert.ok(['clarify', 'assumption'].includes(f.suggested_action), 'действие — спросить/допустить, не удалить');
  assert.ok(REQUIRED_ACTIONS.includes(f.required_action));
});

test('basis находки не срабатывает как «стандартное требование» (иначе критик её спрячет)', () => {
  const list = topics();
  for (const t of list) {
    const f = buildMissingFinding(t, { segmentsTotal: 3 });
    const text = `${f.basis} ${f.review_comment}`.toLowerCase();
    assert.equal(STANDARD_REQUIREMENT_RE.test(text), false, t.name);
  }
});

// --- Закрытие темы инженером ---------------------------------------------------

test('закрывающие статусы — подмножество словаря, с ярлыками; check_contract и missing НЕ закрывают', () => {
  for (const s of CLOSING_STATUSES) {
    assert.ok(COVERAGE_STATUSES.includes(s), `«${s}» в словаре статусов`);
    assert.ok(STATUS_LABELS[s], `у «${s}» есть ярлык`);
  }
  assert.ok(COVERAGE_STATUSES.includes('resolved_in_contract'));
  assert.ok(COVERAGE_STATUSES.includes('risk_accepted'));
  assert.equal(isClosingStatus('check_contract'), false, '«проверить договор» — действие, вопрос открыт');
  assert.equal(isClosingStatus('missing'), false);
  assert.equal(isClosingStatus('ambiguous'), false);
  assert.equal(isClosingStatus('contradicts'), false);
});

test('isTopicClosedByOverride: примечание без статуса и открытые статусы находку не гасят', () => {
  assert.equal(isTopicClosedByOverride(null), false, 'нет override — тема открыта');
  assert.equal(isTopicClosedByOverride({ status: null, note: 'Обсудить с Заказчиком на переговорах' }), false,
    'note без статуса не скрывает нерешённый риск');
  assert.equal(isTopicClosedByOverride({ status: 'check_contract' }), false);
  assert.equal(isTopicClosedByOverride({ status: 'missing' }), false,
    'инженер явно подтвердил пробел — находка остаётся');
  assert.equal(isTopicClosedByOverride({ status: 'resolved_in_contract' }), true);
  assert.equal(isTopicClosedByOverride({ status: 'risk_accepted' }), true);
  assert.equal(isTopicClosedByOverride({ status: 'not_applicable' }), true);
  assert.equal(isTopicClosedByOverride({ status: 'other_document', note: 'п. 12.4 договора' }), true);
});

test('selectMissingTopics: гасит только закрывающий статус, note-only остаётся в emit', () => {
  const list = topics();
  const cov = aggregateCoverage(list, [
    { name: 'Авансы', status: 'соответствует', fragment: 'аванс 20%', segment: 0 },
  ]);
  const overrides = new Map([
    ['cond:12', { status: 'resolved_in_contract', note: 'гарантия в проекте договора' }],
    ['topic:liability_cap', { status: null, note: 'вопрос юристам' }],
    ['topic:silent_acceptance', { status: 'check_contract' }],
  ]);
  const { emit, suppressed } = selectMissingTopics(list, cov, overrides);
  const emitKeys = emit.map((t) => t.topic_key);
  const suppressedKeys = suppressed.map((t) => t.topic_key);

  assert.deepEqual(suppressedKeys, ['cond:12'], 'закрыт только явный закрывающий статус');
  assert.ok(!emitKeys.includes('cond:6'), 'затронутая тема не эмитится вовсе');
  assert.ok(emitKeys.includes('topic:liability_cap'), 'note без статуса не закрывает тему');
  assert.ok(emitKeys.includes('topic:silent_acceptance'), 'check_contract не закрывает тему');
  assert.ok(emitKeys.includes('topic:rd_delay'), 'тема без override остаётся находкой');
});

// --- Согласованность словарей --------------------------------------------------

test('каждое resolution маплится в существующие словари действий (без расширения реестров)', () => {
  for (const r of RESOLUTIONS) {
    assert.ok(REQUIRED_ACTIONS.includes(RESOLUTION_TO_REQUIRED_ACTION[r]),
      `required_action для «${r}» из словаря materiality`);
    assert.ok(ALL_ACTIONS.includes(RESOLUTION_TO_SUGGESTED_ACTION[r]),
      `suggested_action для «${r}» из реестра actions`);
  }
  for (const r of RESOLUTIONS) assert.ok(STATUS_LABELS, 'ярлыки статусов определены');
});
