'use strict';

// СБОРКА подробного отчёта benchmark-прогона: JSON (машиночитаемый, для
// сравнения алгоритмов между прогонами) + Markdown (человекочитаемый).
// Чистый модуль: без БД, без сети, без LLM.

const { computeDocumentMetrics, aggregateMetrics } = require('./metrics');

const METRIC_LABELS = Object.freeze({
  precision: 'Precision (точность публикаций)',
  recall: 'Recall (полнота по эталону)',
  precision_at_10: 'Precision@10',
  precision_at_20: 'Precision@20',
  recall_critical: 'Recall критических рисков',
  duplicate_rate: 'Duplicate rate (доля дублей)',
  informational_leakage: 'Informational leakage (утечка нематериального)',
  unsupported_rate: 'Unsupported rate (доля находок без опоры)',
  no_consequence_count: 'Замечаний без конкретного последствия (шт.)',
});

// runOutput — результат benchmarkRunner.runBenchmark.
function buildReport(runOutput, { generatedAt = null } = {}) {
  const evaluations = runOutput.results.map((r) => r.evaluation);
  const aggregate = aggregateMetrics(evaluations);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    algorithm: runOutput.algorithm || null,
    dataset_path: runOutput.dataset_path,
    findings_path: runOutput.findings_path,
    unknown_documents: runOutput.unknown_documents,
    aggregate,
    documents: runOutput.results.map((r) => ({
      document_id: r.evaluation.document_id,
      description: r.description,
      missing_findings_file: r.missing_findings_file,
      metrics: computeDocumentMetrics(r.evaluation),
      details: r.evaluation,
    })),
  };
}

// --- Markdown ----------------------------------------------------------------

const fmt = (v) => (v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(3)));
const flagsOf = (item) => Object.entries(item.flags || {})
  .filter(([, v]) => v)
  .map(([k]) => k);

function metricsTable(metrics) {
  const lines = ['| Метрика | Значение |', '| --- | --- |'];
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    lines.push(`| ${label} | ${fmt(metrics[key])} |`);
  }
  return lines.join('\n');
}

function renderDocument(doc) {
  const d = doc.details;
  const out = [];
  out.push(`### ${doc.document_id}`);
  if (doc.description) out.push(`_${doc.description}_`);
  if (doc.missing_findings_file) {
    out.push('> ⚠ Для документа не подан файл результатов агента — все эталоны засчитаны как false negative.');
  }
  out.push('');
  out.push(metricsTable(doc.metrics));
  out.push('');
  out.push(`Опубликовано: ${d.published_count}, не опубликовано: ${d.unpublished_count}, эталонов: ${d.expected_total} (критических: ${d.expected_critical_total}).`);

  const section = (title, rows) => {
    if (!rows.length) return;
    out.push('', `**${title}**`);
    for (const row of rows) out.push(`- ${row}`);
  };

  section('True positive', d.true_positives.map((t) => {
    const extra = flagsOf(t);
    return `\`${t.finding_id}\` → эталон \`${t.expected_id}\` (score ${t.score})${extra.length ? ` — флаги: ${extra.join(', ')}` : ''}`;
  }));
  section('False negative (пропущенные эталоны)', d.false_negatives.map((f) => {
    const cand = f.best_candidate
      ? ` ближайший кандидат \`${f.best_candidate.finding_id}\` (score ${f.best_candidate.score}${f.best_candidate.published ? '' : ', не опубликован'})`
      : '';
    return `\`${f.expected_id}\` [${f.kind}] — причины: ${f.reasons.join(', ')}.${cand}`;
  }));
  section('False positive', d.false_positives.map((f) => {
    const near = f.nearest_expected
      ? ` ближайший эталон \`${f.nearest_expected.expected_id}\` (score ${f.nearest_expected.score})`
      : '';
    return `\`${f.finding_id}\` — причины: ${f.reasons.join(', ')}.${near}`;
  }));
  section('Дубли', d.duplicates.map((f) => `\`${f.finding_id}\` — повтор эталона \`${f.duplicate_of_expected}\``));
  section('Утечка нематериального (informational)', d.informational.map((f) => `\`${f.finding_id}\` — совпало с запрещённым \`${f.forbidden_id}\` (${f.forbidden_reason})`));
  section('Без опоры (unsupported)', d.unsupported.map((id) => `\`${id}\``));
  section('Без конкретного последствия', d.no_consequence.map((id) => `\`${id}\``));
  out.push('');
  return out.join('\n');
}

function renderMarkdown(report) {
  const out = [];
  out.push('# Benchmark-отчёт: качество ИИ-анализа ТЗ');
  out.push('');
  if (report.generated_at) out.push(`Сформирован: ${report.generated_at}`);
  out.push(`Алгоритм: ${report.algorithm || 'не указан'}`);
  out.push(`Набор: \`${report.dataset_path}\` (${report.documents.length} документов)`);
  out.push(`Результаты агента: \`${report.findings_path}\``);
  if (report.unknown_documents.length) {
    out.push(`> ⚠ В результатах есть документы вне набора: ${report.unknown_documents.join(', ')}`);
  }
  out.push('', '## Сводные метрики', '');
  out.push(metricsTable(report.aggregate.metrics));
  const c = report.aggregate.counts;
  out.push('');
  out.push(`Итого: опубликовано ${c.published}, TP ${c.true_positives}, FP ${c.false_positives}, FN ${c.false_negatives}, дублей ${c.duplicates}, утечек ${c.informational}, без опоры ${c.unsupported}.`);
  out.push('', '## По документам', '');
  for (const doc of report.documents) out.push(renderDocument(doc));
  return out.join('\n');
}

module.exports = { METRIC_LABELS, buildReport, renderMarkdown };
