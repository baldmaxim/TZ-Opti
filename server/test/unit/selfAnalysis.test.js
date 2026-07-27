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
  resolveSelfAnalysisOutcome,
  QC_STATUS,
} = require('../../services/selfAnalysis/selfAnalysisService');
const { runSelfAnalysisLlm, segmentsForQc } = require('../../services/stageAnalysis/stage5_llm');
const { STATUS } = require('../../services/analysis/resultStatus');
const { installFakeLlm } = require('../helpers/fakeLlm');

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
    semantic_bucket: 'price|modify',
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
  const a = cluster({ id: 'a', semantic_bucket: 'price|modify' });
  const b = cluster({ id: 'b', semantic_bucket: 'contract|note' });
  assert.equal(detectContradictions([a, b]).length, 0);
});

test('detectContradictions: remove vs modify (замена) — тоже конфликт', () => {
  const remove = cluster({ id: 'rm', semantic_bucket: 'responsibility|remove' });
  const modify = cluster({ id: 'mod', semantic_bucket: 'price|modify' });
  const res = detectContradictions([remove, modify]);
  assert.equal(res.length, 1, 'убрать пункт vs поправить текст — взаимоисключающие');
  assert.equal(res[0].related_cluster_id, 'mod');
});

// Back-compat: старые кластеры в БД могли хранить легаси-хвост '|edit' до
// унификации семейств — actionFamilyOf нормализует его в modify (keeper).
test('detectContradictions: легаси хвост |edit трактуется как modify (keeper)', () => {
  const remove = cluster({ id: 'rm', semantic_bucket: 'responsibility|remove' });
  const legacy = cluster({ id: 'lg', semantic_bucket: 'price|edit' });
  assert.equal(detectContradictions([remove, legacy]).length, 1);
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

// --- Исход LLM-шага QC: 0/N · 1/N · N/N частей ТЗ -------------------------------
//
// Главный защищаемый дефект: полный отказ QC (ни одна часть не досчитана) больше
// НЕ может превратиться в успешный результат на одних эвристиках. runSelfAnalysisLlm
// не бросает — отдаёт status, а решение об исходе слоя принимает
// resolveSelfAnalysisOutcome (usable=false → вызывающий обязан упасть).

const QC_FILLER = [
  'Подрядчик выполняет работы в объёме, определённом проектной документацией и',
  'настоящим техническим заданием, с соблюдением требований действующих норм,',
  'правил охраны труда и промышленной безопасности, а также графика работ.',
].join(' ');

// ТЗ, которое гарантированно режется на несколько частей (иначе 0/N и 1/N
// неотличимы).
function qcTzBlocks({ clauses = 12, fill = 6 } = {}) {
  const blocks = [{ index: 0, type: 'heading', level: 1, text: '1. Раздел 1. Общие требования', section_path: [] }];
  for (let c = 1; c <= clauses; c += 1) {
    blocks.push({
      index: c,
      type: 'paragraph',
      text: `1.${c} ${QC_FILLER} ${`Пункт 1.${c} уточняет порядок выполнения работ. `.repeat(fill)}`.trim(),
      section_path: ['1. Раздел 1. Общие требования'],
    });
  }
  return blocks;
}

const QC_BUDGET = 700;
const QC_CLUSTERS = [
  {
    id: 'c1',
    tz_clause: 'п. 1.1',
    cluster_title: 'Влияние на стоимость — п. 1.1',
    overall_criticality: 'high',
    semantic_bucket: 'price|modify',
    item_count: 2,
    merged_basis: '• [coverage] Демонтаж не учтён в расчёте и должен быть оценён отдельной строкой',
    merged_recommendation: '• Ограничить объём ссылкой на раздел 5',
    items: [{ category: 'coverage', confidence: 0.8 }],
  },
];
const QC_FINDING = {
  finding_type: 'weak_cluster',
  cluster_id: 'c1',
  comment: 'Основание кластера не подтверждено цитатой ТЗ',
  suggested_improvement: 'Добавить цитату п. 1.1',
  confidence: 0.7,
};

const qcArgs = (over = {}) => ({
  tzBlocks: qcTzBlocks(),
  clusters: QC_CLUSTERS,
  signalStats: computeSignalStats([{ signal_type: 'coverage' }], QC_CLUSTERS),
  budgetTokens: QC_BUDGET,
  llmConfigured: true,
  ...over,
});

const qcPartsTotal = () => segmentsForQc({ tzBlocks: qcTzBlocks(), budgetTokens: QC_BUDGET }).length;

test('0/N частей: LLM-QC упал целиком → failed, слой непригоден (не «успех на эвристиках»)', async (t) => {
  const total = qcPartsTotal();
  assert.ok(total > 1, `нужно ТЗ из нескольких частей, получено ${total}`);
  const llm = installFakeLlm(t, () => new Error('LLM недоступен'));

  const res = await runSelfAnalysisLlm(qcArgs());

  assert.equal(llm.callCount, total, 'каждая часть должна быть попробована');
  assert.equal(res.status, QC_STATUS.FAILED);
  assert.equal(res.status, STATUS.FAILED, 'исход QC = общий контракт результата');
  assert.deepEqual(res.findings, []);
  assert.equal(res.segmentation.failed_parts.length, total);
  assert.match(res.reason, /ни одна часть/i);

  // Ключевой инвариант: слой НЕ пригоден — вызывающий обязан признать сбой.
  const outcome = resolveSelfAnalysisOutcome(res);
  assert.equal(outcome.usable, false);
  assert.equal(outcome.status, STATUS.FAILED);
  assert.equal(outcome.partial, false, 'полный отказ — это не «частичный результат»');
});

test('1/N частей: часть посчитана, часть упала → completed_with_warnings + failed_parts', async (t) => {
  const total = qcPartsTotal();
  const llm = installFakeLlm(t, (call, idx) => (idx === 0
    ? { findings: [QC_FINDING] }
    : new Error(`часть ${idx + 1} не ответила`)));

  const res = await runSelfAnalysisLlm(qcArgs());

  assert.equal(llm.callCount, total);
  assert.equal(res.status, QC_STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(res.findings.length, 1, 'находки посчитанной части сохраняются');
  assert.equal(res.segmentation.failed_parts.length, total - 1);
  assert.equal(res.segmentation.completed_parts, 1);
  assert.deepEqual(res.segmentation.failed_parts[0], { part: 2, error: 'часть 2 не ответила' });

  const outcome = resolveSelfAnalysisOutcome(res);
  assert.equal(outcome.usable, true, 'частичный итог пригоден');
  assert.equal(outcome.status, STATUS.COMPLETED_WITH_WARNINGS);
  assert.equal(outcome.partial, true, 'partial → warning у стадии и шага конвейера');
  assert.equal(outcome.failed_parts.length, total - 1);
});

test('N/N частей: все посчитаны → completed без failed_parts', async (t) => {
  const total = qcPartsTotal();
  const llm = installFakeLlm(t, () => ({ findings: [QC_FINDING] }));

  const res = await runSelfAnalysisLlm(qcArgs());

  assert.equal(llm.callCount, total);
  assert.equal(res.status, QC_STATUS.COMPLETED);
  assert.equal(res.segmentation.failed_parts, null);
  assert.equal(res.segmentation.completed_parts, total);
  // Один и тот же дефект разбора, увиденный из разных частей, не дублируется.
  assert.equal(res.findings.length, 1);

  const outcome = resolveSelfAnalysisOutcome(res);
  assert.equal(outcome.status, STATUS.COMPLETED);
  assert.equal(outcome.partial, false);
  assert.equal(outcome.usable, true);
});

test('кластеров нет: not_applicable без вызова LLM — явный «проверять нечего», а не сбой', async (t) => {
  const llm = installFakeLlm(t, () => new Error('модель не должна вызываться'));

  for (const clusters of [[], null, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runSelfAnalysisLlm(qcArgs({ clusters }));
    assert.equal(res.status, QC_STATUS.NOT_APPLICABLE, `пустой список кластеров (${JSON.stringify(clusters)})`);
    assert.deepEqual(res.findings, []);
    assert.equal(res.segmentation, null);
    assert.match(res.reason, /кластеров нет/i);

    const outcome = resolveSelfAnalysisOutcome(res);
    assert.equal(outcome.status, STATUS.COMPLETED, 'нечего проверять — это не сбой слоя');
    assert.equal(outcome.usable, true);
    assert.equal(outcome.partial, false);
    assert.equal(outcome.failed_parts, null);
  }
  assert.equal(llm.callCount, 0, 'без кластеров QC не должен звать модель');
});

test('LLM не настроен: skipped (QC не выполнялся) → warning, но не failed', async (t) => {
  const llm = installFakeLlm(t, () => new Error('модель не должна вызываться'));

  const res = await runSelfAnalysisLlm(qcArgs({ llmConfigured: false }));

  assert.equal(llm.callCount, 0);
  assert.equal(res.status, QC_STATUS.SKIPPED);
  assert.match(res.reason, /OPENAI_API_KEY/);

  const outcome = resolveSelfAnalysisOutcome(res);
  assert.equal(outcome.status, STATUS.COMPLETED_WITH_WARNINGS, 'QC пропущен — зелёным это не считаем');
  assert.equal(outcome.usable, true, 'но эвристики пригодны — не сбой');
  assert.equal(outcome.partial, true);
});

test('resolveSelfAnalysisOutcome: неизвестный/отсутствующий исход QC → failed (fail-closed)', () => {
  for (const llm of [null, undefined, {}, { status: 'нечто' }, { status: QC_STATUS.FAILED }]) {
    const outcome = resolveSelfAnalysisOutcome(llm);
    assert.equal(outcome.status, STATUS.FAILED, `исход ${JSON.stringify(llm)} обязан быть отказом`);
    assert.equal(outcome.usable, false);
    assert.equal(outcome.llm_status, QC_STATUS.FAILED);
  }
});
