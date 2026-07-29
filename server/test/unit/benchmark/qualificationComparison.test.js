'use strict';

// End-to-end тест shadow-сравнения «до/после квалификационного фильтра» на
// синтетическом наборе репозитория (sample-agent). Без БД, без сети, без LLM.
//
// Проверяет целевые показатели фильтра на синтетике:
//   recall критических = 1.0; precision и precision@20 ≥ 0.75;
//   informational leakage ≤ 0.05; unsupported rate ≤ 0.05;
//   находок без последствия = 0; recall не падает; TP не скрываются.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runBenchmark } = require('../../../services/benchmark/benchmarkRunner');
const { buildReport } = require('../../../services/benchmark/reporter');
const {
  runQualifiedBenchmark,
  buildQualificationReport,
  renderQualificationMarkdown,
} = require('../../../services/benchmark/qualificationComparison');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const DATASET = path.join(ROOT, 'benchmark', 'datasets', 'synthetic');
const FINDINGS = path.join(ROOT, 'benchmark', 'runs', 'sample-agent');

function findingsSnapshot() {
  return fs.readdirSync(FINDINGS).sort().map(
    (f) => `${f}:${fs.readFileSync(path.join(FINDINGS, f), 'utf8')}`,
  ).join('\n---\n');
}

test('qualification gate на синтетике: шум удалён, критический recall сохранён', () => {
  const before = findingsSnapshot();
  const run = runQualifiedBenchmark({ datasetDir: DATASET, findingsPath: FINDINGS });
  const report = buildQualificationReport(run, { generatedAt: '2026-07-29T00:00:00.000Z' });

  // Shadow mode: файлы результатов агента на диске не изменились.
  assert.equal(findingsSnapshot(), before);

  // «До» совпадает с обычным benchmark-прогоном (фильтр ничего не меняет в raw).
  const plain = buildReport(runBenchmark({ datasetDir: DATASET, findingsPath: FINDINGS }));
  assert.deepEqual(report.metrics_before, plain.aggregate.metrics);
  assert.deepEqual(report.counts_before, plain.aggregate.counts);

  // Целевые показатели после фильтра.
  const after = report.metrics_after;
  assert.equal(after.recall_critical, 1, 'критический recall обязан быть 1.0');
  assert.ok(after.precision >= 0.75, `precision ${after.precision} < 0.75`);
  assert.ok(after.precision_at_20 >= 0.75, `precision@20 ${after.precision_at_20} < 0.75`);
  assert.ok((after.informational_leakage || 0) <= 0.05, 'informational leakage > 0.05');
  assert.ok((after.unsupported_rate || 0) <= 0.05, 'unsupported rate > 0.05');
  assert.equal(after.no_consequence_count, 0, 'после фильтра не должно остаться находок без последствия');

  // Recall не снизился: review-полка видима инженеру и в qualified входит.
  assert.equal(after.recall, report.metrics_before.recall);

  // Ни один true positive не скрыт, шум (FP / дубль / утечка) удалён.
  assert.equal(report.totals.lost_true_positives, 0);
  assert.equal(report.totals.surviving_noise, 0);
  assert.ok(report.totals.removed_noise >= 3,
    `ожидалось ≥3 удалённых шумовых находок, got ${report.totals.removed_noise}`);

  // Точечные исходы gate по известным находкам sample-agent.
  const decision = (docId, findingId) => report.documents
    .find((d) => d.document_id === docId).decisions
    .find((d) => d.finding_id === findingId);
  assert.equal(decision('synt-001-unaccounted-volume', 's1-f1').qualification, 'publish');
  assert.equal(decision('synt-002-aggregated-vor', 's2-f1').qualification, 'review');
  const std = decision('synt-003-standard-requirement', 's3-f1');
  assert.ok(std.qualification === 'hide' || std.qualification === 'reject');
  assert.equal(decision('synt-005-open-duty', 's5-f1').qualification, 'publish');
  assert.equal(decision('synt-005-open-duty', 's5-f2').qualification, 'reject');
  assert.equal(decision('synt-006-duplicate-stages', 's6-f1').qualification, 'publish');
  const dup = decision('synt-006-duplicate-stages', 's6-f2');
  assert.ok(dup.qualification === 'reject' || dup.qualification === 'hide');
  assert.ok(dup.reasons.concat(dup.rule).join(' ').match(/дубль|duplicate/i));

  // Markdown-отчёт сравнения собирается и содержит ключевые разделы.
  const md = renderQualificationMarkdown(report);
  assert.match(md, /Метрики до и после/);
  assert.match(md, /Ошибочно скрытые true positive/);
  assert.match(md, /Оставшиеся false positive/);
  assert.match(md, /Удалённые false positive/);
});

test('решения gate несут причины, требования и диагностический score', () => {
  const run = runQualifiedBenchmark({ datasetDir: DATASET, findingsPath: FINDINGS });
  const report = buildQualificationReport(run, { generatedAt: null });
  for (const doc of report.documents) {
    for (const d of doc.decisions) {
      assert.ok(['publish', 'review', 'hide', 'reject'].includes(d.qualification));
      assert.ok(['critical', 'high', 'medium', 'low', 'informational'].includes(d.priority));
      assert.ok(['strong', 'medium', 'weak', 'none'].includes(d.evidence_strength));
      assert.ok(Array.isArray(d.impact_types));
      assert.ok(Array.isArray(d.missing_requirements));
      assert.ok(Array.isArray(d.reasons) && d.reasons.length > 0, 'у каждого решения есть причина');
      assert.equal(typeof d.confidence, 'number');
      assert.equal(typeof d.source_strength, 'number');
      assert.ok(d.score_breakdown && typeof d.score_breakdown.total === 'number');
      assert.ok(d.rule, 'решение принято именованным правилом, а не баллом');
    }
  }
});
