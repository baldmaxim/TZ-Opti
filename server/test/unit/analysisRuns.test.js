'use strict';

// Юнит-тесты чистого ядра реестра прогонов (analysisRunsService.js) — без БД и LLM.
// Ключи прогона (ревизия документов + версия конфигурации), run-scoped id кластера,
// выбор согласованного набора актуальных прогонов и дедуп экспорта. Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDocumentsRevision,
  computeConfigVersion,
  clusterRunId,
  selectActiveRunIds,
  dedupeExportRows,
} = require('../../services/analysisRuns/analysisRunsService');

// --- computeDocumentsRevision -------------------------------------------------

const doc = (id, extracted_text, version = '1') => ({ id, version, extracted_text });

test('computeDocumentsRevision: детерминирована и не зависит от порядка документов', () => {
  const a = doc('d1', 'ТЗ раздел 1');
  const b = doc('d2', 'ВОР позиции');
  assert.equal(computeDocumentsRevision([a, b]), computeDocumentsRevision([b, a]));
  assert.match(computeDocumentsRevision([a, b]), /^docs_[0-9a-f]{24}$/);
});

test('computeDocumentsRevision: меняется при изменении/добавлении документа', () => {
  const a = doc('d1', 'ТЗ раздел 1');
  const b = doc('d2', 'ВОР позиции');
  const base = computeDocumentsRevision([a, b]);
  assert.notEqual(base, computeDocumentsRevision([doc('d1', 'ТЗ раздел 1 ИЗМЕНЕНО'), b]), 'смена текста');
  assert.notEqual(base, computeDocumentsRevision([a, b, doc('d3', 'новый')]), 'добавлен документ');
  assert.notEqual(base, computeDocumentsRevision([doc('d1', 'ТЗ раздел 1', '2'), b]), 'смена версии');
});

test('computeDocumentsRevision: пустой набор → docs_empty', () => {
  assert.equal(computeDocumentsRevision([]), 'docs_empty');
  assert.equal(computeDocumentsRevision(null), 'docs_empty');
});

// --- computeConfigVersion -----------------------------------------------------

test('computeConfigVersion: детерминирована, формат cfg_, дефолты при пустом env', () => {
  assert.equal(computeConfigVersion({}), computeConfigVersion({}));
  assert.match(computeConfigVersion({}), /^cfg_[0-9a-f]{16}$/);
});

test('computeConfigVersion: меняется при смене варианта промта / модели / температуры', () => {
  const base = computeConfigVersion({});
  assert.notEqual(base, computeConfigVersion({ STAGE1_PROMPT_VARIANT: 'strict' }));
  assert.notEqual(base, computeConfigVersion({ OPENAI_MODEL: 'gpt-4o-mini' }));
  assert.notEqual(base, computeConfigVersion({ OPENAI_TEMPERATURE: '0.7' }));
  // тот же вариант, что дефолт, — та же версия
  assert.equal(base, computeConfigVersion({ STAGE1_PROMPT_VARIANT: 'structural' }));
});

// --- clusterRunId -------------------------------------------------------------

test('clusterRunId: стабилен внутри прогона, различается между прогонами', () => {
  const key = 'clause:1.2::price|remove';
  assert.equal(clusterRunId('t1', 'runA', key), clusterRunId('t1', 'runA', key));
  assert.notEqual(clusterRunId('t1', 'runA', key), clusterRunId('t1', 'runB', key), 'другой прогон → другой id');
  assert.notEqual(clusterRunId('t1', 'runA', key), clusterRunId('t2', 'runA', key), 'другой тендер → другой id');
  assert.match(clusterRunId('t1', 'runA', key), /^clu_[0-9a-f]{24}$/);
});

// --- selectActiveRunIds -------------------------------------------------------

test('selectActiveRunIds: только прогоны из указателей и не архивированные', () => {
  const runs = [
    { id: 'r1', superseded_at: null },
    { id: 'r2', superseded_at: '2026-07-01T00:00:00Z' }, // архивный
    { id: 'r3', superseded_at: null },
  ];
  const pointers = [{ analysis_run_id: 'r1' }, { analysis_run_id: 'r2' }];
  const active = selectActiveRunIds(runs, pointers);
  assert.deepEqual([...active].sort(), ['r1'], 'r2 архивный, r3 не в указателях');
});

// --- dedupeExportRows ---------------------------------------------------------

test('dedupeExportRows: один ряд на кластер (первый побеждает)', () => {
  const rows = [
    { cluster_id: 'c1', v: 'a' },
    { cluster_id: 'c1', v: 'b' }, // дубль места
    { cluster_id: 'c2', v: 'c' },
  ];
  const out = dedupeExportRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.v), ['a', 'c']);
});

test('dedupeExportRows: без cluster_id ключ по абзацу+диапазону', () => {
  const rows = [
    { paragraph_index: 3, char_start: 0, char_end: 5 },
    { paragraph_index: 3, char_start: 0, char_end: 5 }, // дубль
    { paragraph_index: 3, char_start: 6, char_end: 9 },
  ];
  assert.equal(dedupeExportRows(rows).length, 2);
});
