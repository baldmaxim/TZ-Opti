'use strict';

// Юнит-тесты ЯРУСА 2 кластеризации — повторяющиеся требования ТЗ.
// Без БД и LLM: только чистое ядро clusterPairs + clustering/topicModel.
//
// Проверяемое правило: однотипная обязанность ГП, размазанная по нескольким
// пунктам ТЗ (уборка, исполнительная документация, временные сети, поставка
// материалов), должна давать ОДНО замечание с несколькими вхождениями, а не
// карточку на каждый абзац. Обратное правило тоже проверяется: разные
// самостоятельные риски одного абзаца не сливаются никогда.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clusterPairs } = require('../../services/clustering/clusteringService');
const topicModel = require('../../services/clustering/topicModel');

const T = 'tender-topics';

// Пара {draft, review} как её отдаёт loadPairs. По умолчанию — материальное
// опубликованное замечание с обязанностью подрядчика и правкой текста ТЗ.
function pair(draft, review = {}) {
  return {
    draft: {
      id: 'd', tz_clause: null, source_fragment: null,
      problem_type: 'обязанность_за_счёт_подрядчика', category: 'risk',
      basis: null, suggested_action: 'limit_scope', suggested_redaction: null,
      review_comment: null, paragraph_index: 0, ...draft,
    },
    review: review === null ? null : {
      display_priority: 'high', show_to_engineer: true, score: 6,
      price_impact: 'high', schedule_impact: 'none', contract_impact: 'none',
      responsibility_impact: 'medium',
      verdict: 'publish', impact_level: 'high', evidence_level: 'strong',
      impact_dimensions: ['price'], required_action: 'amend_tz',
      publication_reason: 'Не учтённая в КП обязанность ГП.', suppression_reason: null,
      ...review,
    },
  };
}

// Хелпер: один кластер из набора, с проверкой числа вхождений.
function single(pairs, expectedOccurrences) {
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 1, `ожидался один кластер, получено ${clusters.length}: `
    + clusters.map((c) => c.cluster_title).join(' | '));
  assert.equal(clusters[0].occurrence_count, expectedOccurrences);
  return clusters[0];
}

// --- 1. Уборка ---------------------------------------------------------------

test('уборка: требование из четырёх пунктов ТЗ → одно замечание, 4 вхождения', () => {
  const pairs = [
    pair({
      id: 'cl1', tz_clause: 'п. 4.1 Общие обязанности', paragraph_index: 41,
      source_fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки в течение всего периода производства работ.',
      basis: 'Ежедневная уборка площадки не учтена в КП',
    }),
    pair({
      id: 'cl2', tz_clause: 'п. 6.3 Содержание территории', paragraph_index: 63,
      source_fragment: 'Вывоз строительного мусора осуществляется силами и за счёт Подрядчика.',
      basis: 'Вывоз строительного мусора за счёт ГП не посчитан',
    }),
    pair({
      id: 'cl3', tz_clause: 'п. 6.4 Содержание территории', paragraph_index: 64,
      source_fragment: 'Подрядчик обязан обеспечить содержание прилегающей территории в чистоте.',
      basis: 'Содержание территории в чистоте не учтено в объёме',
    }),
    pair({
      id: 'cl4', tz_clause: 'п. 11.2 Сдача объекта', paragraph_index: 112,
      source_fragment: 'До сдачи объекта выполняется финишная уборка помещений.',
      basis: 'Финишная уборка помещений не учтена в КП',
    }),
  ];

  const c = single(pairs, 4);
  assert.equal(c.item_count, 4, 'все четыре draft_issue остались в кластере');
  assert.equal(c.work_object, 'cleaning');
  assert.match(c.cluster_title, /Уборка и вывоз мусора/);

  // Вхождения: по одному на место, в порядке документа, с цитатами и разделами.
  assert.equal(c.evidence_fragments.length, 4);
  assert.match(c.evidence_fragments[0].fragment, /ежедневную уборку/);
  assert.deepEqual(
    c.evidence_fragments.map((e) => e.section),
    ['Раздел 4', 'Раздел 6', 'Раздел 6', 'Раздел 11'],
  );
  assert.deepEqual(c.affected_sections, ['Раздел 4', 'Раздел 6', 'Раздел 11'],
    'разделы уникальны и в порядке документа');
  assert.ok(c.representative_fragment, 'есть представительная цитата');

  // Смысл каждого вхождения сохранён в объединённом основании.
  for (const re of [/ежедневная уборка/i, /вывоз строительного мусора/i, /чистот/i, /финишная уборка/i]) {
    assert.match(c.merged_basis, re);
  }
});

// --- 2. Исполнительная документация -----------------------------------------

test('исполнительная документация: три пункта ТЗ → одно замечание, 3 вхождения', () => {
  const pairs = [
    pair({
      id: 'id1', tz_clause: 'п. 8.1 Документация', paragraph_index: 81,
      source_fragment: 'Подрядчик ведёт и передаёт Заказчику исполнительную документацию в трёх экземплярах на бумажном носителе.',
      basis: 'Ведение исполнительной документации в трёх экземплярах не учтено в КП',
    }),
    pair({
      id: 'id2', tz_clause: 'п. 8.5 Документация', paragraph_index: 85,
      source_fragment: 'Акты освидетельствования скрытых работ оформляются Подрядчиком и согласовываются с техническим надзором.',
      basis: 'Оформление актов освидетельствования скрытых работ не посчитано',
    }),
    pair({
      id: 'id3', tz_clause: 'п. 12.4 Приёмка', paragraph_index: 124,
      source_fragment: 'Приёмка выполненных работ производится при наличии полного комплекта исполнительной документации.',
      basis: 'Полный комплект исполнительной документации — условие приёмки, объём не определён',
    }),
  ];

  const c = single(pairs, 3);
  assert.equal(c.work_object, 'as_built_docs');
  assert.match(c.cluster_title, /Исполнительная документация/);
  assert.deepEqual(c.affected_sections, ['Раздел 8', 'Раздел 12']);
  assert.equal(c.evidence_fragments.length, 3);
});

// --- 3. Временные сети -------------------------------------------------------

test('временные сети: три пункта ТЗ → одно замечание, 3 вхождения', () => {
  const pairs = [
    pair({
      id: 'tu1', tz_clause: 'п. 5.2 Подготовительный период', paragraph_index: 52,
      source_fragment: 'Устройство временных инженерных сетей выполняется Подрядчиком за свой счёт.',
      basis: 'Временные инженерные сети за счёт ГП не учтены в ВОР',
    }),
    pair({
      id: 'tu2', tz_clause: 'п. 5.6 Подготовительный период', paragraph_index: 56,
      source_fragment: 'Временное электроснабжение строительной площадки организует Подрядчик.',
      basis: 'Временное электроснабжение площадки не посчитано',
    }),
    pair({
      id: 'tu3', tz_clause: 'п. 9.1 Инженерное обеспечение', paragraph_index: 91,
      source_fragment: 'Точки подключения временного водоснабжения определяются Подрядчиком самостоятельно.',
      basis: 'Точки подключения временного водоснабжения не определены — объём открыт',
    }),
  ];

  const c = single(pairs, 3);
  assert.equal(c.work_object, 'temporary_utilities');
  assert.match(c.cluster_title, /Временные сети/);
  assert.deepEqual(c.affected_sections, ['Раздел 5', 'Раздел 9']);
});

// --- 4. Поставка материалов --------------------------------------------------

test('поставка материалов: три пункта ТЗ → одно замечание, 3 вхождения', () => {
  const pairs = [
    pair({
      id: 'ms1', tz_clause: 'п. 3.4 Материалы', paragraph_index: 34,
      source_fragment: 'Поставка материалов и оборудования осуществляется Подрядчиком.',
      basis: 'Поставка материалов и оборудования отнесена на ГП',
    }),
    pair({
      id: 'ms2', tz_clause: 'п. 3.9 Материалы', paragraph_index: 39,
      source_fragment: 'Приобретение материалов производится Подрядчиком по согласованным с Заказчиком образцам.',
      basis: 'Приобретение материалов по образцам Заказчика — риск удорожания',
    }),
    pair({
      id: 'ms3', tz_clause: 'п. 10.2 Склад', paragraph_index: 102,
      source_fragment: 'Входной контроль поставляемых материалов выполняется силами Подрядчика.',
      basis: 'Входной контроль поставляемых материалов не учтён в КП',
    }),
  ];

  const c = single(pairs, 3);
  assert.equal(c.work_object, 'material_supply');
  assert.match(c.cluster_title, /Поставка материалов/);
  assert.deepEqual(c.affected_sections, ['Раздел 3', 'Раздел 10']);
});

// --- Границы слияния ---------------------------------------------------------

test('разные обязанности не смешиваются: уборка, ИД, сети и поставка → 4 замечания', () => {
  const pairs = [
    pair({ id: 'a', tz_clause: 'п. 4.1', paragraph_index: 41,
      source_fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки.',
      basis: 'Уборка площадки не учтена' }),
    pair({ id: 'b', tz_clause: 'п. 8.1', paragraph_index: 81,
      source_fragment: 'Подрядчик ведёт исполнительную документацию в трёх экземплярах.',
      basis: 'Исполнительная документация не учтена' }),
    pair({ id: 'c', tz_clause: 'п. 5.2', paragraph_index: 52,
      source_fragment: 'Устройство временных инженерных сетей выполняется Подрядчиком.',
      basis: 'Временные сети не учтены' }),
    pair({ id: 'd', tz_clause: 'п. 3.4', paragraph_index: 34,
      source_fragment: 'Поставка материалов и оборудования осуществляется Подрядчиком.',
      basis: 'Поставка материалов не учтена' }),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 4, 'четыре разные обязанности — четыре замечания');
  assert.deepEqual(
    new Set(clusters.map((c) => c.work_object)),
    new Set(['cleaning', 'as_built_docs', 'temporary_utilities', 'material_supply']),
  );
  assert.ok(clusters.every((c) => c.occurrence_count === 1));
});

test('одна тема, но разное бизнес-последствие → разные замечания', () => {
  const pairs = [
    pair(
      { id: 'p1', tz_clause: 'п. 4.1', paragraph_index: 41,
        source_fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки.',
        basis: 'Уборка не учтена в КП — удорожание' },
      { price_impact: 'high', contract_impact: 'none' },
    ),
    pair(
      { id: 'p2', tz_clause: 'п. 6.3', paragraph_index: 63,
        source_fragment: 'Оплата за уборку территории удерживается Заказчиком до подписания итогового акта.',
        basis: 'Удержание оплаты за уборку до итогового акта' },
      { price_impact: 'none', contract_impact: 'high' },
    ),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 2, 'стоимость и договорное условие — разные замечания');
});

test('разные самостоятельные риски одного абзаца не сливаются ярусом 2', () => {
  const frag = 'Подрядчик выполняет уборку в полном объёме за свой счёт; оплата производится после подписания итогового акта.';
  const pairs = [
    pair(
      { id: 'scope', tz_clause: 'п. 7.2', paragraph_index: 72, source_fragment: frag,
        problem_type: 'открытый_объём', suggested_action: 'remove_from_scope',
        basis: 'Работы в полном объёме за свой счёт' },
      { responsibility_impact: 'high', price_impact: 'medium', required_action: 'exclude_scope' },
    ),
    pair(
      { id: 'pay', tz_clause: 'п. 7.2', paragraph_index: 72, source_fragment: frag,
        problem_type: 'риск_оплаты', suggested_action: 'comment',
        basis: 'Оплата только после итогового акта' },
      { contract_impact: 'high', required_action: 'ask_customer' },
    ),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 2, 'объём и оплата — два самостоятельных риска одного абзаца');
  assert.ok(clusters.every((c) => c.occurrence_count === 1));
});

test('нераспознанный объект работ: слияние только при высокой близости текстов', () => {
  const far = [
    pair({ id: 'f1', tz_clause: 'п. 2.1', paragraph_index: 21,
      source_fragment: 'Подрядчик согласовывает колористическое решение фасада с архитектором проекта.',
      basis: 'Колористическое решение фасада не согласовано' }),
    pair({ id: 'f2', tz_clause: 'п. 14.7', paragraph_index: 147,
      source_fragment: 'Подрядчик обеспечивает присутствие представителя на еженедельных совещаниях.',
      basis: 'Присутствие представителя на совещаниях' }),
  ];
  assert.equal(clusterPairs(far, T).length, 2, 'разные темы вне таксономии не слипаются');

  const near = [
    pair({ id: 'n1', tz_clause: 'п. 2.1', paragraph_index: 21,
      source_fragment: 'Подрядчик согласовывает колористическое решение фасада с архитектором проекта.',
      basis: 'Колористическое решение фасада согласовывает подрядчик' }),
    pair({ id: 'n2', tz_clause: 'п. 2.8', paragraph_index: 28,
      source_fragment: 'Колористическое решение фасада согласовывается Подрядчиком с архитектором проекта повторно.',
      basis: 'Колористическое решение фасада согласовывает подрядчик' }),
  ];
  const merged = clusterPairs(near, T);
  assert.equal(merged.length, 1, 'почти дословный повтор вне таксономии — одно замечание');
  assert.equal(merged[0].occurrence_count, 2);
});

test('повтор одного места разными сигналами: одно вхождение, а не два', () => {
  const pairs = [
    pair({ id: 'r1', tz_clause: 'п. 4.1', paragraph_index: 41, category: 'coverage',
      source_fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки.',
      basis: 'Уборка не учтена в ВОР' }),
    pair({ id: 'r2', tz_clause: 'п. 4.1', paragraph_index: 41, category: 'risk',
      source_fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки.',
      basis: 'Уборка не учтена в КП' }),
  ];
  const c = single(pairs, 1);
  assert.equal(c.item_count, 2, 'оба сигнала в кластере');
  assert.equal(c.evidence_fragments.length, 1, 'место одно — вхождение одно');
});

// --- Чистые функции topicModel ----------------------------------------------

test('detectWorkObject различает исполнительную и проектную документацию', () => {
  assert.equal(detect('Подрядчик передаёт исполнительную документацию'), 'as_built_docs');
  assert.equal(detect('Подрядчик разрабатывает рабочую документацию узлов'), 'design_docs');
  assert.equal(detect('Стороны подписывают протокол'), null);

  function detect(text) {
    const r = topicModel.detectWorkObject(text);
    return r ? r.id : null;
  }
});

test('sectionLabel сводит пункт к корневому разделу', () => {
  assert.equal(topicModel.sectionLabel('п. 5.1.2 Состав работ'), 'Раздел 5');
  assert.equal(topicModel.sectionLabel('12.4'), 'Раздел 12');
  assert.equal(topicModel.sectionLabel('Общие положения'), 'Общие положения');
  assert.equal(topicModel.sectionLabel(null), null);
});

test('riskTypeOf сводит формулировки агентов к семейству риска', () => {
  assert.equal(topicModel.riskTypeOf({ problem_type: 'не_учтено_в_кп' }), 'coverage_gap');
  assert.equal(topicModel.riskTypeOf({ problem_type: 'не учтено в ВОР' }), 'coverage_gap');
  assert.equal(topicModel.riskTypeOf({ problem_type: 'открытый_объём' }), 'open_scope');
  assert.equal(topicModel.riskTypeOf({ problem_type: null, category: 'risk' }), 'risk');
});

test('mergeGroups не сливает группы одного места ни при какой близости', () => {
  const topic = { topicKey: 'same', workObject: 'cleaning', stems: topicModel.stemSet('уборка территории подрядчиком') };
  const groups = [
    { key: 'k1', placeKey: 'clause:п. 7.2', paragraphIndex: 72, pairs: [], topic },
    { key: 'k2', placeKey: 'clause:п. 7.2', paragraphIndex: 72, pairs: [], topic },
  ];
  assert.equal(topicModel.mergeGroups(groups).length, 2);
});
