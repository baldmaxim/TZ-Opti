'use strict';

// Юнит-тесты слоя self-analysis (QC/полнота над итогом) — без БД и LLM.
// Проверяют чистое ядро: эвристические детекторы + нормализацию LLM-находок.
// Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSignalStats,
  detectMissedCoverage,
  detectWeakClusters,
  detectContradictions,
  detectEnrichmentNeeds,
  normalizeLlmFinding,
  assembleFindings,
  runHeuristics,
} = require('../services/selfAnalysis/selfAnalysisService');

// Кластер в форме, которую отдаёт clustering.listClusters('full').
function cluster(over = {}) {
  return {
    id: 'c1',
    tz_clause: 'п. 5.1',
    cluster_title: 'Влияние на стоимость — п. 5.1',
    merged_basis: '• [coverage] Демонтаж не учтён в КП и должен быть оценён отдельной строкой расчёта',
    merged_recommendation: '• Ограничить объём ссылкой на раздел 5',
    overall_criticality: 'medium',
    final_problem_type: 'не_учтено_в_кп',
    semantic_bucket: 'price|edit',
    item_count: 2,
    paragraph_index: 5,
    items: [{ category: 'coverage', confidence: 0.8 }],
    ...over,
  };
}

// --- missed_coverage: категория сигналов без кластера --------------------------

test('computeSignalStats отмечает категорию сигналов, не отражённую в кластерах', () => {
  const signals = [
    { signal_type: 'coverage' },
    { signal_type: 'coverage' },
    { signal_type: 'risk' }, // нет кластера с category=risk
  ];
  const clusters = [cluster({ items: [{ category: 'coverage', confidence: 0.8 }] })];
  const stats = computeSignalStats(signals, clusters);
  assert.deepEqual(stats.missedCategories, ['risk']);
  assert.equal(stats.signals_total, 3);

  const missed = detectMissedCoverage(stats);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].finding_type, 'missed_coverage');
  assert.equal(missed[0].cluster_id, null); // про весь ТЗ
});

test('computeSignalStats: все категории покрыты — пропусков нет', () => {
  const signals = [{ signal_type: 'coverage' }, { signal_type: 'risk' }];
  const clusters = [
    cluster({ id: 'a', items: [{ category: 'coverage', confidence: 0.8 }] }),
    cluster({ id: 'b', items: [{ category: 'risk', confidence: 0.8 }] }),
  ];
  const stats = computeSignalStats(signals, clusters);
  assert.deepEqual(stats.missedCategories, []);
  assert.equal(detectMissedCoverage(stats).length, 0);
});

// --- weak_cluster: тонкое основание / нет рекомендации (не high/critical) -------

test('detectWeakClusters флагает кластер с коротким основанием и без рекомендации', () => {
  const weak = cluster({ merged_basis: '• общее', merged_recommendation: '', overall_criticality: 'low' });
  const res = detectWeakClusters([weak]);
  assert.equal(res.length, 1);
  assert.equal(res[0].finding_type, 'weak_cluster');
  assert.equal(res[0].cluster_id, 'c1');
});

test('detectWeakClusters НЕ трогает здоровый кластер', () => {
  assert.equal(detectWeakClusters([cluster()]).length, 0);
});

test('detectWeakClusters пропускает high/critical (их разбирает needs_enrichment)', () => {
  const hot = cluster({ merged_basis: '• общее', merged_recommendation: '', overall_criticality: 'high' });
  assert.equal(detectWeakClusters([hot]).length, 0);
});

// --- needs_enrichment: важный кластер недо-оформлен ----------------------------

test('detectEnrichmentNeeds флагает high-кластер без готовой рекомендации', () => {
  const hot = cluster({ overall_criticality: 'high', merged_recommendation: '' });
  const res = detectEnrichmentNeeds([hot]);
  assert.equal(res.length, 1);
  assert.equal(res[0].finding_type, 'needs_enrichment');
  assert.equal(res[0].cluster_id, 'c1');
});

test('detectEnrichmentNeeds не трогает оформленный high-кластер', () => {
  const ok = cluster({ overall_criticality: 'high' }); // есть basis + recommendation
  assert.equal(detectEnrichmentNeeds([ok]).length, 0);
});

// --- cluster_contradiction: конфликт remove vs note/edit на одном месте ---------

test('detectContradictions ловит «убрать» vs «оставить» на одном пункте ТЗ', () => {
  const remove = cluster({ id: 'rm', semantic_bucket: 'responsibility|remove', cluster_title: 'Убрать из объёма' });
  const keep = cluster({ id: 'keep', semantic_bucket: 'contract|note', cluster_title: 'Оставить, прокомментировать' });
  const res = detectContradictions([remove, keep]);
  assert.equal(res.length, 1);
  assert.equal(res[0].finding_type, 'cluster_contradiction');
  assert.equal(res[0].cluster_id, 'rm');
  assert.equal(res[0].related_cluster_id, 'keep');
});

test('detectContradictions: разные места ТЗ — не конфликт', () => {
  const remove = cluster({ id: 'rm', tz_clause: 'п. 5.1', semantic_bucket: 'responsibility|remove' });
  const keep = cluster({ id: 'keep', tz_clause: 'п. 7.2', semantic_bucket: 'contract|note' });
  assert.equal(detectContradictions([remove, keep]).length, 0);
});

test('detectContradictions: оба «оставить» — не конфликт', () => {
  const a = cluster({ id: 'a', semantic_bucket: 'price|edit' });
  const b = cluster({ id: 'b', semantic_bucket: 'contract|note' });
  assert.equal(detectContradictions([a, b]).length, 0);
});

// --- normalizeLlmFinding: валидация типа / cluster_id / confidence --------------

test('normalizeLlmFinding отбрасывает несуществующий cluster_id и чужой тип', () => {
  const ids = new Set(['c1']);
  const ok = normalizeLlmFinding(
    { finding_type: 'weak_cluster', cluster_id: 'c1', comment: 'x', suggested_improvement: 'y', confidence: 0.8 },
    ids,
  );
  assert.equal(ok.cluster_id, 'c1');
  assert.equal(ok.source, 'llm');

  const bad = normalizeLlmFinding(
    { finding_type: 'nonsense', cluster_id: 'ghost', comment: 'x', confidence: 5 },
    ids,
  );
  assert.equal(bad.finding_type, 'missed_coverage'); // дефолт при неизвестном типе
  assert.equal(bad.cluster_id, null); // несуществующий id → null
  assert.equal(bad.confidence, 1); // 5 → клампится в [0,1]
});

// --- assembleFindings: дедуп эвристик + LLM ------------------------------------

test('assembleFindings убирает дубль (тип + cluster_id + начало comment)', () => {
  const h = [{ finding_type: 'weak_cluster', cluster_id: 'c1', comment: 'Слабый кластер по п. 5.1 — мало данных' }];
  const l = [{ finding_type: 'weak_cluster', cluster_id: 'c1', comment: 'Слабый кластер по п. 5.1 — мало данных' }];
  assert.equal(assembleFindings(h, l).length, 1);
});

test('runHeuristics не падает на пустом входе', () => {
  const stats = computeSignalStats([], []);
  assert.deepEqual(runHeuristics([], stats), []);
});
