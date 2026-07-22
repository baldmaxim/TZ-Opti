'use strict';

// Юнит-тесты слоя clustering (объединение похожих замечаний по одному месту ТЗ)
// — без БД и LLM. Проверяют чистое ядро clusterPairs/buildCluster. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clusterPairs, dominantDimension, semanticBucket } = require('../../services/clustering/clusteringService');

const T = 'tender-1';

// Пара {draft, review} в форме, которую отдаёт loadPairs.
function pair(draft, review) {
  return {
    draft: {
      id: 'd', tz_clause: null, source_fragment: null, problem_type: null,
      category: null, basis: null, suggested_action: null, suggested_redaction: null,
      review_comment: null, paragraph_index: 0, ...draft,
    },
    review: review === null ? null : {
      display_priority: 'medium', show_to_engineer: true, score: 4,
      price_impact: 'none', schedule_impact: 'none', contract_impact: 'none',
      responsibility_impact: 'none', ...review,
    },
  };
}

// --- Пример из спеки: 1 кластер из 3 draft_issues --------------------------

test('1 кластер из 3 похожих замечаний одного пункта ТЗ', () => {
  const pairs = [
    pair(
      { id: 'a', tz_clause: 'п. 5.1 Состав работ', category: 'coverage', problem_type: 'не_учтено_в_кп',
        basis: 'Демонтаж не учтён в КП', suggested_action: 'edit', paragraph_index: 5 },
      { display_priority: 'high', score: 7, price_impact: 'high' },
    ),
    pair(
      { id: 'b', tz_clause: 'п. 5.1 Состав работ', category: 'coverage', problem_type: 'не_учтено_в_вор',
        basis: 'Демонтаж не учтён в ВОР', suggested_action: 'edit', paragraph_index: 5 },
      { display_priority: 'medium', score: 4, price_impact: 'high' },
    ),
    pair(
      { id: 'c', tz_clause: 'п. 5.1 Состав работ', category: 'risk', problem_type: 'не_подтверждён_пд',
        basis: 'Объём не подтверждён ПД', suggested_action: 'edit', paragraph_index: 5 },
      { display_priority: 'medium', score: 3, price_impact: 'medium' },
    ),
  ];

  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 1, 'три похожих замечания одного места -> один кластер');

  const c = clusters[0];
  assert.equal(c.item_count, 3);
  assert.equal(c.tz_clause, 'п. 5.1 Состав работ');
  assert.equal(c.overall_criticality, 'high', 'итоговая критичность = максимум по элементам');
  assert.equal(c.final_problem_type, 'не_учтено_в_кп', 'final_problem_type = problem_type первичного');
  assert.equal(c.show_to_engineer, true);

  // объединённое основание содержит вклад каждой стадии — смысл не теряется
  assert.match(c.merged_basis, /не учтён в КП/);
  assert.match(c.merged_basis, /не учтён в ВОР/);
  assert.match(c.merged_basis, /не подтверждён ПД/);

  // роли: один primary (самый значимый — a), остальные related
  const roles = c.items.reduce((m, it) => { m[it.draft_issue_id] = it.item_role; return m; }, {});
  assert.equal(roles.a, 'primary');
  assert.equal(roles.b, 'related');
  assert.equal(roles.c, 'related');
});

// --- Правило 4: разные по смыслу в одном пункте НЕ сливаются ----------------

test('открытый объём ≠ риск оплаты в одном пункте -> два разных кластера', () => {
  const pairs = [
    pair(
      { id: 'scope', tz_clause: 'п. 7.2', category: 'risk', problem_type: 'открытый_объём',
        basis: 'Работы в полном объёме за свой счёт', suggested_action: 'remove_from_scope', paragraph_index: 7 },
      { display_priority: 'high', score: 8, price_impact: 'medium', responsibility_impact: 'high' },
    ),
    pair(
      { id: 'pay', tz_clause: 'п. 7.2', category: 'condition', problem_type: 'риск_оплаты',
        basis: 'Оплата по факту приёмки без аванса', suggested_action: 'accept', paragraph_index: 7 },
      { display_priority: 'high', score: 7, contract_impact: 'high' },
    ),
  ];

  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 2, 'разный смысл (объём vs оплата) -> два кластера, не слиплись');
  assert.ok(clusters.every((c) => c.item_count === 1));
  // у них разные смысловые ключи
  const buckets = new Set(clusters.map((c) => c.semantic_bucket));
  assert.equal(buckets.size, 2);
});

test('dominantDimension и semanticBucket разделяют объём и оплату', () => {
  const scope = dominantDimension({ price_impact: 'medium', responsibility_impact: 'high', contract_impact: 'none' });
  const pay = dominantDimension({ contract_impact: 'high', price_impact: 'low' });
  assert.equal(scope, 'responsibility');
  assert.equal(pay, 'contract');
  assert.notEqual(
    semanticBucket({ suggested_action: 'remove_from_scope' }, { responsibility_impact: 'high' }),
    semanticBucket({ suggested_action: 'accept' }, { contract_impact: 'high' }),
  );
});

// --- Группировка по месту ---------------------------------------------------

test('один смысл, но разные пункты ТЗ -> разные кластеры', () => {
  const pairs = [
    pair({ id: 'x', tz_clause: 'п. 1', category: 'coverage', suggested_action: 'edit' }, { price_impact: 'high' }),
    pair({ id: 'y', tz_clause: 'п. 2', category: 'coverage', suggested_action: 'edit' }, { price_impact: 'high' }),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 2);
});

test('место по фрагменту, когда нет tz_clause', () => {
  const frag = 'Подрядчик обеспечивает охрану объекта.';
  const pairs = [
    pair({ id: 'f1', source_fragment: frag, tz_clause: null, paragraph_index: null, category: 'risk', suggested_action: 'edit' }, { contract_impact: 'high' }),
    pair({ id: 'f2', source_fragment: '  Подрядчик   обеспечивает охрану объекта. ', tz_clause: null, paragraph_index: null, category: 'risk', suggested_action: 'edit' }, { contract_impact: 'high' }),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 1, 'один фрагмент (с точностью до пробелов) -> один кластер');
  assert.equal(clusters[0].item_count, 2);
});

// --- show_to_engineer и overall_criticality ---------------------------------

test('кластер показывается, если значим хотя бы один элемент', () => {
  const pairs = [
    pair({ id: 's1', tz_clause: 'п. 9', category: 'coverage', suggested_action: 'edit' },
      { display_priority: 'low', show_to_engineer: false, price_impact: 'high' }),
    pair({ id: 's2', tz_clause: 'п. 9', category: 'coverage', suggested_action: 'edit' },
      { display_priority: 'high', show_to_engineer: true, price_impact: 'high' }),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].show_to_engineer, true);
  assert.equal(clusters[0].overall_criticality, 'high');
});

test('кластер из одних малозначимых -> скрыт', () => {
  const pairs = [
    pair({ id: 'w1', tz_clause: 'п. 12', category: 'decision', suggested_action: 'note' },
      { display_priority: 'low', show_to_engineer: false }),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters[0].show_to_engineer, false);
  assert.equal(clusters[0].overall_criticality, 'low');
});

test('без critic-вердикта (review=null) кластеризация не падает', () => {
  const pairs = [
    pair({ id: 'n1', tz_clause: 'п. 3', category: 'coverage', suggested_action: 'edit', basis: 'b1' }, null),
    pair({ id: 'n2', tz_clause: 'п. 3', category: 'coverage', suggested_action: 'edit', basis: 'b2' }, null),
  ];
  const clusters = clusterPairs(pairs, T);
  assert.equal(clusters.length, 1, 'без review -> общий bucket general|edit, один кластер');
  assert.equal(clusters[0].item_count, 2);
  assert.equal(clusters[0].overall_criticality, 'low');
});
