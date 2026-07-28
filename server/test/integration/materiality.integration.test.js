'use strict';

// Integration: МОДЕЛЬ МАТЕРИАЛЬНОСТИ через Postgres.
//
// Юнит-тест (test/unit/materiality.test.js) проверяет матрицу impact × evidence
// на чистых функциях. Здесь проверяется КРУГ ЧЕРЕЗ БАЗУ — то, что чистой функцией
// не поймать:
//   • все 15 клеток матрицы доезжают до колонок issue_reviews и читаются обратно;
//   • режимы выборки (working / verify / important / full) — это SQL: инженер по
//     умолчанию получает ТОЛЬКО опубликованные материальные замечания, а скрытые
//     и «на проверку» никуда не исчезают из базы;
//   • свёртка вердикта на кластер (объект рецензии) сохраняется и читается;
//   • перенос СТАРЫХ строк (verdict IS NULL) безопасен и идемпотентен.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const critic = require('../../services/critic/criticService');
const clustering = require('../../services/clustering/clusteringService');
const m = require('../../services/review/materiality');

const OPTS = dbTestOptions();
const TENDER_ID = 'materiality-tender';
const LEGACY_TENDER_ID = 'materiality-legacy-tender';

const nowIso = () => new Date().toISOString();

// --- Рецепты влияния и доказательности --------------------------------------
//
// impact_level критик считает по ВЕСАМ сработавших материальных критериев
// (criticService.CRITERIA), поэтому уровень задаётся содержимым находки, а не
// напрямую. Рецепты подобраны так, чтобы веса были однозначны:
//   none     — нет ни одного материального признака                     (вес 0)
//   low      — только «не подтверждается ПД/РД/ВОР»                     (вес 1)
//   medium   — только «влияет на график»                                (вес 2)
//   high     — только «влияет на договор» (category=condition)          (вес 3)
//   critical — «влияет на договор» + «противоречит условиям компании»   (вес 6)
// Доказательность — структурная: strong = привязка + обоснование + ДВА разных
// типа сигнала (category 'x+risk'), medium = привязка + обоснование,
// weak = без обоснования. 'risk' не участвует ни в одном критерии по category,
// поэтому второй тип не меняет вес влияния.
const IMPACT_RECIPE = {
  none: { baseCategory: 'decision', problem_type: null, fragment: 'Указан неверный номер приложения к тексту.' },
  low: { baseCategory: 'decision', problem_type: 'qa_отсутствует_информация', fragment: 'По цвету финишного покрытия данных в тексте нет.' },
  medium: { baseCategory: 'decision', problem_type: null, fragment: 'Срок выполнения этапа определяется заказчиком.' },
  high: { baseCategory: 'condition', problem_type: null, fragment: 'Стороны действуют по правилам приложения 5.' },
  critical: { baseCategory: 'condition', problem_type: 'условие_противоречит', fragment: 'Стороны действуют по правилам приложения 5.' },
};

// ИСХОД PRECISION-КРИТИКА при ВЫКЛЮЧЕННОМ LLM-уровне (в тестовом процессе ключа
// модели нет). Выписан независимо от реализации — тест обязан падать, если
// правила поедут:
//   • публикуются только надёжно доказанные существенные последствия;
//   • low/none скрываются жёстким правилом, без модели;
//   • ВСЁ medium и всё слабо доказанное — спорное: критик не отработал, значит
//     замечание НЕ публикуется автоматически (verdict='verify'), но и не теряется.
// Это и есть требование «не публиковать спорные medium/low при сбое критика».
const EXPECTED_OUTCOME = {
  critical: { strong: 'publish_critical', medium: null, weak: null },
  high: { strong: 'publish_working', medium: null, weak: null },
  medium: { strong: null, medium: null, weak: null },
  low: { strong: 'hide_informational', medium: 'hide_informational', weak: 'hide_informational' },
  none: { strong: 'hide_informational', medium: 'hide_informational', weak: 'hide_informational' },
};

// Исход критика → вердикт строки (services/critic/criticService.mergePrecisionDecision).
const VERDICT_BY_OUTCOME = {
  publish_critical: 'publish',
  publish_working: 'publish',
  hide_informational: 'suppress',
  reject_invalid: 'suppress',
};
const expectedVerdict = (outcome) => (outcome == null ? 'verify' : VERDICT_BY_OUTCOME[outcome]);

const caseId = (impact, evidence, prefix = 'mat') => `${prefix}-${impact}-${evidence}`;

// Один draft_issue под клетку матрицы. Требования к фикстуре:
//   • обоснование НЕЙТРАЛЬНОЕ — не добавляет материальных признаков;
//   • место и цитата УНИКАЛЬНЫ для клетки — иначе клетки станут повторами друг
//     друга и precision-критик отклонит их как дубликаты (что он и должен делать);
//   • suggested_action='replace' — у замечания есть выход (actionability),
//     иначе всё скрывалось бы правилом «нечего делать» и матрица не проверялась бы.
async function insertMatrixDraft(db, runId, impact, evidence, index, prefix = 'mat') {
  const recipe = IMPACT_RECIPE[impact];
  const category = evidence === 'strong' ? `${recipe.baseCategory}+risk` : recipe.baseCategory;
  const basis = evidence === 'weak' ? null : 'Замечание зафиксировано агентом стадии.';
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, analysis_run_id, tz_clause, source_fragment,
       problem_type, category, basis, suggested_action, confidence, paragraph_index, created_at,
       verdict, evidence_level, impact_dimensions, required_action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'replace', 0.8, ?, ?, 'verify', 'weak', '[]', 'ask_customer')`,
    caseId(impact, evidence, prefix), TENDER_ID, runId,
    `п. 2.${index + 1}`,
    `${recipe.fragment} (клетка ${impact}/${evidence})`,
    recipe.problem_type, category, basis, index, nowIso(),
  );
}

async function cleanup(db, tenderId) {
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', tenderId);
  await db.queryRun(
    `DELETE FROM issue_cluster_items WHERE cluster_id IN (SELECT id FROM issue_clusters WHERE tender_id = ?)`,
    tenderId,
  );
  for (const t of ['issue_clusters', 'issue_reviews', 'draft_issues', 'self_analysis_results',
    'analysis_signals', 'issues', 'analysis_runs']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, tenderId);
  }
}

let matrixRunId = null;

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  for (const id of [TENDER_ID, LEGACY_TENDER_ID]) {
    // eslint-disable-next-line no-await-in-loop
    await cleanup(db, id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
      id, 'Материальность замечаний', 'draft', nowIso(),
    );
  }
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  for (const id of [TENDER_ID, LEGACY_TENDER_ID]) {
    // eslint-disable-next-line no-await-in-loop
    await cleanup(db, id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
  }
  await closeDb();
});

// --- 1. Матрица доезжает до колонок и читается обратно -----------------------

test('матрица impact × evidence: 15 клеток проходят critic и сохраняются в issue_reviews', OPTS, async () => {
  const db = getDb();
  matrixRunId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'materiality.test' });

  let index = 0;
  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      // eslint-disable-next-line no-await-in-loop
      await insertMatrixDraft(db, matrixRunId, impact, evidence, index);
      index += 1;
    }
  }

  const res = await critic.buildIssueReviews(TENDER_ID, matrixRunId);
  assert.equal(res.summary.reviewed, 15, 'оценены все 15 замечаний');
  // Отчёт precision-критика обязан быть в summary: сколько решено правилами,
  // сколько осталось спорным. «Молча решили всё» — недопустимо.
  assert.ok(res.summary.precision, 'в отчёте должен быть блок precision-критика');
  assert.equal(res.summary.precision.total, 15);
  assert.equal(res.summary.precision.llm_enabled, false, 'в тестовом процессе LLM-уровень выключен');
  assert.ok(res.summary.precision.contested > 0, 'часть замечаний обязана попасть в спорные');

  const rows = await db.queryAll(
    `SELECT draft_issue_id, impact_level, evidence_level, verdict, impact_dimensions,
            publication_reason, suppression_reason, required_action, show_to_engineer,
            critic_outcome, critic_source, critic_assessment
       FROM issue_reviews WHERE tender_id = ? AND analysis_run_id = ?`,
    TENDER_ID, matrixRunId,
  );
  assert.equal(rows.length, 15);
  const byId = new Map(rows.map((r) => [r.draft_issue_id, r]));

  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      const row = byId.get(caseId(impact, evidence));
      const expectedOutcome = EXPECTED_OUTCOME[impact][evidence];
      assert.ok(row, `нет строки для ${impact}/${evidence}`);
      assert.equal(row.impact_level, impact, `impact для ${impact}/${evidence}`);
      assert.equal(row.evidence_level, evidence, `evidence для ${impact}/${evidence}`);
      assert.equal(
        row.critic_outcome,
        expectedOutcome,
        `исход критика для ${impact}/${evidence}: ожидался ${expectedOutcome}, в БД ${row.critic_outcome}`,
      );
      assert.equal(
        row.verdict,
        expectedVerdict(expectedOutcome),
        `вердикт для ${impact}/${evidence}: в БД ${row.verdict}`,
      );
      assert.equal(
        row.critic_source,
        expectedOutcome == null ? 'unresolved' : 'hard_filter',
        `кто принял решение по ${impact}/${evidence}`,
      );

      // Карта из 9 измерений сохраняется целиком — по ней видно, ПОЧЕМУ так решено.
      const card = JSON.parse(row.critic_assessment);
      for (const field of ['evidence_strength', 'business_consequence', 'actionability', 'novelty',
        'scope_impact', 'cost_impact', 'schedule_impact', 'contract_impact', 'responsibility_impact']) {
        assert.ok(card[field], `${impact}/${evidence}: в карте нет измерения ${field}`);
      }
      assert.equal(card.business_consequence, impact, 'последствие = уровень влияния клетки');
      assert.ok(card.rule, 'сработавшее правило названо');

      // show_to_engineer в БД обязан совпадать с вердиктом: колонку читают
      // клиент и выгрузки.
      assert.equal(
        Number(row.show_to_engineer) === 1,
        row.verdict === 'publish',
        `show_to_engineer рассогласован с вердиктом (${impact}/${evidence})`,
      );
      // Причины: publish объясняет публикацию, suppress — скрытие, verify — ни то ни другое.
      if (row.verdict === 'publish') {
        assert.ok(row.publication_reason, `${impact}/${evidence}: нет причины публикации`);
        assert.equal(row.suppression_reason, null);
      } else if (row.verdict === 'suppress') {
        assert.ok(row.suppression_reason, `${impact}/${evidence}: нет причины скрытия`);
        assert.equal(row.publication_reason, null);
      } else {
        assert.equal(row.publication_reason, null);
        assert.equal(row.suppression_reason, null);
      }
      assert.ok(m.REQUIRED_ACTIONS.includes(row.required_action), `required_action=${row.required_action}`);
      const dims = JSON.parse(row.impact_dimensions);
      assert.ok(Array.isArray(dims), 'impact_dimensions хранится JSON-массивом');
      for (const d of dims) assert.ok(m.IMPACT_DIMENSIONS.includes(d), `измерение вне словаря: ${d}`);
    }
  }

  // Главный инвариант: замечание с низким/нулевым последствием не публикуется
  // никогда, а спорное — не публикуется без критика.
  const published = rows.filter((r) => r.verdict === 'publish');
  assert.ok(published.every((r) => ['critical', 'high'].includes(r.impact_level)));
  assert.ok(published.every((r) => r.evidence_level === 'strong'));
});

// --- 2. Режимы выборки — это SQL --------------------------------------------

test('режимы выборки: working = только опубликованное, verify и full ничего не теряют', OPTS, async () => {
  const publishedExpected = [];
  const verifyExpected = [];
  const suppressedExpected = [];
  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      const bucket = expectedVerdict(EXPECTED_OUTCOME[impact][evidence]);
      const id = caseId(impact, evidence);
      if (bucket === 'publish') publishedExpected.push(id);
      else if (bucket === 'verify') verifyExpected.push(id);
      else suppressedExpected.push(id);
    }
  }

  const working = await critic.listIssueReviews(TENDER_ID, 'working', { runId: matrixRunId });
  assert.deepEqual(
    working.map((r) => r.draft_issue_id).sort(),
    [...publishedExpected].sort(),
    'по умолчанию инженер видит ровно опубликованные материальные замечания',
  );
  assert.ok(working.every((r) => r.verdict === 'publish'));

  const toVerify = await critic.listIssueReviews(TENDER_ID, 'verify', { runId: matrixRunId });
  assert.deepEqual(toVerify.map((r) => r.draft_issue_id).sort(), [...verifyExpected].sort());

  const important = await critic.listIssueReviews(TENDER_ID, 'important', { runId: matrixRunId });
  assert.ok(
    important.every((r) => r.verdict === 'publish' && ['critical', 'high'].includes(r.impact_level)),
    'important — только опубликованные с высоким влиянием',
  );
  // important — подмножество working (после precision-критика публикуется только
  // доказанное существенное, поэтому наборы могут и совпадать).
  assert.ok(important.length > 0 && important.length <= working.length);
  const workingIds = new Set(working.map((r) => r.draft_issue_id));
  assert.ok(important.every((r) => workingIds.has(r.draft_issue_id)));

  const full = await critic.listIssueReviews(TENDER_ID, 'full', { runId: matrixRunId });
  assert.equal(full.length, 15, 'ничего не удалено: скрытое и «на проверку» остаются в базе');
  const suppressed = full.filter((r) => r.verdict === 'suppress');
  assert.equal(suppressed.length, suppressedExpected.length);
  assert.ok(suppressed.every((r) => Boolean(r.suppression_reason)), 'у каждого скрытого есть причина');
  assert.ok(full.every((r) => Array.isArray(r.impact_dimensions)), 'измерения читаются массивом');
});

// --- 3. Свёртка на кластер --------------------------------------------------

test('кластер (объект рецензии) получает вердикт-свёртку и фильтруется по нему', OPTS, async () => {
  const db = getDb();
  const res = await clustering.buildClusters(TENDER_ID, matrixRunId);
  assert.ok(res.summary.clusters > 0);
  assert.equal(
    (res.summary.published || 0) + (res.summary.to_verify || 0) + (res.summary.suppressed || 0),
    res.summary.clusters,
    'каждый кластер получил один из трёх вердиктов',
  );

  const rows = await db.queryAll(
    `SELECT verdict, overall_impact_level, overall_evidence_level, impact_dimensions,
            required_action, show_to_engineer
       FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?`,
    TENDER_ID, matrixRunId,
  );
  assert.equal(rows.length, res.summary.clusters);
  for (const r of rows) {
    assert.ok(m.VERDICTS.includes(r.verdict), `вердикт кластера вне словаря: ${r.verdict}`);
    assert.ok(m.IMPACT_LEVELS.includes(r.overall_impact_level));
    assert.ok(m.EVIDENCE_LEVELS.includes(r.overall_evidence_level));
    assert.ok(m.REQUIRED_ACTIONS.includes(r.required_action));
    assert.ok(Array.isArray(JSON.parse(r.impact_dimensions)));
    assert.equal(Number(r.show_to_engineer) === 1, r.verdict === 'publish');
  }

  const working = await clustering.listClusters(TENDER_ID, 'working', matrixRunId);
  assert.ok(working.length > 0);
  assert.ok(working.every((c) => c.verdict === 'publish'), 'основной список — только опубликованные кластеры');
  const toVerify = await clustering.listClusters(TENDER_ID, 'verify', matrixRunId);
  assert.ok(toVerify.every((c) => c.verdict === 'verify'));
  const full = await clustering.listClusters(TENDER_ID, 'full', matrixRunId);
  assert.equal(full.length, rows.length, 'полный режим показывает все кластеры снимка');
  assert.ok(full.length >= working.length + toVerify.length);
});

// --- 3a. Уровень 2 критика: решение модели доезжает до колонок ---------------

test('LLM-уровень критика: решение по спорному замечанию сохраняется в issue_reviews', OPTS, async (t) => {
  const db = getDb();
  const { installFakeLlm } = require('../helpers/fakeLlm');
  // Спорные клетки прошлого прогона (medium/*, critical|high + medium|weak) —
  // ровно те, что уровень 1 решить не смог. Модель отвечает на все: половину
  // публикует, половину скрывает.
  const llm = installFakeLlm(t, (call) => {
    const ids = [...String(call.user).matchAll(/id: (\S+)/g)].map((mm) => mm[1]);
    return {
      decisions: ids.map((id, i) => ({
        id,
        evidence_strength: 'medium',
        business_consequence: i % 2 === 0 ? 'high' : 'medium',
        actionability: 'actionable',
        novelty: 'novel',
        scope_impact: 'none',
        cost_impact: i % 2 === 0 ? 'high' : 'medium',
        schedule_impact: 'none',
        contract_impact: 'none',
        responsibility_impact: 'none',
        outcome: i % 2 === 0 ? 'publish_working' : 'hide_informational',
        reasons_against: i % 2 === 0 ? ['доказательства неполные'] : ['последствие не доказано'],
        reason: i % 2 === 0 ? 'Существенное последствие подтверждено цитатой.' : 'Последствие не доказано.',
      })),
    };
  });

  const runId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'materiality.llm' });
  let index = 0;
  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      // eslint-disable-next-line no-await-in-loop
      await insertMatrixDraft(db, runId, impact, evidence, index, 'llm');
      index += 1;
    }
  }

  const res = await critic.buildIssueReviews(TENDER_ID, runId, { llmEnabled: true });
  assert.ok(llm.callCount > 0, 'спорные замечания обязаны уйти в критика');
  assert.equal(res.summary.precision.llm_enabled, true);
  assert.ok(res.summary.precision.llm_checked > 0, 'решения модели учтены');
  assert.equal(res.summary.precision.unresolved, 0, 'после ответа критика нерешённых не остаётся');

  const rows = await db.queryAll(
    `SELECT draft_issue_id, verdict, critic_outcome, critic_source, publication_reason, suppression_reason
       FROM issue_reviews WHERE tender_id = ? AND analysis_run_id = ? AND critic_source = 'llm'`,
    TENDER_ID, runId,
  );
  assert.ok(rows.length > 0, 'в БД должны быть строки, решённые моделью');
  for (const row of rows) {
    assert.ok(['publish_working', 'hide_informational'].includes(row.critic_outcome));
    assert.equal(row.verdict, row.critic_outcome === 'publish_working' ? 'publish' : 'suppress');
    if (row.verdict === 'publish') {
      // Доводы против сохраняются даже у опубликованного — инженер видит, чего не хватает.
      assert.ok(/Доводы против/.test(row.publication_reason), row.publication_reason);
    } else {
      assert.ok(row.suppression_reason);
    }
  }

  // Ни одна строка не осталась без вердикта.
  const unresolved = await db.queryOne(
    `SELECT COUNT(*) AS c FROM issue_reviews
      WHERE tender_id = ? AND analysis_run_id = ? AND verdict = 'verify'`,
    TENDER_ID, runId,
  );
  assert.equal(Number(unresolved.c), 0);
});

// --- 4. Перенос старых данных (правило 7) -----------------------------------

test('перенос старых строк: важное остаётся видимым, ничего не удалено, повтор идемпотентен', OPTS, async () => {
  const db = getDb();
  const { backfillMateriality } = require('../../db/migrate');
  const runId = await analysisRuns.beginCandidateRun(LEGACY_TENDER_ID, { reason: 'materiality.legacy' });

  // Строки «прежней модели»: вердикта нет вовсе, есть только display_priority
  // и show_to_engineer — ровно то, что лежит в базе, обновляемой со старой версии.
  const legacy = [
    { id: 'lg-critical', priority: 'critical', shown: 1, expect: 'publish' },
    { id: 'lg-high', priority: 'high', shown: 1, expect: 'publish' },
    { id: 'lg-medium', priority: 'medium', shown: 1, expect: 'verify' },
    { id: 'lg-low', priority: 'low', shown: 0, expect: 'suppress' },
    { id: 'lg-null', priority: null, shown: 1, expect: 'suppress' },
  ];
  for (const row of legacy) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      `INSERT INTO draft_issues (id, tender_id, analysis_run_id, source_fragment, category,
         basis, suggested_action, confidence, paragraph_index, created_at)
       VALUES (?, ?, ?, 'фрагмент ТЗ', 'coverage', 'основание', 'comment', 0.7, 1, ?)`,
      `d-${row.id}`, LEGACY_TENDER_ID, runId, nowIso(),
    );
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      `INSERT INTO issue_reviews (id, tender_id, analysis_run_id, draft_issue_id, business_impact,
         display_priority, show_to_engineer, critic_comment, criteria_json, score, created_at)
       VALUES (?, ?, ?, ?, 'medium', ?, ?, 'прежняя модель', '[]', 5, ?)`,
      row.id, LEGACY_TENDER_ID, runId, `d-${row.id}`, row.priority, row.shown, nowIso(),
    );
  }
  // Строка, уже посчитанная НОВЫМ кодом: миграция не имеет права её переписать.
  await db.queryRun(
    `INSERT INTO draft_issues (id, tender_id, analysis_run_id, source_fragment, category,
       basis, suggested_action, confidence, paragraph_index, created_at)
     VALUES ('d-lg-fresh', ?, ?, 'фрагмент ТЗ', 'coverage', 'основание', 'comment', 0.7, 2, ?)`,
    LEGACY_TENDER_ID, runId, nowIso(),
  );
  await db.queryRun(
    `INSERT INTO issue_reviews (id, tender_id, analysis_run_id, draft_issue_id, display_priority,
       show_to_engineer, criteria_json, score, created_at,
       impact_level, evidence_level, verdict, impact_dimensions, publication_reason, required_action)
     VALUES ('lg-fresh', ?, ?, 'd-lg-fresh', 'low', 0, '[]', 1, ?,
       'critical', 'strong', 'publish', '["contract"]', 'посчитано новой моделью', 'amend_tz')`,
    LEGACY_TENDER_ID, runId, nowIso(),
  );

  const before = await backfillMateriality();
  assert.ok(before.issue_reviews >= legacy.length, `перенесено строк: ${before.issue_reviews}`);

  const rows = await db.queryAll(
    `SELECT id, verdict, impact_level, evidence_level, publication_reason, suppression_reason,
            show_to_engineer, required_action
       FROM issue_reviews WHERE tender_id = ?`,
    LEGACY_TENDER_ID,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(rows.length, legacy.length + 1, 'ни одна строка не удалена');

  for (const row of legacy) {
    const r = byId.get(row.id);
    assert.equal(r.verdict, row.expect, `${row.id}: прежний приоритет ${row.priority} → ${row.expect}`);
    assert.ok(m.IMPACT_LEVELS.includes(r.impact_level));
    assert.ok(m.EVIDENCE_LEVELS.includes(r.evidence_level));
    assert.equal(Number(r.show_to_engineer) === 1, r.verdict === 'publish', `${row.id}: show_to_engineer синхронизирован`);
    const reason = r.publication_reason || r.suppression_reason || '';
    if (r.verdict !== 'verify') {
      assert.ok(
        reason.includes(m.LEGACY_REASON_PREFIX),
        `${row.id}: в причине должна быть пометка о переносе, получено «${reason}»`,
      );
    }
  }

  // Строка новой модели не тронута.
  const fresh = byId.get('lg-fresh');
  assert.equal(fresh.verdict, 'publish');
  assert.equal(fresh.impact_level, 'critical');
  assert.equal(fresh.publication_reason, 'посчитано новой моделью');

  // Идемпотентность: второй прогон не меняет ни одной строки ЭТОГО тендера.
  // (Счётчики backfill'а глобальные — integration-файлы идут параллельно и могут
  // добавлять свои legacy-строки, поэтому сравниваем состояние, а не счётчик.)
  await backfillMateriality();
  const after = await db.queryAll(
    `SELECT id, verdict, impact_level FROM issue_reviews WHERE tender_id = ? ORDER BY id`,
    LEGACY_TENDER_ID,
  );
  assert.deepEqual(
    after,
    rows
      .map((r) => ({ id: r.id, verdict: r.verdict, impact_level: r.impact_level }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    'состояние после повторного переноса совпадает с состоянием после первого',
  );
  const stillNull = await db.queryOne(
    'SELECT COUNT(*) AS c FROM issue_reviews WHERE tender_id = ? AND verdict IS NULL',
    LEGACY_TENDER_ID,
  );
  assert.equal(Number(stillNull.c), 0, 'после переноса не осталось строк без вердикта');

  // Перенос старого draft_issue: уровень влияния НЕ выдуман (агент его не давал),
  // вердикт — verify, замечание не потеряно.
  const drafts = await db.queryAll(
    'SELECT id, impact_level, evidence_level, verdict FROM draft_issues WHERE tender_id = ? ORDER BY id',
    LEGACY_TENDER_ID,
  );
  assert.equal(drafts.length, legacy.length + 1);
  for (const d of drafts) {
    assert.equal(d.impact_level, null, '«агент не оценил» не превращается в «влияния нет»');
    assert.equal(d.verdict, 'verify');
    assert.ok(m.EVIDENCE_LEVELS.includes(d.evidence_level));
  }
});
