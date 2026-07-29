'use strict';

// CLI-запуск benchmark-контура оценки качества ИИ-анализа ТЗ.
//
// ГАРАНТИЯ ИЗОЛЯЦИИ: скрипт НЕ импортирует db/connection и вообще не имеет
// доступа к Postgres — production active pointers, analysis_runs и очередь
// заданий недостижимы физически. Вход и выход — только файлы на диске.
//
//   npm run benchmark                                   набор и результаты по умолчанию
//   npm run benchmark -- --dataset <dir>                свой эталонный набор
//   npm run benchmark -- --findings <dir|file>          свои результаты агента
//   npm run benchmark -- --out <dir>                    куда положить отчёт
//   npm run benchmark -- --no-write                     только консоль, без файлов
//
// Реальные (не синтетические) наборы кладите в benchmark/local/ — директория
// исключена из git (.gitignore). Формат — benchmark/README.md.

const fs = require('node:fs');
const path = require('node:path');

const { runBenchmark } = require('../services/benchmark/benchmarkRunner');
const { buildReport, renderMarkdown, METRIC_LABELS } = require('../services/benchmark/reporter');

const ROOT = path.join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { write: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--dataset') { out.dataset = next(); i += 1; }
    else if (a === '--findings') { out.findings = next(); i += 1; }
    else if (a === '--out') { out.out = next(); i += 1; }
    else if (a === '--no-write') out.write = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Запуск: npm run benchmark -- [--dataset <dir>] [--findings <dir|file>] [--out <dir>] [--no-write]');
    return;
  }
  const datasetDir = path.resolve(ROOT, args.dataset || path.join('benchmark', 'datasets', 'synthetic'));
  const findingsPath = path.resolve(ROOT, args.findings || path.join('benchmark', 'runs', 'sample-agent'));

  const run = runBenchmark({ datasetDir, findingsPath });
  const report = buildReport(run, { generatedAt: new Date().toISOString() });

  const algoSlug = String(report.algorithm || 'agent')
    .toLowerCase().replace(/[^0-9a-zа-я]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const outDir = path.resolve(ROOT, args.out || path.join('benchmark', 'results', `${algoSlug}-${stamp}`));

  console.log(`Benchmark: ${report.documents.length} документов, алгоритм «${report.algorithm || 'не указан'}»`);
  console.log(`Набор:      ${report.dataset_path}`);
  console.log(`Результаты: ${report.findings_path}`);
  console.log('\nСводные метрики:');
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    const v = report.aggregate.metrics[key];
    console.log(`  ${label}: ${v == null ? '—' : (Number.isInteger(v) ? v : v.toFixed(3))}`);
  }
  const c = report.aggregate.counts;
  console.log(`\nИтого: опубликовано ${c.published}, TP ${c.true_positives}, FP ${c.false_positives}, FN ${c.false_negatives}, дублей ${c.duplicates}, утечек ${c.informational}, без опоры ${c.unsupported}.`);
  for (const doc of report.documents) {
    const m = doc.metrics;
    const p = m.precision == null ? '—' : m.precision.toFixed(2);
    const r = m.recall == null ? '—' : m.recall.toFixed(2);
    console.log(`  ${doc.document_id}: precision ${p}, recall ${r}, FN ${doc.details.false_negatives.length}, дублей ${doc.details.duplicates.length}, утечек ${doc.details.informational.length}`);
  }
  if (report.unknown_documents.length) {
    console.log(`\n⚠ В результатах агента есть документы вне набора: ${report.unknown_documents.join(', ')}`);
  }

  if (args.write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'report.md'), `${renderMarkdown(report)}\n`, 'utf8');
    console.log(`\nОтчёт сохранён: ${outDir}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`Ошибка benchmark: ${e.message}`);
  process.exitCode = 1;
}
