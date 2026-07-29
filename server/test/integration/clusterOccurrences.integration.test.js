'use strict';

// Integration: ПОВТОРЯЮЩЕЕСЯ ТРЕБОВАНИЕ через Postgres.
//
// Юнит-тест (test/unit/clusteringTopics.test.js) проверяет ярус 2 кластеризации
// на чистых функциях. Здесь — круг через базу, который чистой функцией не поймать:
//   • однотипная обязанность из нескольких пунктов ТЗ сохраняется ОДНОЙ строкой
//     issue_clusters, а не строкой на абзац;
//   • occurrence_count / evidence_fragments / affected_sections /
//     representative_fragment доезжают до колонок и читаются обратно массивами;
//   • все исходные draft_issues остаются элементами кластера (ничего не потеряно);
//   • самостоятельный риск того же абзаца остаётся ОТДЕЛЬНЫМ кластером.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const clustering = require('../../services/clustering/clusteringService');

const OPTS = dbTestOptions();
const TENDER_ID = 'occurrences-tender';

const nowIso = () => new Date().toISOString();

// Повторяющиеся требования одного ТЗ: четыре темы × несколько пунктов.
// Тексты РАЗНЫЕ (как в жизни) — совпадает предмет обязанности, а не формулировка.
const REPEATED = [
  { topic: 'cleaning', id: 'cl1', clause: 'п. 4.1 Общие обязанности', para: 41,
    fragment: 'Подрядчик обеспечивает ежедневную уборку строительной площадки.',
    basis: 'Ежедневная уборка площадки не учтена в КП' },
  { topic: 'cleaning', id: 'cl2', clause: 'п. 6.3 Содержание территории', para: 63,
    fragment: 'Вывоз строительного мусора осуществляется силами и за счёт Подрядчика.',
    basis: 'Вывоз строительного мусора за счёт ГП не посчитан' },
  { topic: 'cleaning', id: 'cl3', clause: 'п. 11.2 Сдача объекта', para: 112,
    fragment: 'До сдачи объекта выполняется финишная уборка помещений.',
    basis: 'Финишная уборка помещений не учтена в КП' },

  { topic: 'as_built_docs', id: 'id1', clause: 'п. 8.1 Документация', para: 81,
    fragment: 'Подрядчик передаёт Заказчику исполнительную документацию в трёх экземплярах.',
    basis: 'Исполнительная документация в трёх экземплярах не учтена' },
  { topic: 'as_built_docs', id: 'id2', clause: 'п. 12.4 Приёмка', para: 124,
    fragment: 'Приёмка работ производится при наличии полного комплекта исполнительной документации.',
    basis: 'Полный комплект исполнительной документации — условие приёмки' },

  { topic: 'temporary_utilities', id: 'tu1', clause: 'п. 5.2 Подготовительный период', para: 52,
    fragment: 'Устройство временных инженерных сетей выполняется Подрядчиком за свой счёт.',
    basis: 'Временные инженерные сети за счёт ГП не учтены в ВОР' },
  { topic: 'temporary_utilities', id: 'tu2', clause: 'п. 9.1 Инженерное обеспечение', para: 91,
    fragment: 'Временное электроснабжение строительной площадки организует Подрядчик.',
    basis: 'Временное электроснабжение площадки не посчитано' },

  { topic: 'material_supply', id: 'ms1', clause: 'п. 3.4 Материалы', para: 34,
    fragment: 'Поставка материалов и оборудования осуществляется Подрядчиком.',
    basis: 'Поставка материалов и оборудования отнесена на ГП' },
  { topic: 'material_supply', id: 'ms2', clause: 'п. 10.2 Склад', para: 102,
    fragment: 'Входной контроль поставляемых материалов выполняется силами Подрядчика.',
    basis: 'Входной контроль поставляемых материалов не учтён в КП' },
];

// Самостоятельный риск в ТОМ ЖЕ пункте, что и уборка (п. 6.3): другой тип риска,
// другое последствие, другое действие — сливаться с уборкой он не имеет права.
const INDEPENDENT = {
  id: 'pay1', clause: 'п. 6.3 Содержание территории', para: 63,
  fragment: 'Оплата производится в течение 90 календарных дней после подписания итогового акта.',
  basis: 'Отсрочка платежа 90 дней после итогового акта',
  problem_type: 'риск_оплаты', action: 'comment',
  impacts: { price: 'none', contract: 'high', responsibility: 'none' },
  required_action: 'ask_customer',
};

async function insertDraft(db, runId, row) {
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, analysis_run_id, tz_clause, source_fragment,
       problem_type, category, basis, suggested_action, confidence, paragraph_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'coverage', ?, ?, 0.8, ?, ?)`,
    row.id, TENDER_ID, runId, row.clause, row.fragment,
    row.problem_type || 'обязанность_за_счёт_подрядчика', row.basis,
    row.action || 'limit_scope', row.para, nowIso(),
  );
  const im = row.impacts || { price: 'high', contract: 'none', responsibility: 'medium' };
  await db.queryRun(
    `INSERT INTO issue_reviews (id, tender_id, analysis_run_id, draft_issue_id,
       price_impact, schedule_impact, contract_impact, responsibility_impact,
       display_priority, show_to_engineer, score,
       impact_level, evidence_level, verdict, impact_dimensions,
       publication_reason, required_action, created_at)
     VALUES (?, ?, ?, ?, ?, 'none', ?, ?, 'high', 1, 6,
       'high', 'strong', 'publish', '["price"]', 'Материальная обязанность ГП.', ?, ?)`,
    `rev-${row.id}`, TENDER_ID, runId, row.id,
    im.price, im.contract, im.responsibility,
    row.required_action || 'amend_tz', nowIso(),
  );
}

async function cleanup(db) {
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', TENDER_ID);
  await db.queryRun(
    `DELETE FROM issue_cluster_items WHERE cluster_id IN (SELECT id FROM issue_clusters WHERE tender_id = ?)`,
    TENDER_ID,
  );
  for (const t of ['issue_clusters', 'issue_reviews', 'draft_issues', 'analysis_runs']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, TENDER_ID);
  }
}

let runId = null;

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Повторяющиеся требования', 'draft', nowIso(),
  );
  runId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'occurrences.test' });
  for (const row of [...REPEATED, INDEPENDENT]) {
    // eslint-disable-next-line no-await-in-loop
    await insertDraft(db, runId, row);
  }
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await cleanup(db);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await closeDb();
});

test('повторяющиеся требования: 10 замечаний → 5 кластеров, вхождения в колонках', OPTS, async () => {
  const db = getDb();
  const res = await clustering.buildClusters(TENDER_ID, runId);

  assert.equal(res.summary.draft_issues, 10);
  assert.equal(res.summary.clusters, 5,
    '4 повторяющихся требования + самостоятельный риск оплаты = 5 замечаний');
  assert.equal(res.summary.multi_place, 4, 'четыре замечания собраны из нескольких мест ТЗ');
  assert.equal(res.summary.merged_occurrences, 5,
    'инженеру не показано 5 лишних карточек (3+2+2+2 вхождений сверх первых)');

  const rows = await db.queryAll(
    `SELECT id, work_object, occurrence_count, item_count, evidence_fragments,
            affected_sections, representative_fragment, cluster_title
       FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?`,
    TENDER_ID, runId,
  );
  assert.equal(rows.length, 5);

  const byObject = new Map(rows.map((r) => [r.work_object, r]));
  const expected = {
    cleaning: { occurrences: 3, sections: ['Раздел 4', 'Раздел 6', 'Раздел 11'] },
    as_built_docs: { occurrences: 2, sections: ['Раздел 8', 'Раздел 12'] },
    temporary_utilities: { occurrences: 2, sections: ['Раздел 5', 'Раздел 9'] },
    material_supply: { occurrences: 2, sections: ['Раздел 3', 'Раздел 10'] },
  };
  for (const [object, exp] of Object.entries(expected)) {
    const row = byObject.get(object);
    assert.ok(row, `нет кластера для темы ${object}`);
    assert.equal(Number(row.occurrence_count), exp.occurrences, `вхождений у ${object}`);
    assert.equal(Number(row.item_count), exp.occurrences, `элементов у ${object}`);
    assert.deepEqual(JSON.parse(row.affected_sections), exp.sections, `разделы у ${object}`);
    const evidence = JSON.parse(row.evidence_fragments);
    assert.equal(evidence.length, exp.occurrences);
    assert.ok(evidence.every((e) => e.fragment && e.tz_clause && e.draft_issue_id),
      'каждое вхождение несёт цитату, пункт и ссылку на исходное замечание');
    assert.ok(row.representative_fragment, `нет представительной цитаты у ${object}`);
  }

  // Самостоятельный риск оплаты из п. 6.3 не слился с уборкой того же пункта.
  const standalone = rows.find((r) => !expected[r.work_object]);
  assert.ok(standalone, 'риск оплаты остался отдельным кластером');
  assert.equal(Number(standalone.occurrence_count), 1);

  // Ничего не потеряно: все 10 draft_issues лежат в элементах кластеров.
  const items = await db.queryAll(
    `SELECT ci.draft_issue_id FROM issue_cluster_items ci
       JOIN issue_clusters c ON c.id = ci.cluster_id
      WHERE c.tender_id = ? AND c.analysis_run_id = ?`,
    TENDER_ID, runId,
  );
  assert.equal(items.length, 10);
});

test('listClusters отдаёт вхождения массивами, а не строками JSON', OPTS, async () => {
  const list = await clustering.listClusters(TENDER_ID, 'working', runId);
  assert.equal(list.length, 5, 'все кластеры опубликованы (свёртка publish)');
  for (const c of list) {
    assert.ok(Array.isArray(c.evidence_fragments), 'evidence_fragments — массив');
    assert.ok(Array.isArray(c.affected_sections), 'affected_sections — массив');
    assert.equal(typeof c.occurrence_count, 'number');
    assert.ok(c.occurrence_count >= 1);
    assert.equal(c.evidence_fragments.length, c.occurrence_count,
      'по одному вхождению на каждое место ТЗ');
  }
  const cleaning = list.find((c) => c.work_object === 'cleaning');
  assert.equal(cleaning.occurrence_count, 3);
  assert.match(cleaning.cluster_title, /Уборка и вывоз мусора/);
});

test('пересборка кластеров идемпотентна: вхождения не удваиваются', OPTS, async () => {
  const again = await clustering.buildClusters(TENDER_ID, runId);
  assert.equal(again.summary.clusters, 5);
  assert.equal(again.summary.multi_place, 4);
  const list = await clustering.listClusters(TENDER_ID, 'full', runId);
  const cleaning = list.find((c) => c.work_object === 'cleaning');
  assert.equal(cleaning.occurrence_count, 3, 'повтор сборки не добавил вхождений');
  assert.equal(cleaning.items.length, 3);
});
