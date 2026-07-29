'use strict';

// Офлайн-тесты квалификационного фильтра качества замечаний (shadow mode).
// Документ и находки — СОБСТВЕННЫЕ синтетические примеры на генерической
// лексике предметной области (не копии benchmark-fixtures): правила gate не
// должны быть подогнаны под идентификаторы или формулировки эталонного набора.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  qualifyFinding,
  qualifyFindings,
} = require('../../../services/qualification/findingQualificationGate');

const DOC = [
  '# ТЗ на устройство внутренних инженерных систем',
  '',
  'п. 2.1. Выполнить монтаж системы вентиляции в осях 1–5 согласно проекту.',
  'п. 2.2. Выполнить прокладку кабельных линий длиной 1200 м с испытаниями.',
  'п. 3.1. Подрядчик выполняет погрузку и вывоз строительного мусора за свой счёт в объёме, необходимом Заказчику.',
  'п. 4.1. Оплата выполненных работ производится в течение 90 дней после подписания акта.',
  'п. 5.1. Работы выполнять в соответствии с ГОСТ и действующими нормативными документами.',
  'п. 6.1. Демонтаж перегородок площадью 300 м2 с вывозом лома.',
  'п. 7.1. Все материалы должны иметь сертификаты соответствия.',
].join('\n');

const q = (finding) => qualifyFinding(finding, { sourceText: DOC });

test('доказанный неучтённый объём (ТЗ требует, в ВОР нет) → publish', () => {
  const r = q({
    id: 'f-demolition',
    quote: 'Демонтаж перегородок площадью 300 м2 с вывозом лома.',
    summary: 'Демонтаж перегородок 300 м2 требуется по ТЗ, но отсутствует в ведомости объёмов',
    basis: 'П. 6.1 требует демонтаж перегородок, в ведомости объёмов позиции демонтажа нет — объём не попадёт в расчёт стоимости',
    problem_type: 'не_учтено_в_вор',
    impact_level: 'critical',
    impact_dimensions: ['price', 'scope'],
    required_action: 'recalculate',
  });
  assert.equal(r.qualification, 'publish');
  assert.equal(r.priority, 'critical');
  assert.equal(r.evidence_strength, 'strong');
  assert.ok(r.impact_types.includes('cost') && r.impact_types.includes('scope'));
  assert.ok(r.sources.some((s) => s.type === 'vor' && s.strength >= 0.85),
    'ТЗ-требование + отсутствие в ВОР должно быть сильным источником');
  assert.deepEqual(r.missing_requirements, []);
});

test('отсутствие в ВОР БЕЗ ссылки на требование ТЗ — само по себе не сильный источник', () => {
  const r = q({
    id: 'f-vor-only',
    quote: 'Выполнить прокладку кабельных линий длиной 1200 м с испытаниями.',
    summary: 'Прокладка кабельных линий не найдена в ведомости объёмов',
    basis: 'В ведомости объёмов такой позиции нет',
    impact_dimensions: ['price'],
    required_action: 'ask_customer',
  });
  const vor = r.sources.find((s) => s.type === 'vor');
  assert.ok(vor && vor.strength < 0.85, 'ВОР без ТЗ-ссылки не должен давать strong');
  assert.notEqual(r.evidence_strength, 'strong');
});

test('укрупнённая позиция ВОР → review (решает инженер)', () => {
  const r = q({
    id: 'f-aggregated',
    quote: 'Выполнить монтаж системы вентиляции в осях 1–5 согласно проекту.',
    summary: 'Позиция ведомости по монтажу вентиляции укрупнена — состав работ не расшифрован',
    basis: 'В ведомости одна укрупнённая позиция «комплекс работ» без расшифровки, состав цены неясен',
    problem_type: 'укрупнённая_позиция_вор',
    impact_level: 'medium',
    impact_dimensions: ['price'],
    required_action: 'ask_customer',
  });
  assert.equal(r.qualification, 'review');
  assert.equal(r.rule, 'aggregated_vor');
});

test('стандартное нормативное требование без дополнительного риска → hide', () => {
  const r = q({
    id: 'f-standard',
    quote: 'Работы выполнять в соответствии с ГОСТ и действующими нормативными документами.',
    summary: 'В ТЗ есть ссылка на ГОСТ и действующие нормативные документы',
    basis: 'Стандартная нормативная ссылка, включена для полноты',
    impact_level: 'medium',
    required_action: 'none',
  });
  assert.equal(r.qualification, 'hide');
  assert.equal(r.rule, 'standard_requirement');
  assert.equal(r.priority, 'informational');
});

test('редактура / стилистика → hide', () => {
  const r = q({
    id: 'f-editorial',
    quote: 'Все материалы должны иметь сертификаты соответствия.',
    summary: 'Стилистическая правка формулировки о сертификатах материалов',
    basis: 'Редакционное замечание: оформление текста, состав работ и условия не меняет',
    impact_level: 'low',
    required_action: 'none',
  });
  assert.equal(r.qualification, 'hide');
  assert.equal(r.rule, 'editorial');
  assert.equal(r.priority, 'informational');
});

test('обязанность без ограничения объёма (открытая формулировка ТЗ) → publish', () => {
  const r = q({
    id: 'f-open-duty',
    quote: 'Подрядчик выполняет погрузку и вывоз строительного мусора за свой счёт в объёме, необходимом Заказчику.',
    summary: 'Вывоз мусора за счёт подрядчика без ограничения объёма — объём определяет заказчик',
    basis: 'Формулировка «в объёме, необходимом Заказчику» не ограничивает объём — стоимость обязанности рассчитать нельзя',
    impact_level: 'high',
    impact_dimensions: ['price', 'responsibility'],
    required_action: 'amend_tz',
  });
  assert.equal(r.qualification, 'publish');
  assert.ok(r.sources.some((s) => s.type === 'tz_wording'),
    'открытая формулировка самого ТЗ — конкретный источник');
  assert.ok(r.impact_types.includes('liability'));
});

test('неподтверждённое предположение → reject', () => {
  const r = q({
    id: 'f-assumption',
    quote: 'Оплата выполненных работ производится в течение 90 дней после подписания акта.',
    summary: 'Возможно, заказчик будет задерживать оплату сверх 90 дней',
    basis: 'Предположительно, практика оплаты хуже написанного',
    impact_dimensions: ['payment'],
    required_action: 'ask_customer',
  });
  assert.equal(r.qualification, 'reject');
  assert.equal(r.rule, 'unconfirmed_assumption');
  assert.ok(r.missing_requirements.includes('concrete_source'));
});

test('дубль одного места и риска → reject с причиной duplicate', () => {
  const base = {
    quote: 'Подрядчик выполняет погрузку и вывоз строительного мусора за свой счёт в объёме, необходимом Заказчику.',
    summary: 'Вывоз мусора за счёт подрядчика без ограничения объёма',
    basis: 'Формулировка «в объёме, необходимом Заказчику» открытая — стоимость рассчитать нельзя',
    impact_level: 'high',
    impact_dimensions: ['price', 'responsibility'],
    required_action: 'amend_tz',
  };
  const results = qualifyFindings([
    { ...base, id: 'f-first', rank: 1 },
    { ...base, id: 'f-second', rank: 2, summary: 'Открытая обязанность: вывоз мусора в объёме, который определяет заказчик' },
  ], { sourceText: DOC });
  assert.equal(results[0].qualification, 'publish');
  assert.equal(results[1].qualification, 'reject');
  assert.equal(results[1].rule, 'duplicate');
  assert.equal(results[1].duplicate_of, 'f-first');
  assert.ok(results[1].reasons.some((x) => /дубль/i.test(x)));
});

test('замечание без последствия для ГП → hide', () => {
  const r = q({
    id: 'f-no-impact',
    quote: 'Все материалы должны иметь сертификаты соответствия.',
    summary: 'В ТЗ указано требование о сертификатах материалов',
    basis: 'Наблюдение по разделу материалов ТЗ',
    required_action: 'ask_customer',
  });
  assert.equal(r.qualification, 'hide');
  assert.equal(r.rule, 'no_impact');
  assert.deepEqual(r.impact_types, []);
  assert.ok(r.missing_requirements.includes('impact_type'));
});

test('критический риск с сильным доказательством не теряется при низкой уверенности агента', () => {
  const r = q({
    id: 'f-critical-lowconf',
    quote: 'Оплата выполненных работ производится в течение 90 дней после подписания акта.',
    summary: 'Оплата в течение 90 дней противоречит существенным условиям компании по оплате',
    basis: 'Срок оплаты 90 дней противоречит типовым условиям компании (не более 30 дней) — кассовый разрыв',
    impact_level: 'critical',
    confidence: 0.05,
    impact_dimensions: ['payment'],
    required_action: 'amend_tz',
  });
  assert.ok(r.qualification === 'publish' || r.qualification === 'review');
  assert.equal(r.qualification, 'publish');
  assert.equal(r.evidence_strength, 'strong');
});

test('особое правило (rescue): hide-кандидат с сильной цитатой, влиянием и действием не скрывается', () => {
  // Стандартно-нормативный флаг срабатывает (ГОСТ в цитате), но замечание —
  // о договорном расширении с высоким влиянием: gate обязан отдать publish/review.
  const r = q({
    id: 'f-rescued',
    quote: 'Работы выполнять в соответствии с ГОСТ и действующими нормативными документами.',
    summary: 'Требование о нормативных документах расширяет типовые условия договора подряда',
    basis: 'Типовые условия компании ограничивают перечень норм — формулировка ТЗ шире и добавляет обязанности',
    impact_level: 'high',
    impact_dimensions: ['contract'],
    required_action: 'amend_tz',
  });
  assert.ok(r.qualification === 'publish' || r.qualification === 'review',
    `критичное для ГП замечание скрыто: ${r.qualification} (${r.rule})`);
  assert.equal(r.rescued, true);
});

test('отсутствие источника основания не может дать publish', () => {
  const r = q({
    id: 'f-no-source',
    quote: 'Выполнить прокладку кабельных линий длиной 1200 м с испытаниями.',
    summary: 'Объём кабельных линий занижен относительно проекта',
    basis: 'По опыту аналогичных объектов объём больше',
    impact_level: 'high',
    impact_dimensions: ['price'],
    required_action: 'recalculate',
  });
  assert.notEqual(r.qualification, 'publish');
  assert.equal(r.qualification, 'review');
  assert.ok(r.missing_requirements.includes('concrete_source'));
});

test('отсутствие конкретного действия не может дать publish', () => {
  const r = q({
    id: 'f-no-action',
    quote: 'Демонтаж перегородок площадью 300 м2 с вывозом лома.',
    summary: 'Демонтаж перегородок требуется по ТЗ, но отсутствует в ведомости объёмов',
    basis: 'П. 6.1 требует демонтаж, в ведомости объёмов позиции нет — объём не попадёт в расчёт стоимости',
    problem_type: 'не_учтено_в_вор',
    impact_level: 'critical',
    impact_dimensions: ['price', 'scope'],
    required_action: null,
  });
  assert.notEqual(r.qualification, 'publish');
  assert.equal(r.rule, 'no_concrete_action');
  assert.ok(r.missing_requirements.includes('concrete_action'));
});

test('цитата не из документа → reject (вывод не подтверждён текстом)', () => {
  const r = q({
    id: 'f-fabricated',
    quote: 'Источник временного водоснабжения определяется Подрядчиком самостоятельно.',
    summary: 'Не указан источник временного водоснабжения площадки',
    basis: '',
    impact_dimensions: ['price'],
    required_action: 'ask_customer',
  });
  assert.equal(r.qualification, 'reject');
  assert.equal(r.rule, 'quote_not_in_document');
  assert.equal(r.evidence_strength, 'none');
  assert.ok(r.missing_requirements.includes('quote_anchor'));
});

test('цитата есть, но о другом — вывод не подтверждён цитатой → reject', () => {
  const r = q({
    id: 'f-irrelevant',
    quote: 'Все материалы должны иметь сертификаты соответствия.',
    summary: 'Гарантийное удержание заморожено до конца стройки',
    basis: 'Возврат удержания привязан к вводу объекта',
    impact_dimensions: ['payment'],
    required_action: 'amend_tz',
  });
  assert.equal(r.qualification, 'reject');
  assert.equal(r.rule, 'quote_not_confirming');
});

test('shadow mode: входные находки не мутируются (deep freeze) и решения их не содержат', () => {
  const findings = [
    Object.freeze({
      id: 'f-frozen',
      quote: 'Демонтаж перегородок площадью 300 м2 с вывозом лома.',
      summary: 'Демонтаж перегородок отсутствует в ведомости объёмов',
      basis: 'П. 6.1 требует демонтаж, в ведомости объёмов позиции нет',
      problem_type: 'не_учтено_в_вор',
      impact_level: 'critical',
      impact_dimensions: Object.freeze(['price', 'scope']),
      required_action: 'recalculate',
    }),
  ];
  Object.freeze(findings);
  const snapshot = JSON.stringify(findings);
  const results = qualifyFindings(findings, { sourceText: DOC });
  assert.equal(JSON.stringify(findings), snapshot, 'вход изменён — shadow mode нарушен');
  assert.equal(results.length, 1);
  assert.equal(results[0].finding_id, 'f-frozen');
  // Диагностический score существует, но решение принимают именованные правила.
  assert.ok(results[0].score_breakdown && typeof results[0].score_breakdown.total === 'number');
  assert.ok(results[0].rule);
});
