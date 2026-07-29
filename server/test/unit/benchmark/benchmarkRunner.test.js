'use strict';

// End-to-end тест benchmark-контура на синтетическом наборе репозитория:
// прогон sample-agent против benchmark/datasets/synthetic. Без БД, без сети,
// без LLM — только файлы. Заодно регресс формата набора и демо-результатов.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runBenchmark, loadDataset } = require('../../../services/benchmark/benchmarkRunner');
const { buildReport, renderMarkdown } = require('../../../services/benchmark/reporter');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const DATASET = path.join(ROOT, 'benchmark', 'datasets', 'synthetic');
const FINDINGS = path.join(ROOT, 'benchmark', 'runs', 'sample-agent');

function docResult(report, id) {
  const doc = report.documents.find((d) => d.document_id === id);
  assert.ok(doc, `в отчёте нет документа ${id}`);
  return doc;
}

test('синтетический набор + sample-agent: полный круг с ожидаемыми исходами', () => {
  const run = runBenchmark({ datasetDir: DATASET, findingsPath: FINDINGS });
  const report = buildReport(run);

  assert.equal(report.documents.length, 6);
  assert.deepEqual(report.unknown_documents, []);

  // Доказанный неучтённый объём: критический эталон закрыт, рабочий пропущен.
  const d1 = docResult(report, 'synt-001-unaccounted-volume');
  assert.equal(d1.details.true_positives.length, 1);
  assert.equal(d1.details.true_positives[0].expected_id, 'exp-001-demolition');
  assert.equal(d1.details.false_negatives.length, 1);
  assert.equal(d1.details.false_negatives[0].expected_id, 'exp-001-landscaping');
  assert.ok(d1.details.false_negatives[0].reasons.length > 0);

  // Укрупнённая позиция ВОР: рабочее замечание закрыто.
  const d2 = docResult(report, 'synt-002-aggregated-vor');
  assert.equal(d2.metrics.precision, 1);
  assert.equal(d2.metrics.recall, 1);

  // Стандартное нормативное требование опубликовано → утечка нематериального.
  const d3 = docResult(report, 'synt-003-standard-requirement');
  assert.equal(d3.details.informational.length, 1);
  assert.equal(d3.details.informational[0].forbidden_reason, 'standard_requirement');
  assert.equal(d3.metrics.informational_leakage, 1);
  // Ссылка на СП без последствия — попадает и в no_consequence.
  assert.equal(d3.metrics.no_consequence_count, 1);

  // Редакционное замечание корректно подавлено — публикаций нет.
  const d4 = docResult(report, 'synt-004-editorial');
  assert.equal(d4.details.published_count, 0);
  assert.equal(d4.details.unpublished_count, 1);
  assert.equal(d4.metrics.informational_leakage, null);

  // Обязанность без ограничения объёма: TP + выдуманная находка без опоры (FP).
  const d5 = docResult(report, 'synt-005-open-duty');
  assert.equal(d5.details.true_positives.length, 1);
  assert.equal(d5.details.false_positives.length, 1);
  assert.equal(d5.details.false_positives[0].flags.unsupported, true);
  assert.equal(d5.metrics.unsupported_rate, 0.5);

  // Один риск двумя стадиями: одно TP, второе вхождение — дубль.
  const d6 = docResult(report, 'synt-006-duplicate-stages');
  assert.equal(d6.details.true_positives.length, 1);
  assert.equal(d6.details.duplicates.length, 1);
  assert.equal(d6.details.duplicates[0].duplicate_of_expected, 'exp-006-retention');

  // Сводные метрики.
  const agg = report.aggregate;
  assert.equal(agg.counts.published, 7);
  assert.equal(agg.counts.true_positives, 4);
  assert.equal(agg.counts.false_positives, 1);
  assert.equal(agg.counts.false_negatives, 1);
  assert.equal(agg.counts.duplicates, 1);
  assert.equal(agg.counts.informational, 1);
  assert.equal(agg.metrics.precision, Number((4 / 7).toFixed(4)));
  assert.equal(agg.metrics.recall, 0.8); // 4 из 5 эталонов
  assert.equal(agg.metrics.recall_critical, 1); // все 3 критических закрыты
  assert.equal(agg.metrics.duplicate_rate, Number((1 / 7).toFixed(4)));
  assert.equal(agg.metrics.no_consequence_count, 2); // утечка СП + находка без опоры

  // Markdown-отчёт собирается и содержит ключевые разделы.
  const md = renderMarkdown(report);
  assert.match(md, /Сводные метрики/);
  assert.match(md, /False negative/);
  assert.match(md, /Дубли/);
});

test('валидация эталона: неточная цитата и битые словари не проходят', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-benchmark-'));
  try {
    fs.writeFileSync(path.join(dir, 'doc.md'), 'п. 1.1. Настоящий текст документа.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'doc.gold.json'), JSON.stringify({
      document_id: 'doc',
      source: 'doc.md',
      expected: [{
        id: 'e1',
        kind: 'critical',
        quote: 'Этой цитаты в документе нет.',
        risk_category: 'x',
        expected_impact: 'громадный',
        required_basis: 'основание',
      }],
      forbidden: [{ id: 'f1', quote: 'п. 1.1. Настоящий текст документа.', reason: 'не_словарная_причина' }],
    }), 'utf8');
    assert.throws(() => loadDataset(dir), (e) => {
      assert.match(e.message, /точная цитата не найдена/);
      assert.match(e.message, /expected_impact/);
      assert.match(e.message, /reason/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('пропущенный findings-файл документа: эталоны уходят в false negative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-benchmark-run-'));
  try {
    // Результаты только для одного документа из шести.
    const one = fs.readFileSync(
      path.join(FINDINGS, 'synt-001-unaccounted-volume.findings.json'), 'utf8',
    );
    fs.writeFileSync(path.join(dir, 'only-one.json'), one, 'utf8');
    const run = runBenchmark({ datasetDir: DATASET, findingsPath: dir });
    const report = buildReport(run);
    const d5 = docResult(report, 'synt-005-open-duty');
    assert.equal(d5.missing_findings_file, true);
    assert.equal(d5.details.false_negatives.length, 1);
    assert.deepEqual(d5.details.false_negatives[0].reasons, ['no_findings']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
