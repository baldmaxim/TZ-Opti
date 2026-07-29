'use strict';

// МЕТРИКИ качества анализа по классификации evaluator.evaluateDocument.
//
// Определения (знаменатель везде — ОПУБЛИКОВАННЫЕ находки, если не сказано иное):
//   precision             = tp / published
//   recall                = закрытые эталоны / все эталоны
//   precision_at_10 / _20 = tp среди первых K находок по rank / min(K, published)
//   recall_critical       = закрытые критические эталоны / критические эталоны
//   duplicate_rate        = дубли / published
//   informational_leakage = утечки запрещённого / published
//   unsupported_rate      = находки без опоры (нет якоря в документе или
//                           основания) / published
//   no_consequence_count  = ЧИСЛО находок без конкретного последствия (абсолют)
// Неопределённая дробь (знаменатель 0) — null, а не 0: «нечего измерять» и
// «нулевое качество» различимы.
//
// Агрегация по набору: счётные метрики — микро (суммы числителей/знаменателей),
// precision@K — макро (среднее по документам с published > 0): ранги находок
// сопоставимы только внутри одного документа.
//
// Чистый модуль: без БД, без сети, без LLM.

const round4 = (n) => Number(n.toFixed(4));

function ratio(numerator, denominator) {
  return denominator > 0 ? round4(numerator / denominator) : null;
}

// rankedClasses — классы опубликованных находок в порядке rank.
function precisionAtK(rankedClasses, k) {
  const ranked = Array.isArray(rankedClasses) ? rankedClasses : [];
  if (!ranked.length) return null;
  const top = ranked.slice(0, Math.min(k, ranked.length));
  return ratio(top.filter((c) => c === 'tp').length, top.length);
}

function computeDocumentMetrics(result) {
  return {
    precision: ratio(result.true_positives.length, result.published_count),
    recall: ratio(result.expected_matched, result.expected_total),
    precision_at_10: precisionAtK(result.ranked_classes, 10),
    precision_at_20: precisionAtK(result.ranked_classes, 20),
    recall_critical: ratio(result.expected_critical_matched, result.expected_critical_total),
    duplicate_rate: ratio(result.duplicates.length, result.published_count),
    informational_leakage: ratio(result.informational.length, result.published_count),
    unsupported_rate: ratio(result.unsupported.length, result.published_count),
    no_consequence_count: result.no_consequence.length,
  };
}

function macroMean(values) {
  const defined = values.filter((v) => v != null);
  if (!defined.length) return null;
  return round4(defined.reduce((s, v) => s + v, 0) / defined.length);
}

function aggregateMetrics(results) {
  const sum = (fn) => results.reduce((s, r) => s + fn(r), 0);
  const counts = {
    documents: results.length,
    published: sum((r) => r.published_count),
    unpublished: sum((r) => r.unpublished_count),
    true_positives: sum((r) => r.true_positives.length),
    false_positives: sum((r) => r.false_positives.length),
    false_negatives: sum((r) => r.false_negatives.length),
    duplicates: sum((r) => r.duplicates.length),
    informational: sum((r) => r.informational.length),
    unsupported: sum((r) => r.unsupported.length),
    no_consequence: sum((r) => r.no_consequence.length),
    expected_total: sum((r) => r.expected_total),
    expected_matched: sum((r) => r.expected_matched),
    expected_critical_total: sum((r) => r.expected_critical_total),
    expected_critical_matched: sum((r) => r.expected_critical_matched),
  };
  const perDoc = results.map((r) => computeDocumentMetrics(r));
  const metrics = {
    precision: ratio(counts.true_positives, counts.published),
    recall: ratio(counts.expected_matched, counts.expected_total),
    precision_at_10: macroMean(perDoc.map((m) => m.precision_at_10)),
    precision_at_20: macroMean(perDoc.map((m) => m.precision_at_20)),
    recall_critical: ratio(counts.expected_critical_matched, counts.expected_critical_total),
    duplicate_rate: ratio(counts.duplicates, counts.published),
    informational_leakage: ratio(counts.informational, counts.published),
    unsupported_rate: ratio(counts.unsupported, counts.published),
    no_consequence_count: counts.no_consequence,
  };
  return { counts, metrics };
}

module.exports = { ratio, precisionAtK, computeDocumentMetrics, aggregateMetrics };
