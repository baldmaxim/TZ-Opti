'use strict';

// Юнит-тесты слоя cluster-review (этап 6: issue_clusters как основной объект
// рецензии/экспорта) — без БД и LLM. Проверяют чистое ядро: маппинг кластера в
// «issue-подобный» объект экспорта и совместимость с review/decisionModel.js,
// плюс детерминированность id кластера. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { clusterToExportIssue, decisionKindFor } = require('../../services/review/clusterReviewService');
const { clusterId } = require('../../services/clustering/clusteringService');
const { resolveRedaction, resolveActionTarget, decisionVisual } = require('../../services/review/decisionModel');

const cluster = {
  id: 'clu_abc',
  tz_clause: 'п. 5.1 Состав работ',
  cluster_title: 'Влияние на стоимость — п. 5.1',
  merged_recommendation: '• Учесть демонтаж в КП',
  overall_criticality: 'high',
  final_problem_type: 'не_учтено_в_кп',
  paragraph_index: 5,
};
const primary = {
  id: 'd-a',
  source_fragment: 'Демонтаж существующих конструкций',
  tz_clause: 'п. 5.1 Состав работ',
  suggested_action: 'replace',
  suggested_redaction: 'Демонтаж включить в объём работ ГП',
  problem_type: 'не_учтено_в_кп',
  paragraph_index: 5,
};

test('clusterToExportIssue: переносит локализацию и поля из primary draft_issue', () => {
  const issue = clusterToExportIssue(cluster, primary);
  assert.equal(issue.id, 'clu_abc');
  assert.equal(issue.cluster_id, 'clu_abc');
  assert.equal(issue.analysis_stage, null); // кластер сводит несколько стадий
  assert.equal(issue.source_fragment, 'Демонтаж существующих конструкций');
  assert.equal(issue.source_clause, 'п. 5.1 Состав работ');
  assert.equal(issue.paragraph_index, 5);
  assert.equal(issue.suggested_action, 'replace');
  assert.equal(issue.suggested_redaction, 'Демонтаж включить в объём работ ГП');
  assert.equal(issue.problem_type, 'не_учтено_в_кп');
  assert.equal(issue.criticality, 'high');
});

test('clusterToExportIssue: paragraph_index фолбэк на primary, когда у кластера нет', () => {
  const issue = clusterToExportIssue({ ...cluster, paragraph_index: null }, primary);
  assert.equal(issue.paragraph_index, 5);
});

test('clusterToExportIssue: пустой primary не роняет (поля = null)', () => {
  const issue = clusterToExportIssue(cluster, {});
  assert.equal(issue.source_fragment, null);
  assert.equal(issue.suggested_action, null);
  // source_clause/problem_type берутся из кластера
  assert.equal(issue.source_clause, 'п. 5.1 Состав работ');
  assert.equal(issue.problem_type, 'не_учтено_в_кп');
});

test('синтетический issue совместим с decisionModel: edited_redaction инженера приоритетнее', () => {
  const issue = clusterToExportIssue(cluster, primary);
  // Без правки инженера — берётся suggested_redaction из primary.
  assert.equal(resolveRedaction(issue, {}), 'Демонтаж включить в объём работ ГП');
  // С правкой инженера — она побеждает.
  assert.equal(resolveRedaction(issue, { edited_redaction: 'Свой текст' }), 'Свой текст');
});

test('синтетический issue: target_text задаёт подчасть фрагмента (resolveActionTarget)', () => {
  const issue = clusterToExportIssue(cluster, primary);
  // Без выбора — действие на весь фрагмент.
  assert.equal(resolveActionTarget(issue, {}), 'Демонтаж существующих конструкций');
  // С выбором подчасти — она.
  assert.equal(resolveActionTarget(issue, { target_text: 'Демонтаж' }), 'Демонтаж');
});

test('decisionKindFor + decisionVisual: вид экспорта по решению кластера', () => {
  assert.equal(decisionVisual(decisionKindFor('edit')).docx, 'del+ins');
  assert.equal(decisionVisual(decisionKindFor('delete')).docx, 'del');
  assert.equal(decisionVisual(decisionKindFor('remove_from_scope')).docx, 'del');
  assert.equal(decisionVisual(decisionKindFor('accept')).docx, 'comment');
  assert.equal(decisionVisual(decisionKindFor('reject')).docx, 'none'); // не экспортируется
});

test('clusterId детерминирован и переживает пересборку (тот же tender+key → тот же id)', () => {
  const a = clusterId('tender-1', 'clause:п. 5.1::price|modify');
  const b = clusterId('tender-1', 'clause:п. 5.1::price|modify');
  const other = clusterId('tender-1', 'clause:п. 6.2::contract|note');
  assert.equal(a, b); // стабильность → решение по cluster_id не теряется при ре-ране конвейера
  assert.notEqual(a, other);
  assert.match(a, /^clu_[0-9a-f]{24}$/);
});
