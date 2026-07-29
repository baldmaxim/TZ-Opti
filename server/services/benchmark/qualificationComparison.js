'use strict';

// СРАВНЕНИЕ качества анализа ДО и ПОСЛЕ квалификационного фильтра
// (findingQualificationGate) на benchmark-наборе. Shadow mode: production-путь
// публикации не трогается, входные findings-файлы не изменяются — фильтр
// применяется к КОПИИ находок только внутри прогона.
//
// Три множества на документ:
//   raw       — публикации агента как есть (обычный benchmark);
//   qualified — видимое после gate: qualification publish | review
//               (review = полка «на проверку», инженер замечание ВИДИТ);
//   hidden    — скрытое/отклонённое gate: hide | reject (с причинами).
// Метрики считаются одним и тем же evaluator'ом для raw и qualified, отчёт
// показывает дельты, удалённый шум (FP/дубли/утечки) и ошибочно скрытые TP.
//
// Чистый модуль: без БД, без сети, без LLM.

const { loadDataset, loadFindings } = require('./benchmarkRunner');
const { evaluateDocument } = require('./evaluator');
const { buildReport, renderMarkdown, METRIC_LABELS } = require('./reporter');
const { normalizeVerdict } = require('../review/materiality');
const { qualifyFindings } = require('../qualification/findingQualificationGate');

const VISIBLE_QUALIFICATIONS = Object.freeze(['publish', 'review']);
const isVisible = (q) => VISIBLE_QUALIFICATIONS.includes(q);

// Опубликована ли находка агентом (та же логика, что в matcher.prepareFinding).
function rawPublished(raw) {
  if (raw.published != null) return !!raw.published;
  if (raw.verdict != null) return normalizeVerdict(raw.verdict) === 'publish';
  return true;
}

// --- Прогон ------------------------------------------------------------------

// runQualifiedBenchmark({ datasetDir, findingsPath }) → результаты raw и
// qualified прогонов + решения gate по каждой находке каждого документа.
function runQualifiedBenchmark({ datasetDir, findingsPath }) {
  const dataset = loadDataset(datasetDir);
  const findings = loadFindings(findingsPath);
  const rawResults = [];
  const qualifiedResults = [];
  const gateByDocument = [];

  for (const doc of dataset.documents) {
    const entry = findings.byDocument.get(doc.document_id);
    const docFindings = entry ? entry.findings : [];
    const gate = qualifyFindings(docFindings, { sourceText: doc.source_text });

    // Qualified-находка = копия исходной; видимость = raw-публикация И
    // qualification publish|review. Скрытое gate НЕ публикуется, остальное —
    // как публиковал агент.
    const qualifiedFindings = docFindings.map((f, i) => ({
      ...f,
      published: rawPublished(f) && isVisible(gate[i].qualification),
    }));

    const common = {
      documentId: doc.document_id,
      sourceText: doc.source_text,
      expected: doc.expected,
      forbidden: doc.forbidden,
    };
    rawResults.push({
      description: doc.description,
      missing_findings_file: !entry,
      evaluation: evaluateDocument({ ...common, findings: docFindings }),
    });
    qualifiedResults.push({
      description: doc.description,
      missing_findings_file: !entry,
      evaluation: evaluateDocument({ ...common, findings: qualifiedFindings }),
    });
    gateByDocument.push({
      document_id: doc.document_id,
      decisions: docFindings.map((f, i) => ({
        raw_published: rawPublished(f),
        ...gate[i],
      })),
    });
  }

  const knownIds = new Set(dataset.documents.map((d) => d.document_id));
  const unknownDocuments = [...findings.byDocument.keys()].filter((id) => !knownIds.has(id));
  const base = {
    dataset_path: dataset.path,
    findings_path: findings.path,
    algorithm: findings.algorithm,
    unknown_documents: unknownDocuments,
  };
  return {
    raw: { ...base, results: rawResults },
    qualified: { ...base, results: qualifiedResults },
    gate: gateByDocument,
  };
}

// --- Отчёт сравнения ---------------------------------------------------------

// Класс raw-находки по evaluation документа (tp / duplicate / informational /
// false_positive / unpublished).
function rawClassOf(evaluation, findingId) {
  if (evaluation.true_positives.some((t) => t.finding_id === findingId)) return 'tp';
  if (evaluation.duplicates.some((d) => d.finding_id === findingId)) return 'duplicate';
  if (evaluation.informational.some((f) => f.finding_id === findingId)) return 'informational';
  if (evaluation.false_positives.some((f) => f.finding_id === findingId)) return 'false_positive';
  return 'unpublished';
}

const NOISE_CLASSES = Object.freeze(['false_positive', 'duplicate', 'informational']);
const round4 = (n) => Number(n.toFixed(4));

function metricDelta(before, after) {
  if (before == null && after == null) return null;
  return round4((after == null ? 0 : after) - (before == null ? 0 : before));
}

// runOutput (runQualifiedBenchmark) → полный отчёт сравнения (JSON-структура).
function buildQualificationReport(runOutput, { generatedAt = null } = {}) {
  const rawReport = buildReport(runOutput.raw, { generatedAt });
  const qualifiedReport = buildReport(runOutput.qualified, { generatedAt });

  const documents = runOutput.gate.map((docGate) => {
    const rawDoc = rawReport.documents.find((d) => d.document_id === docGate.document_id);
    const rawEval = rawDoc.details;
    const decisions = docGate.decisions.map((d) => ({
      ...d,
      raw_class: d.raw_published ? rawClassOf(rawEval, d.finding_id) : 'unpublished',
      visible_after_gate: d.raw_published && isVisible(d.qualification),
    }));
    const published = decisions.filter((d) => d.raw_published);
    return {
      document_id: docGate.document_id,
      decisions,
      removed_noise: published.filter(
        (d) => NOISE_CLASSES.includes(d.raw_class) && !d.visible_after_gate,
      ),
      lost_true_positives: published.filter(
        (d) => d.raw_class === 'tp' && !d.visible_after_gate,
      ),
      surviving_noise: published.filter(
        (d) => NOISE_CLASSES.includes(d.raw_class) && d.visible_after_gate,
      ),
      hidden_or_rejected: published.filter((d) => !d.visible_after_gate),
    };
  });

  const before = rawReport.aggregate.metrics;
  const after = qualifiedReport.aggregate.metrics;
  const deltas = {};
  for (const key of Object.keys(METRIC_LABELS)) {
    deltas[key] = metricDelta(before[key], after[key]);
  }

  return {
    schema_version: 1,
    generated_at: generatedAt,
    mode: 'qualification-gate',
    algorithm: rawReport.algorithm,
    dataset_path: rawReport.dataset_path,
    findings_path: rawReport.findings_path,
    unknown_documents: rawReport.unknown_documents,
    metrics_before: before,
    metrics_after: after,
    metrics_delta: deltas,
    counts_before: rawReport.aggregate.counts,
    counts_after: qualifiedReport.aggregate.counts,
    totals: {
      removed_noise: documents.reduce((s, d) => s + d.removed_noise.length, 0),
      lost_true_positives: documents.reduce((s, d) => s + d.lost_true_positives.length, 0),
      surviving_noise: documents.reduce((s, d) => s + d.surviving_noise.length, 0),
      hidden_or_rejected: documents.reduce((s, d) => s + d.hidden_or_rejected.length, 0),
    },
    documents,
    raw_report: rawReport,
    qualified_report: qualifiedReport,
  };
}

// --- Markdown ----------------------------------------------------------------

const fmt = (v) => (v == null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(3)));

function decisionLine(d) {
  const reqs = d.missing_requirements.length
    ? ` не хватает: ${d.missing_requirements.join(', ')}.`
    : '';
  return `\`${d.finding_id}\` [${d.raw_class}] → **${d.qualification}** (${d.rule}) — ${d.reasons[0]}${reqs}`;
}

function renderQualificationMarkdown(report) {
  const out = [];
  out.push('# Benchmark-отчёт: квалификационный фильтр (shadow mode)');
  out.push('');
  if (report.generated_at) out.push(`Сформирован: ${report.generated_at}`);
  out.push(`Алгоритм: ${report.algorithm || 'не указан'}`);
  out.push(`Набор: \`${report.dataset_path}\``);
  out.push(`Результаты агента: \`${report.findings_path}\``);
  out.push('');
  out.push('Qualified = находки с квалификацией publish|review (review — полка «на проверку», инженер их видит). Hidden/rejected в метрики после фильтра не входят.');
  out.push('', '## Метрики до и после фильтра', '');
  out.push('| Метрика | До | После | Δ |');
  out.push('| --- | --- | --- | --- |');
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    out.push(`| ${label} | ${fmt(report.metrics_before[key])} | ${fmt(report.metrics_after[key])} | ${fmt(report.metrics_delta[key])} |`);
  }
  const t = report.totals;
  out.push('');
  out.push(`Удалено шума (FP/дубли/утечки): ${t.removed_noise}. Ошибочно скрыто TP: ${t.lost_true_positives}. Осталось шума после фильтра: ${t.surviving_noise}. Всего скрыто/отклонено: ${t.hidden_or_rejected}.`);

  const section = (title, rows) => {
    out.push('', `## ${title}`, '');
    if (!rows.length) { out.push('_нет_'); return; }
    for (const r of rows) out.push(`- ${r}`);
  };

  const collect = (key) => report.documents.flatMap(
    (d) => d[key].map((x) => `${d.document_id}: ${decisionLine(x)}`),
  );
  section('Удалённые false positive / дубли / утечки', collect('removed_noise'));
  section('Ошибочно скрытые true positive', collect('lost_true_positives'));
  section('Оставшиеся false positive', collect('surviving_noise'));

  out.push('', '## Решения gate по находкам', '');
  for (const doc of report.documents) {
    if (!doc.decisions.length) continue;
    out.push(`### ${doc.document_id}`, '');
    for (const d of doc.decisions) {
      const vis = d.raw_published
        ? (d.visible_after_gate ? 'виден' : 'скрыт фильтром')
        : 'не публиковался агентом';
      out.push(`- ${decisionLine(d)} — ${vis}; priority ${d.priority}, evidence ${d.evidence_strength}, source ${d.source_strength}, confidence ${d.confidence}`);
    }
    out.push('');
  }
  return out.join('\n');
}

module.exports = {
  VISIBLE_QUALIFICATIONS,
  isVisible,
  rawPublished,
  runQualifiedBenchmark,
  buildQualificationReport,
  renderQualificationMarkdown,
  renderMarkdown, // реэкспорт для CLI (raw/qualified отчёты)
};
