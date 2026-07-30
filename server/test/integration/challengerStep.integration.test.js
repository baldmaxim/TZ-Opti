'use strict';

// Integration: challenger-шаг конвейера на живом PostgreSQL + fake LLM.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Сквозной контракт механизма Б (разделение Стадии 5):
//   • challenger сканирует ТЗ против СОБРАННЫХ кластеров кандидата;
//   • его находка публикуется ШТАТНЫМ снимком стадии 5 (issue + сигнал
//     'challenger' + указатель stage:5);
//   • пересборка слоёв делает пропуск ОБЫЧНЫМ замечанием: draft_issue → review →
//     кластер в том же кандидате (решение инженера — как у любого замечания);
//   • детерминированный анти-дубль: цитата, покрытая существующим кластером,
//     отбрасывается.

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.STAGE_CROSS_SEGMENT_REVIEW = '0'; // без LLM-шага сверки: счёт вызовов детерминирован
process.env.PRECISION_CRITIC = '0'; // спорные → verify без LLM (fail-closed)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { installFakeLlm } = require('../helpers/fakeLlm');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const unified = require('../../services/unifiedAnalysis/unifiedIssueBuilder');
const critic = require('../../services/critic/criticService');
const clustering = require('../../services/clustering/clusteringService');
const { runChallengerStep } = require('../../services/pipeline/challengerStep');
const { newId, nowIso } = require('../../utils/ids');

const OPTS = dbTestOptions();
const TENDER_ID = 'challenger-int-tender';

const QUOTE_COVERED = 'Подрядчик обязан обеспечить ежедневную уборку строительной площадки.';
const QUOTE_MISSED = 'Пусконаладочные работы выполняются силами Подрядчика без дополнительной оплаты.';
const TZ_MD = [
  '# ТЗ на СМР',
  '## 1. Обязанности',
  QUOTE_COVERED,
  '## 2. ПНР',
  QUOTE_MISSED,
].join('\n');

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Challenger: integration-тест', 'draft', nowIso(),
  );
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', 'tz.md', 'virtual://tz.md', ?, ?, 'extracted')`,
    'challenger-tz-md', TENDER_ID, nowIso(), TZ_MD,
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

// Стадии 1–4 completed + сигнал стадии 1 по QUOTE_COVERED → кандидат конвейера
// со слоями draft → critic → clustering (реальные билдеры, без LLM).
async function seedCandidate(db) {
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(TENDER_ID);
  const configVersion = analysisRuns.currentConfigVersion();
  const stageRuns = {};
  for (const stage of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const runId = await analysisRuns.beginRun(TENDER_ID, analysisRuns.stageScope(stage), {
      stage, documentsRevisionId, configVersion,
    });
    // eslint-disable-next-line no-await-in-loop
    await analysisRuns.activateRun(TENDER_ID, analysisRuns.stageScope(stage), runId, {
      documentsRevisionId, configVersion,
    });
    stageRuns[stage] = runId;
  }
  await db.queryRun(
    `INSERT INTO analysis_signals
       (id, tender_id, analysis_run_id, analysis_stage, signal_type, source_fragment, tz_clause, signal_payload_json, created_at)
     VALUES (?, ?, ?, 1, 'coverage', ?, 'п. 1', ?, ?)`,
    newId(), TENDER_ID, stageRuns[1], QUOTE_COVERED,
    JSON.stringify({
      problem_type: 'не_учтено_в_вор', criticality: 'high', basis: 'Уборка не посчитана в ведомости.',
      paragraph_index: 2, suggested_action: 'clarify',
    }),
    nowIso(),
  );
  const candidateId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'challenger.test' });
  await unified.buildDraftIssues(TENDER_ID, candidateId);
  await critic.buildIssueReviews(TENDER_ID, candidateId);
  await clustering.buildClusters(TENDER_ID, candidateId);
  return { candidateId, stageRuns };
}

test('пропуск становится обычным замечанием: снимок стадии 5 + пересборка кандидата', OPTS, async (t) => {
  const db = getDb();
  const { candidateId } = await seedCandidate(db);

  const clustersBefore = await db.queryAll(
    'SELECT id FROM issue_clusters WHERE tender_id = ? AND analysis_run_id = ?', TENDER_ID, candidateId,
  );
  assert.ok(clustersBefore.length >= 1, 'кандидат собран до challenger');

  // Ответ challenger-агента: один настоящий пропуск (ПНР) + один повтор
  // покрытой цитаты (должен быть отброшен детерминированным анти-дублем).
  installFakeLlm(t, [{
    findings: [
      {
        fragment: QUOTE_MISSED,
        section_path: '2. ПНР',
        problem_type: 'пропущенный_риск',
        criticality: 'high',
        suggested_action: 'clarify',
        suggested_redaction: 'ПНР выделить отдельным разделом ВОР с составом и ценой.',
        review_comment: 'ПНР не оценена — запросить состав и объём у Заказчика.',
        basis: 'ПНР включена в объём без оценки — прямой недоучёт стоимости.',
        confidence: 0.85,
      },
      {
        fragment: QUOTE_COVERED,
        section_path: '1. Обязанности',
        problem_type: 'пропущенный_риск',
        criticality: 'medium',
        suggested_action: 'comment',
        basis: 'Повтор уже найденного (проверка анти-дубля).',
        confidence: 0.9,
      },
    ],
  }]);

  const { summary } = await runChallengerStep(TENDER_ID, candidateId);
  assert.equal(summary.found, 1, 'повтор покрытой цитаты отброшен');
  assert.equal(summary.published, 1);
  assert.equal(summary.rebuilt, true);
  assert.ok(summary.covered_clusters >= 1);
  assert.equal(summary.dropped_covered, 1);

  // Снимок стадии 5: указатель, issue с типом домена стадии 5, сигнал challenger.
  const stage5RunId = await analysisRuns.getActiveStageRunId(TENDER_ID, 5);
  assert.equal(stage5RunId, summary.stage_run_id);
  const issue = await db.queryOne(
    'SELECT * FROM issues WHERE tender_id = ? AND analysis_run_id = ?', TENDER_ID, stage5RunId,
  );
  assert.equal(issue.problem_type, 'пропущенный_риск');
  assert.equal(Number(issue.analysis_stage), 5);
  assert.ok((issue.source_fragment || '').includes('Пусконаладочные'));
  const sig = await db.queryOne(
    'SELECT signal_type FROM analysis_signals WHERE tender_id = ? AND analysis_run_id = ?',
    TENDER_ID, stage5RunId,
  );
  assert.equal(sig.signal_type, 'challenger');

  // Пересборка кандидата: находка challenger — обычный draft_issue и КЛАСТЕР
  // (решение инженера пишется на кластер, как у всех замечаний).
  const draft = await db.queryOne(
    `SELECT * FROM draft_issues WHERE tender_id = ? AND analysis_run_id = ? AND problem_type = 'пропущенный_риск'`,
    TENDER_ID, candidateId,
  );
  assert.ok(draft, 'draft_issue из challenger-сигнала');
  const clustersAfter = await db.queryAll(
    `SELECT c.* FROM issue_clusters c
      WHERE c.tender_id = ? AND c.analysis_run_id = ? AND c.final_problem_type = 'пропущенный_риск'`,
    TENDER_ID, candidateId,
  );
  assert.equal(clustersAfter.length, 1, 'пропуск стал кластером в том же кандидате');
});

test('пусто — тоже результат: без находок снимок стадии 5 публикуется, пересборки нет', OPTS, async (t) => {
  const db = getDb();
  const candidateId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'challenger.empty' });
  await unified.buildDraftIssues(TENDER_ID, candidateId);
  await critic.buildIssueReviews(TENDER_ID, candidateId);
  await clustering.buildClusters(TENDER_ID, candidateId);

  installFakeLlm(t, [{ findings: [] }]);
  const { summary } = await runChallengerStep(TENDER_ID, candidateId);
  assert.equal(summary.found, 0);
  assert.equal(summary.rebuilt, false);
  const stage5RunId = await analysisRuns.getActiveStageRunId(TENDER_ID, 5);
  assert.equal(stage5RunId, summary.stage_run_id, 'пустой снимок активирован — «пропусков нет» видно в истории');
  const run = await analysisRuns.getRun(stage5RunId);
  assert.equal(run.status, 'completed');
});

test('сбой сканера — fail-loud: прогон стадии 5 failed, шаг конвейера падает', OPTS, async (t) => {
  const db = getDb();
  const candidateId = await analysisRuns.beginCandidateRun(TENDER_ID, { reason: 'challenger.fail' });
  await unified.buildDraftIssues(TENDER_ID, candidateId);
  await critic.buildIssueReviews(TENDER_ID, candidateId);
  await clustering.buildClusters(TENDER_ID, candidateId);

  const prevPointer = await analysisRuns.getActiveStageRunId(TENDER_ID, 5);
  installFakeLlm(t, [new Error('LLM недоступен (тест)')]);
  await assert.rejects(() => runChallengerStep(TENDER_ID, candidateId), /LLM недоступен/);

  // Указатель стадии 5 не сдвинулся, упавший прогон закрыт как failed.
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 5), prevPointer);
  const failed = await db.queryOne(
    `SELECT status FROM analysis_runs
      WHERE tender_id = ? AND stage = 5 AND status = 'failed'
      ORDER BY started_at DESC LIMIT 1`,
    TENDER_ID,
  );
  assert.ok(failed, 'прогон challenger закрыт как failed');
});
