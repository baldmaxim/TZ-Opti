'use strict';

// ЗАГРУЗКА benchmark-набора и ПРОГОН оценки.
//
// Контур полностью офлайн: модуль НЕ импортирует db/connection, не открывает
// сеть и не касается production-данных (active pointers, analysis_runs и т.д.).
// Вход — файлы на диске, выход — объект отчёта; писать файлы решает вызывающий
// (CLI scripts/runBenchmark.js).
//
// Формат набора (директория):
//   <name>.gold.json  — эталон документа (см. validateGoldDocument);
//   <name>.md         — исходный Markdown, на который ссылается gold.source.
// Формат результата агента (директория или файл):
//   { document_id, algorithm?, findings: [...] } — по файлу на документ,
//   либо один файл с массивом таких объектов.

const fs = require('node:fs');
const path = require('node:path');

const matcher = require('./matcher');
const { evaluateDocument } = require('./evaluator');
const {
  IMPACT_LEVELS,
  REQUIRED_ACTIONS,
  SUPPRESSION_FLAGS,
} = require('../review/materiality');

const GOLD_SUFFIX = '.gold.json';
const EXPECTED_KINDS = ['critical', 'working'];

// --- Валидация эталона -------------------------------------------------------

// Собирает список ошибок формата одного gold-документа (пустой = годен).
function validateGoldDocument(gold, sourceText, label) {
  const errors = [];
  const err = (msg) => errors.push(`${label}: ${msg}`);
  if (!gold || typeof gold !== 'object') return [`${label}: не объект`];
  if (!gold.document_id || typeof gold.document_id !== 'string') err('нет document_id');
  if (!gold.source || typeof gold.source !== 'string') err('нет source (имя Markdown-файла)');
  const doc = matcher.prepareDocument(sourceText);

  const checkQuote = (quote, where) => {
    if (!quote || typeof quote !== 'string' || !quote.trim()) {
      err(`${where}: нет точной цитаты (quote)`);
      return;
    }
    const located = matcher.locateQuote(doc, quote);
    if (!located || !located.exact) err(`${where}: точная цитата не найдена в source дословно`);
  };

  const expected = Array.isArray(gold.expected) ? gold.expected : null;
  if (!expected) err('expected должен быть массивом');
  const seenIds = new Set();
  (expected || []).forEach((item, i) => {
    const where = `expected[${i}]`;
    if (!item.id) err(`${where}: нет id`);
    else if (seenIds.has(item.id)) err(`${where}: id «${item.id}» повторяется`);
    else seenIds.add(item.id);
    if (!EXPECTED_KINDS.includes(item.kind)) {
      err(`${where}: kind должен быть ${EXPECTED_KINDS.join('|')}`);
    }
    checkQuote(item.quote, where);
    if (!item.risk_category && !item.problem_type) {
      err(`${where}: нужна категория риска (risk_category или problem_type)`);
    }
    if (!IMPACT_LEVELS.includes(item.expected_impact) || item.expected_impact === 'none') {
      err(`${where}: expected_impact должен быть critical|high|medium|low`);
    }
    if (item.required_action != null && !REQUIRED_ACTIONS.includes(item.required_action)) {
      err(`${where}: required_action вне словаря (${REQUIRED_ACTIONS.join('|')})`);
    }
    if (item.accepted_phrasings != null && !Array.isArray(item.accepted_phrasings)) {
      err(`${where}: accepted_phrasings должен быть массивом строк`);
    }
    if (!item.required_basis || typeof item.required_basis !== 'string') {
      err(`${where}: нет обязательного основания (required_basis)`);
    }
  });

  const forbidden = Array.isArray(gold.forbidden) ? gold.forbidden : null;
  if (gold.forbidden != null && !forbidden) err('forbidden должен быть массивом');
  (forbidden || []).forEach((item, i) => {
    const where = `forbidden[${i}]`;
    if (!item.id) err(`${where}: нет id`);
    else if (seenIds.has(item.id)) err(`${where}: id «${item.id}» повторяется`);
    else seenIds.add(item.id);
    checkQuote(item.quote, where);
    if (!SUPPRESSION_FLAGS.includes(item.reason)) {
      err(`${where}: reason должен быть одним из ${SUPPRESSION_FLAGS.join('|')}`);
    }
  });

  return errors;
}

// --- Загрузка ----------------------------------------------------------------

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Директория с *.gold.json + *.md → проверенный набор документов.
function loadDataset(datasetDir) {
  const dir = path.resolve(datasetDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Benchmark-набор не найден: ${dir}`);
  }
  const goldFiles = fs.readdirSync(dir).filter((f) => f.endsWith(GOLD_SUFFIX)).sort();
  if (!goldFiles.length) {
    throw new Error(`В наборе нет файлов эталона (*${GOLD_SUFFIX}): ${dir}`);
  }
  const errors = [];
  const documents = [];
  const seenDocIds = new Set();
  for (const file of goldFiles) {
    const goldPath = path.join(dir, file);
    let gold;
    try {
      gold = readJson(goldPath);
    } catch (e) {
      errors.push(`${file}: JSON не читается (${e.message})`);
      continue;
    }
    const sourcePath = gold && gold.source ? path.join(dir, gold.source) : null;
    let sourceText = '';
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      errors.push(`${file}: source «${gold && gold.source}» не найден рядом с эталоном`);
    } else {
      sourceText = fs.readFileSync(sourcePath, 'utf8');
    }
    errors.push(...validateGoldDocument(gold, sourceText, file));
    if (gold && gold.document_id) {
      if (seenDocIds.has(gold.document_id)) {
        errors.push(`${file}: document_id «${gold.document_id}» повторяется в наборе`);
      }
      seenDocIds.add(gold.document_id);
    }
    documents.push({
      document_id: gold ? gold.document_id : file,
      description: (gold && gold.description) || null,
      source: gold ? gold.source : null,
      source_path: sourcePath,
      source_text: sourceText,
      expected: (gold && gold.expected) || [],
      forbidden: (gold && gold.forbidden) || [],
    });
  }
  if (errors.length) {
    throw new Error(`Benchmark-набор невалиден:\n  - ${errors.join('\n  - ')}`);
  }
  return { path: dir, documents };
}

function normalizeFindingsEntry(entry, label, errors) {
  if (!entry || typeof entry !== 'object' || !entry.document_id) {
    errors.push(`${label}: нет document_id`);
    return null;
  }
  if (!Array.isArray(entry.findings)) {
    errors.push(`${label} (${entry.document_id}): findings должен быть массивом`);
    return null;
  }
  return entry;
}

// Файл или директория с результатами агента → Map document_id → entry.
function loadFindings(findingsPath) {
  const p = path.resolve(findingsPath);
  if (!fs.existsSync(p)) throw new Error(`Результаты агента не найдены: ${p}`);
  const files = fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f))
    : [p];
  const errors = [];
  const byDocument = new Map();
  let algorithm = null;
  for (const file of files) {
    let parsed;
    try {
      parsed = readJson(file);
    } catch (e) {
      errors.push(`${path.basename(file)}: JSON не читается (${e.message})`);
      continue;
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const raw of entries) {
      const entry = normalizeFindingsEntry(raw, path.basename(file), errors);
      if (!entry) continue;
      if (byDocument.has(entry.document_id)) {
        errors.push(`${path.basename(file)}: document_id «${entry.document_id}» уже встречался`);
        continue;
      }
      byDocument.set(entry.document_id, entry);
      if (!algorithm && entry.algorithm) algorithm = entry.algorithm;
    }
  }
  if (errors.length) {
    throw new Error(`Файлы результатов агента невалидны:\n  - ${errors.join('\n  - ')}`);
  }
  return { path: p, algorithm, byDocument };
}

// --- Прогон ------------------------------------------------------------------

// Полный прогон: набор + результаты агента → результаты классификации по
// документам. Ничего не пишет — сборкой отчёта занимается reporter.
function runBenchmark({ datasetDir, findingsPath }) {
  const dataset = loadDataset(datasetDir);
  const findings = loadFindings(findingsPath);
  const results = dataset.documents.map((doc) => {
    const entry = findings.byDocument.get(doc.document_id);
    return {
      description: doc.description,
      missing_findings_file: !entry,
      evaluation: evaluateDocument({
        documentId: doc.document_id,
        sourceText: doc.source_text,
        expected: doc.expected,
        forbidden: doc.forbidden,
        findings: entry ? entry.findings : [],
      }),
    };
  });
  const knownIds = new Set(dataset.documents.map((d) => d.document_id));
  const unknownDocuments = [...findings.byDocument.keys()].filter((id) => !knownIds.has(id));
  return {
    dataset_path: dataset.path,
    findings_path: findings.path,
    algorithm: findings.algorithm,
    results,
    unknown_documents: unknownDocuments,
  };
}

module.exports = {
  GOLD_SUFFIX,
  EXPECTED_KINDS,
  validateGoldDocument,
  loadDataset,
  loadFindings,
  runBenchmark,
};
