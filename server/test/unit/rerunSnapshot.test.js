'use strict';

// Юнит-тесты семантики повторного прогона (снимки) — без БД. Собирают вместе
// selectActiveRunIds + clusterRunId + dedupeExportRows + matchDecisionsToClusters и
// доказывают ключевые инварианты задачи:
//   • экспорт берёт ТОЛЬКО актуальный прогон — старые замечания не попадают;
//   • повторный прогон не создаёт дублей в экспорте;
//   • решения прошлого прогона НЕ приклеиваются к новым кластерам автоматически
//     (id run-scoped) — перенос возможен лишь явным сопоставлением.
// Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectActiveRunIds,
  clusterRunId,
  dedupeExportRows,
  matchDecisionsToClusters,
} = require('../../services/analysisRuns/analysisRunsService');

test('повторный прогон: экспорт берёт только актуальный прогон, без дублей и без старых замечаний', () => {
  const runs = [
    { id: 'runOld', superseded_at: '2026-07-01T00:00:00Z' }, // архивный
    { id: 'runNew', superseded_at: null },                    // актуальный
  ];
  const pointers = [{ analysis_run_id: 'runNew' }];
  const active = selectActiveRunIds(runs, pointers);
  assert.deepEqual([...active], ['runNew']);

  // Строки-кандидаты в экспорт из ОБОИХ прогонов (как если бы читали без скоупа).
  const allRows = [
    { cluster_id: clusterRunId('t', 'runOld', 'k1'), analysis_run_id: 'runOld' },
    { cluster_id: clusterRunId('t', 'runOld', 'k2'), analysis_run_id: 'runOld' },
    { cluster_id: clusterRunId('t', 'runNew', 'k1'), analysis_run_id: 'runNew' },
    { cluster_id: clusterRunId('t', 'runNew', 'k1'), analysis_run_id: 'runNew' }, // случайный дубль
    { cluster_id: clusterRunId('t', 'runNew', 'k2'), analysis_run_id: 'runNew' },
  ];

  // Скоуп по актуальному прогону + дедуп — это и есть путь экспорта.
  const exportRows = dedupeExportRows(allRows.filter((r) => active.has(r.analysis_run_id)));

  assert.equal(exportRows.length, 2, 'только новый прогон и без дублей');
  assert.ok(exportRows.every((r) => r.analysis_run_id === 'runNew'), 'старый прогон исключён');
  const oldIds = new Set([clusterRunId('t', 'runOld', 'k1'), clusterRunId('t', 'runOld', 'k2')]);
  assert.ok(!exportRows.some((r) => oldIds.has(r.cluster_id)), 'старые замечания не в экспорте');
});

test('повторный прогон: решения прошлого прогона НЕ приклеиваются к новым кластерам по id', () => {
  // Решение прошлого прогона привязано к cluster_id прошлого прогона.
  const oldDecisions = [
    { id: 'd1', cluster_id: clusterRunId('t', 'runOld', 'k1'), decision: 'delete', cluster_key: 'k1' },
  ];
  // Новые кластеры актуального прогона — те же ключи, но run-scoped id.
  const newClusters = [
    { id: clusterRunId('t', 'runNew', 'k1'), cluster_key: 'k1' },
  ];

  // Прямое соединение по cluster_id (как раньше делал детерминированный id) НЕ
  // находит решение — авто-переноса нет.
  const autoJoined = newClusters.filter((c) => oldDecisions.some((d) => d.cluster_id === c.id));
  assert.equal(autoJoined.length, 0, 'решение не приклеивается к новому кластеру по id');

  // Перенос возможен только через ЯВНОЕ сопоставление (по cluster_key) + подтверждение.
  const proposals = matchDecisionsToClusters(oldDecisions, newClusters);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].match, 'exact');
  assert.equal(proposals[0].cluster_id, newClusters[0].id);
});
