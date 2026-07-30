'use strict';

// Integration: АТОМАРНАЯ ПУБЛИКАЦИЯ РЕЗУЛЬТАТА СТАДИИ на живой PostgreSQL.
//
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// publishStageResult материализует снимок стадии (issues + signals + закрытие
// частей ТЗ + активация указателя + workflow-статус) в ОДНОЙ транзакции
// вызывающего. Юнит-тесты проверяют контракт на подставной транзакции; здесь —
// то, что подставная транзакция доказать не может:
//   1. До коммита НИЧЕГО не видно снаружи (другое соединение пула читает прежний
//      снимок), после коммита видно ВСЁ сразу.
//   2. Сбой на ЛЮБОМ шаге (issues / signals / segments / внутри activateRun /
//      после активации / workflow / прямо перед commit) откатывает ВСЁ:
//      старый прогон остаётся активным и не архивированным, кандидат не
//      активирован, workflow не 'reviewing', частичных строк нет, чужие
//      прогоны не тронуты.
//   3. Границы: стадии 1–5 без сигналов при находках не публикуются (стадия 5 —
//      challenger-сигналы; пустой её снимок публикуется с 0 сигналов);
//      завершённый / проваленный / архивированный кандидат, чужой тендер,
//      несуществующий и уже опубликованный прогон отклоняются без записи.

// Настройки читаются модулями при загрузке — задаём ДО require() движка.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.STAGE_CROSS_SEGMENT_REVIEW = '0'; // без LLM-шага сверки: счёт вызовов детерминирован

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { installFakeLlm } = require('../helpers/fakeLlm');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const segmentStore = require('../../services/stageAnalysis/segments/segmentStore');
const stageState = require('../../services/stageAnalysis/stageState');
const { publishStageResult } = require('../../services/stageAnalysis/publishStageResult');
const engine = require('../../services/stageAnalysis/stageAnalysisEngine');
const stageJob = require('../../services/jobs/handlers/stageAnalysisJob');
const { newId, nowIso } = require('../../utils/ids');

const OPTS = dbTestOptions();
const TENDER_ID = 'publish-stage-tender';
const FOREIGN_TENDER_ID = 'publish-stage-foreign-tender';
// Отдельный тендер для сквозного production-пути (движок + fake LLM), чтобы не
// пересекаться с ручными фикстурами сценариев выше.
const ENGINE_TENDER_ID = 'publish-stage-engine-tender';
const REV = 'docs_publish_test';
const CFG = 'cfg_publish_test';

// --- Фикстуры ---------------------------------------------------------------------

function issueFixture(fragment, over = {}) {
  return {
    problem_type: 'не_учтено_в_кп',
    criticality: 'high',
    basis: 'работа описана в ТЗ, но не найдена в ведомости',
    source_fragment: fragment,
    section_path: 'п. 4.1',
    confidence: 0.8,
    ...over,
  };
}

const ISSUES = [issueFixture('Подрядчик обеспечивает ежедневную уборку'), issueFixture('Вывоз строительного мусора')];

// Полный корректный вход публикации; сигналы — функцией от сохранённых issues
// (id находок известны только после записи).
function publishArgs(ctx, over = {}) {
  return {
    tenderId: TENDER_ID,
    stage: ctx.stage,
    analysisRunId: ctx.newRunId,
    issues: ISSUES,
    signals: (records) => records.map((r) => ({ issueId: r.issueId, issue: r.issue })),
    summary: { stage: ctx.stage, status: 'completed' },
    ...over,
  };
}

async function seedIssue(db, id, runId, stage) {
  await db.queryRun(
    `INSERT INTO issues (id, tender_id, analysis_run_id, analysis_stage, source_fragment,
       problem_type, criticality, review_status)
     VALUES (?, ?, ?, ?, 'фрагмент прежнего снимка', 'не_учтено_в_кп', 'high', 'pending')`,
    id, TENDER_ID, runId, stage,
  );
}

async function seedSignal(db, id, runId, stage, issueId) {
  await db.queryRun(
    `INSERT INTO analysis_signals (id, tender_id, analysis_run_id, analysis_stage, signal_type,
       source_entity_type, source_entity_id, tz_clause, source_fragment, signal_payload_json, weight, created_at)
     VALUES (?, ?, ?, ?, 'coverage', 'issue', ?, 'п. 1.1', 'фрагмент прежнего снимка', '{}', 0.8, ?)`,
    id, TENDER_ID, runId, stage, issueId, nowIso(),
  );
}

async function wipeTender(db, tenderId) {
  for (const t of ['analysis_run_segments', 'analysis_segments', 'analysis_active_runs',
    'analysis_signals', 'issues', 'analysis_runs', 'tender_stage_state']) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(`DELETE FROM ${t} WHERE tender_id = ?`, tenderId);
  }
}

// Исходное состояние каждого сценария:
//   • старый прогон стадии — completed, АКТИВНЫЙ (указатель), со своими issue,
//     сигналом и завершённой частью ТЗ — «данные другого analysis_run_id»;
//   • новый прогон-кандидат — status='running', указатель НЕ на нём;
//   • его части ТЗ: №0 completed(llm), №1 running, №2 pending;
//   • workflow стадии — 'running'.
async function resetScenario({ stage = 1 } = {}) {
  const db = getDb();
  await wipeTender(db, TENDER_ID);
  await stageState.getStageState(TENDER_ID);

  const scope = analysisRuns.stageScope(stage);
  const oldRunId = await analysisRuns.beginRun(TENDER_ID, scope, {
    stage, documentsRevisionId: REV, configVersion: CFG,
  });
  await seedIssue(db, `old-issue-${stage}`, oldRunId, stage);
  await seedSignal(db, `old-signal-${stage}`, oldRunId, stage, `old-issue-${stage}`);
  await analysisRuns.activateRun(TENDER_ID, scope, oldRunId, {
    documentsRevisionId: REV, configVersion: CFG,
  });
  await segmentStore.planRunSegments(oldRunId, TENDER_ID, stage, {
    revisionId: 'rev_old', segments: [{ index: 0, inputHash: 'o0' }],
  });
  await segmentStore.markRunSegmentDone(oldRunId, 0, { count: 1, source: 'llm' });

  const newRunId = await analysisRuns.beginRun(TENDER_ID, scope, {
    stage, documentsRevisionId: REV, configVersion: CFG,
  });
  await segmentStore.planRunSegments(newRunId, TENDER_ID, stage, {
    revisionId: 'rev_new', segments: [0, 1, 2].map((i) => ({ index: i, inputHash: `h${i}` })),
  });
  await segmentStore.markRunSegmentDone(newRunId, 0, { count: 2, source: 'llm' });
  await segmentStore.markRunSegmentRunning(newRunId, 1);

  await db.queryRun(
    `UPDATE tender_stage_state SET stage${stage}_status = 'running', current_stage = ? WHERE tender_id = ?`,
    stage, TENDER_ID,
  );
  return { db, stage, oldRunId, newRunId };
}

// --- Сверки состояния --------------------------------------------------------------

const count = async (db, table, runId) => Number((await db.queryOne(
  `SELECT COUNT(*) AS c FROM ${table} WHERE tender_id = ? AND analysis_run_id = ?`,
  TENDER_ID, runId,
)).c);

const workflowStatus = async (db, stage) => (await db.queryOne(
  `SELECT stage${stage}_status AS s FROM tender_stage_state WHERE tender_id = ?`, TENDER_ID,
)).s;

// Полная проверка «ничего не изменилось» — состояние в точности как после
// resetScenario. Используется после КАЖДОГО отката.
async function assertBaseline(ctx, label) {
  const { db, stage, oldRunId, newRunId } = ctx;

  // Старый прогон остался активным и НЕ архивированным.
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, stage), oldRunId,
    `${label}: указатель стадии обязан остаться на старом прогоне`);
  const oldRun = await analysisRuns.getRun(oldRunId);
  assert.equal(oldRun.status, 'completed', `${label}: статус старого прогона не тронут`);
  assert.equal(oldRun.superseded_at, null, `${label}: старый прогон не получил superseded_at`);

  // Кандидат не активирован и не завершён.
  const newRun = await analysisRuns.getRun(newRunId);
  assert.equal(newRun.status, 'running', `${label}: кандидат обязан остаться running`);
  assert.equal(newRun.superseded_at, null, `${label}: кандидат не архивирован`);

  // Workflow стадии не переведён.
  assert.equal(await workflowStatus(db, stage), 'running', `${label}: стадия не должна стать reviewing`);

  // Частичных записей кандидата нет.
  assert.equal(await count(db, 'issues', newRunId), 0, `${label}: частичные issues не сохранились`);
  assert.equal(await count(db, 'analysis_signals', newRunId), 0, `${label}: частичные signals не сохранились`);

  // Части ТЗ кандидата — ровно как до публикации (финализация откатилась).
  const segs = await segmentStore.listRunSegments(TENDER_ID, stage, newRunId);
  assert.deepEqual(segs.map((s) => s.status), ['completed', 'running', 'pending'],
    `${label}: изменения частей ТЗ не сохранились`);

  // Данные ДРУГОГО analysis_run_id не изменились.
  assert.equal(await count(db, 'issues', oldRunId), 1, `${label}: issues старого прогона не тронуты`);
  assert.equal(await count(db, 'analysis_signals', oldRunId), 1, `${label}: signals старого прогона не тронуты`);
  const oldSegs = await segmentStore.listRunSegments(TENDER_ID, stage, oldRunId);
  assert.deepEqual(oldSegs.map((s) => s.status), ['completed'], `${label}: части старого прогона не тронуты`);
}

// --- Инъекция сбоя -----------------------------------------------------------------

// Обёртка над НАСТОЯЩЕЙ транзакцией: до делегирования запроса проверяет условие
// сбоя. Выполненные ДО сбоя запросы уже легли в транзакцию — их обязан убрать
// ROLLBACK, это и проверяется.
function withFault(tx, { failOn = null, failWhen = null }) {
  const guard = (sql) => {
    if (failOn && sql.includes(failOn)) throw new Error(`ИНЪЕКЦИЯ: сбой на «${failOn}»`);
    if (failWhen && failWhen(sql)) throw new Error('ИНЪЕКЦИЯ: сбой по условию');
  };
  const wrap = (m) => (sql, ...params) => { guard(sql); return tx[m](sql, ...params); };
  return { queryOne: wrap('queryOne'), queryAll: wrap('queryAll'), queryRun: wrap('queryRun') };
}

// --- Жизненный цикл файла ----------------------------------------------------------

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  for (const id of [TENDER_ID, FOREIGN_TENDER_ID, ENGINE_TENDER_ID]) {
    // eslint-disable-next-line no-await-in-loop
    await wipeTender(db, id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM documents WHERE tender_id = ?', id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
      id, 'Атомарная публикация стадии', 'draft', nowIso(),
    );
  }
  // Обязательный Markdown-вход движка: ТЗ с маркером-цитатой для fake LLM.
  await db.queryRun(
    `INSERT INTO documents (id, tender_id, doc_type, name, file_path, uploaded_at, extracted_text, processing_status)
     VALUES (?, ?, 'tz', ?, ?, ?, ?, 'extracted')`,
    'publish-stage-engine-tz', ENGINE_TENDER_ID, 'ТЗ.md', '/tmp/ТЗ.md', nowIso(),
    [
      '# 1. Требования к производству работ', '',
      '1.1 МАРКЕР-УБОРКА. Подрядчик обеспечивает ежедневную уборку строительной площадки',
      'и вывоз строительного мусора за свой счёт в течение всего срока производства работ.', '',
    ].join('\n'),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  for (const id of [TENDER_ID, FOREIGN_TENDER_ID, ENGINE_TENDER_ID]) {
    // eslint-disable-next-line no-await-in-loop
    await wipeTender(db, id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM documents WHERE tender_id = ?', id);
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun('DELETE FROM tenders WHERE id = ?', id);
  }
  await closeDb();
});

// --- 1. Успех: всё видно сразу и только после коммита -------------------------------

test('успех: снимок публикуется целиком, снаружи виден только ПОСЛЕ коммита', OPTS, async () => {
  const ctx = await resetScenario();
  const { db, stage, oldRunId, newRunId } = ctx;

  let report = null;
  await db.transaction(async (tx) => {
    report = await publishStageResult({ tx, ...publishArgs(ctx) });

    // Транзакция ещё НЕ закоммичена: другое соединение пула обязано видеть
    // прежний снимок — в этом и смысл «одной атомарной операции».
    assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, stage), oldRunId,
      'до коммита указатель снаружи — старый');
    assert.equal((await analysisRuns.getRun(newRunId)).status, 'running',
      'до коммита кандидат снаружи — running');
    assert.equal(await workflowStatus(db, stage), 'running',
      'до коммита стадия снаружи — running');
    assert.equal(await count(db, 'issues', newRunId), 0, 'до коммита issues кандидата снаружи не видны');
    assert.equal(await count(db, 'analysis_signals', newRunId), 0, 'до коммита signals кандидата снаружи не видны');
  });

  // 1. Новый прогон completed и активный.
  const newRun = await analysisRuns.getRun(newRunId);
  assert.equal(newRun.status, 'completed');
  assert.ok(newRun.finished_at);
  assert.equal(newRun.superseded_at, null);
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, stage), newRunId);

  // 2. Старый — superseded, но остался completed (история не удалена).
  const oldRun = await analysisRuns.getRun(oldRunId);
  assert.ok(oldRun.superseded_at, 'прежний активный прогон архивируется активацией');
  assert.equal(oldRun.status, 'completed');

  // 3–4. Issues и signals — ТОЛЬКО у нового analysis_run_id; строки старого целы.
  assert.equal(await count(db, 'issues', newRunId), 2);
  assert.equal(await count(db, 'analysis_signals', newRunId), 2);
  assert.equal(await count(db, 'issues', oldRunId), 1);
  assert.equal(await count(db, 'analysis_signals', oldRunId), 1);
  // NOT IN не ловит NULL, поэтому «без прогона» проверяется отдельным условием:
  // строка с analysis_run_id IS NULL не принадлежит ни одному снимку и была бы
  // молча потерянной находкой.
  const strayIssues = await db.queryAll(
    `SELECT id FROM issues
      WHERE tender_id = ? AND (analysis_run_id IS NULL OR analysis_run_id NOT IN (?, ?))`,
    TENDER_ID, oldRunId, newRunId,
  );
  assert.deepEqual(strayIssues, [], 'находок без прогона или вне двух известных прогонов быть не должно');
  const straySignals = await db.queryAll(
    `SELECT id FROM analysis_signals
      WHERE tender_id = ? AND (analysis_run_id IS NULL OR analysis_run_id NOT IN (?, ?))`,
    TENDER_ID, oldRunId, newRunId,
  );
  assert.deepEqual(straySignals, [], 'сигналов без прогона или вне двух известных прогонов быть не должно');
  const signals = await db.queryAll(
    `SELECT source_entity_id FROM analysis_signals WHERE tender_id = ? AND analysis_run_id = ?`,
    TENDER_ID, newRunId,
  );
  assert.deepEqual(
    signals.map((s) => s.source_entity_id).sort(),
    [...report.issue_ids].sort(),
    'каждый сигнал ссылается на сохранённую находку этого прогона',
  );

  // 5. Части ТЗ кандидата финализированы: живых статусов не осталось.
  const segs = await segmentStore.listRunSegments(TENDER_ID, stage, newRunId);
  assert.deepEqual(segs.map((s) => s.status), ['completed', 'interrupted', 'skipped']);
  assert.equal(segs[0].source, 'llm', 'посчитанная часть не перетёрта финализацией');
  assert.deepEqual(report.segments, { interrupted: 1, skipped: 1 });

  // 6. Workflow стадии — reviewing.
  assert.equal(await workflowStatus(db, stage), 'reviewing');
  assert.deepEqual(report.workflow, { tender_id: TENDER_ID, stage, from: 'running', to: 'reviewing', changed: 1 });

  // 7. Отчёт согласован с БД.
  assert.equal(report.activated, true);
  assert.equal(report.pointer_moved, true);
  assert.deepEqual(report.verified, { issues: 2, signals: 2, signals_required: true });
  assert.equal(report.activation.previous_run_id, oldRunId);
  assert.equal(report.activation.previous_superseded, 1);
});

// --- 2. Инъекция сбоя: каждый шаг откатывает ВСЁ ------------------------------------

const FAULTS = [
  // Прогон-кандидат уже создан (beginRun в resetScenario) — сбой на ПЕРВОМ же
  // запросе публикации (SELECT … FOR UPDATE стража): записей ноль, прогон
  // остаётся running и допубликуем позже, стадия не reviewing.
  ['сразу после создания analysis_run (до первой записи)', { failOn: 'FOR UPDATE' }],
  ['запись issues', { failOn: 'INSERT INTO issues' }],
  ['запись signals', { failOn: 'INSERT INTO analysis_signals' }],
  ['финализация segments', { failOn: 'UPDATE analysis_run_segments' }],
  // Активация — два разных UPDATE: завершение строки прогона (completed) и
  // перевод указателя. Сбой между ними не должен оставить ни того, ни другого.
  ['внутри activateRun (прогон → completed)', { failOn: "SET status = 'completed'" }],
  ['внутри activateRun (перевод указателя)', { failOn: 'INSERT INTO analysis_active_runs' }],
  ['workflow update', { failOn: 'UPDATE tender_stage_state' }],
];

for (const [label, fault] of FAULTS) {
  test(`сбой: ${label} — транзакция откатывается целиком`, OPTS, async () => {
    const ctx = await resetScenario();
    await assert.rejects(
      () => ctx.db.transaction((tx) => publishStageResult({ tx: withFault(tx, fault), ...publishArgs(ctx) })),
      /ИНЪЕКЦИЯ/,
      `сценарий «${label}» обязан уронить публикацию`,
    );
    await assertBaseline(ctx, label);
  });
}

test('сбой: после activateRun, но ДО workflow update — откат целиком', OPTS, async () => {
  const ctx = await resetScenario();
  // Указатель уже переведён внутри транзакции; падает ПЕРВЫЙ запрос после этого
  // (проверка прогона перед переводом статуса стадии).
  let pointerMoved = false;
  const failWhen = (sql) => {
    if (sql.includes('INSERT INTO analysis_active_runs')) { pointerMoved = true; return false; }
    return pointerMoved;
  };
  await assert.rejects(
    () => ctx.db.transaction((tx) => publishStageResult({ tx: withFault(tx, { failWhen }), ...publishArgs(ctx) })),
    /ИНЪЕКЦИЯ/,
  );
  assert.equal(pointerMoved, true, 'сбой обязан случиться именно ПОСЛЕ перевода указателя');
  await assertBaseline(ctx, 'после activateRun');
});

test('сбой: непосредственно перед commit — даже полностью успешная публикация откатывается', OPTS, async () => {
  const ctx = await resetScenario();
  let report = null;
  await assert.rejects(
    () => ctx.db.transaction(async (tx) => {
      report = await publishStageResult({ tx, ...publishArgs(ctx) });
      throw new Error('ИНЪЕКЦИЯ: сбой перед commit');
    }),
    /перед commit/,
  );
  // Сервис успел отчитаться об успехе — но без коммита вызывающего в БД НИЧЕГО нет.
  assert.equal(report.activated, true);
  assert.equal(report.workflow_status_applied, true);
  await assertBaseline(ctx, 'перед commit');
});

// --- 3. Обязательность сигналов -----------------------------------------------------

test('стадии 1–4: публикация без signals отклоняется, состояние не меняется', OPTS, async () => {
  for (const stage of [1, 2, 3, 4]) {
    // eslint-disable-next-line no-await-in-loop
    const ctx = await resetScenario({ stage });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ctx.db.transaction((tx) => publishStageResult({ tx, ...publishArgs(ctx, { signals: null }) })),
      (err) => err.code === 'PUBLISH_SIGNALS_REQUIRED',
      `стадия ${stage} обязана требовать сигналы`,
    );
    // eslint-disable-next-line no-await-in-loop
    await assertBaseline(ctx, `стадия ${stage} без signals`);
  }
});

test('стадия 5: пустой challenger-снимок публикуется с 0 сигналов, находки дают сигналы', OPTS, async () => {
  // «Независимая проверка пропусков ничего не нашла» — валидный снимок: 0 находок,
  // 0 сигналов (общее правило «пустые сигналы допустимы при 0 находок»).
  const ctx = await resetScenario({ stage: 5 });
  let report = null;
  await ctx.db.transaction(async (tx) => {
    report = await publishStageResult({ tx, ...publishArgs(ctx, { issues: [], signals: (r) => r }) });
  });
  assert.equal(report.signals.written, 0);
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, 5), ctx.newRunId);
  assert.equal((await analysisRuns.getRun(ctx.newRunId)).status, 'completed');
  assert.equal(await workflowStatus(ctx.db, 5), 'reviewing');
  assert.equal(await count(ctx.db, 'analysis_signals', ctx.newRunId), 0);

  // Challenger-находки — снимок С СИГНАЛАМИ (тип 'challenger'): именно через них
  // пропуски становятся обычными замечаниями конвейера.
  const ctx2 = await resetScenario({ stage: 5 });
  await ctx2.db.transaction(async (tx) => {
    await publishStageResult({
      tx,
      ...publishArgs(ctx2, {
        issues: [{
          problem_type: 'пропущенный_риск',
          source_fragment: 'Подрядчик обязан выполнить пусконаладку всех систем.',
          paragraph_index: 3,
          basis: 'ПНР не выделена в объёме и не оценена — прямой недоучёт.',
          criticality: 'high',
          suggested_action: 'clarify',
        }],
        signals: (records) => records,
      }),
    });
  });
  assert.equal(await count(ctx2.db, 'analysis_signals', ctx2.newRunId), 1);
  const sig = await ctx2.db.queryOne(
    'SELECT signal_type, analysis_stage FROM analysis_signals WHERE analysis_run_id = ?',
    ctx2.newRunId,
  );
  assert.equal(sig.signal_type, 'challenger');
  assert.equal(Number(sig.analysis_stage), 5);
});

// --- 4. Непубликуемые кандидаты -----------------------------------------------------

test('completed / failed / superseded кандидат отклоняется без записи', OPTS, async () => {
  const cases = [
    ['completed', `UPDATE analysis_runs SET status = 'completed' WHERE id = ?`],
    ['failed', `UPDATE analysis_runs SET status = 'failed' WHERE id = ?`],
    ['superseded', `UPDATE analysis_runs SET superseded_at = '${nowIso()}' WHERE id = ?`],
  ];
  for (const [label, sql] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const ctx = await resetScenario();
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.queryRun(sql, ctx.newRunId);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ctx.db.transaction((tx) => publishStageResult({ tx, ...publishArgs(ctx) })),
      (err) => err.code === 'RUN_NOT_WRITABLE',
      `кандидат «${label}» публиковаться не должен`,
    );
    // Ничего не записано и не активировано; указатель и workflow — прежние.
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, ctx.stage), ctx.oldRunId, label);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await workflowStatus(ctx.db, ctx.stage), 'running', label);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await count(ctx.db, 'issues', ctx.newRunId), 0, label);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await count(ctx.db, 'analysis_signals', ctx.newRunId), 0, label);
  }
});

test('прогон другого тендера отклоняется, его состояние не меняется', OPTS, async () => {
  const ctx = await resetScenario();
  const foreignRunId = await analysisRuns.beginRun(FOREIGN_TENDER_ID, analysisRuns.stageScope(1), {
    stage: 1, documentsRevisionId: REV, configVersion: CFG,
  });
  await assert.rejects(
    () => ctx.db.transaction((tx) => publishStageResult({
      tx, ...publishArgs(ctx, { analysisRunId: foreignRunId }),
    })),
    (err) => err.code === 'RUN_NOT_WRITABLE' && /другому тендеру/.test(err.message),
  );
  assert.equal((await analysisRuns.getRun(foreignRunId)).status, 'running', 'чужой прогон не тронут');
  await assertBaseline(ctx, 'чужой тендер');
});

test('отсутствующий прогон отклоняется без записи', OPTS, async () => {
  const ctx = await resetScenario();
  await assert.rejects(
    () => ctx.db.transaction((tx) => publishStageResult({
      tx, ...publishArgs(ctx, { analysisRunId: `run-missing-${newId()}` }),
    })),
    (err) => err.code === 'RUN_NOT_WRITABLE' && /не найден/.test(err.message),
  );
  await assertBaseline(ctx, 'отсутствующий прогон');
});

test('повторная публикация в уже опубликованный прогон отклоняется, снимок цел', OPTS, async () => {
  const ctx = await resetScenario();
  await ctx.db.transaction((tx) => publishStageResult({ tx, ...publishArgs(ctx) }));
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, ctx.stage), ctx.newRunId);

  await assert.rejects(
    () => ctx.db.transaction((tx) => publishStageResult({
      tx,
      ...publishArgs(ctx, { issues: [issueFixture('Попытка подменить снимок')] }),
    })),
    (err) => err.code === 'RUN_NOT_WRITABLE' && /уже завершён/.test(err.message),
  );

  // Первый опубликованный снимок в точности сохранился.
  assert.equal((await analysisRuns.getRun(ctx.newRunId)).status, 'completed');
  assert.equal(await analysisRuns.getActiveStageRunId(TENDER_ID, ctx.stage), ctx.newRunId);
  assert.equal(await count(ctx.db, 'issues', ctx.newRunId), 2, 'issues первого снимка не подменены');
  assert.equal(await count(ctx.db, 'analysis_signals', ctx.newRunId), 2);
  assert.equal(await workflowStatus(ctx.db, ctx.stage), 'reviewing');
});

// --- 5. Production-путь: движок публикует стадию через publishStageResult ------------

const engineCount = async (db, table, runId) => Number((await db.queryOne(
  `SELECT COUNT(*) AS c FROM ${table} WHERE tender_id = ? AND analysis_run_id = ?`,
  ENGINE_TENDER_ID, runId,
)).c);

test('production-путь: успешный runStageInner публикует снимок атомарно (полный цикл)', OPTS, async (t) => {
  const db = getDb();
  await wipeTender(db, ENGINE_TENDER_ID);
  await engine.getStageState(ENGINE_TENDER_ID); // строка tender_stage_state (stage1='open')

  // Fake LLM: находка стадии 1 с цитатой из ТЗ (иначе не локализуется).
  installFakeLlm(t, () => ({
    findings: [{
      fragment: 'МАРКЕР-УБОРКА',
      problem_type: 'не_учтено_в_вор',
      criticality: 'medium',
      basis: 'работа описана в ТЗ, но не найдена в ведомости',
      review_comment: 'Проверить объём по уборке',
      suggested_action: 'clarify',
      confidence: 0.7,
    }],
  }));

  // Прогон №1 — станет «старым активным» для прогона №2.
  const first = await engine.runStageInner(ENGINE_TENDER_ID, 1);
  assert.equal((await analysisRuns.getRun(first.runId)).status, 'completed');
  assert.equal(await analysisRuns.getActiveStageRunId(ENGINE_TENDER_ID, 1), first.runId);
  assert.equal((await analysisRuns.getRun(first.runId)).superseded_at, null,
    'единственный опубликованный прогон не архивирован');
  const firstIssues = await engineCount(db, 'issues', first.runId);
  assert.ok(firstIssues > 0, 'движок сохранил находки первого прогона');
  assert.equal(await engineCount(db, 'analysis_signals', first.runId), firstIssues);

  // Прогон №2 (стадия в 'reviewing' — повторный запуск законен).
  const second = await engine.runStageInner(ENGINE_TENDER_ID, 1);
  assert.notEqual(second.runId, first.runId);

  // Один новый completed run; он и есть active pointer.
  const runs = await db.queryAll(
    `SELECT id, status, superseded_at FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage = 1 ORDER BY started_at ASC, id ASC`,
    ENGINE_TENDER_ID,
  );
  assert.equal(runs.length, 2, 'два запуска — ровно два прогона, фиктивных строк нет');
  assert.equal((await analysisRuns.getRun(second.runId)).status, 'completed');
  assert.equal(await analysisRuns.getActiveStageRunId(ENGINE_TENDER_ID, 1), second.runId);

  // Issues и signals принадлежат новому прогону; связка сигнал → находка цела.
  const secondIssues = await engineCount(db, 'issues', second.runId);
  assert.ok(secondIssues > 0);
  assert.equal(await engineCount(db, 'analysis_signals', second.runId), secondIssues);
  const orphanSignals = await db.queryAll(
    `SELECT s.id FROM analysis_signals s
      WHERE s.tender_id = ? AND s.analysis_run_id = ?
        AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = s.source_entity_id AND i.analysis_run_id = s.analysis_run_id)`,
    ENGINE_TENDER_ID, second.runId,
  );
  assert.deepEqual(orphanSignals, [], 'каждый сигнал ссылается на находку своего прогона');

  // Стадия — reviewing; статус переведён публикацией (отчёт лежит в результате).
  assert.equal((await engine.getStageState(ENGINE_TENDER_ID)).stage1_status, 'reviewing');
  assert.equal(second.publication.activated, true);
  assert.equal(second.publication.workflow.to, 'reviewing');

  // Старый прогон архивирован ТОЛЬКО после успешного коммита нового; его данные целы.
  const firstRow = await analysisRuns.getRun(first.runId);
  assert.ok(firstRow.superseded_at, 'прежний активный прогон получил superseded_at');
  assert.equal(firstRow.status, 'completed');
  assert.equal(await engineCount(db, 'issues', first.runId), firstIssues, 'история первого прогона не удалена');
  assert.equal(await engineCount(db, 'analysis_signals', first.runId), firstIssues);

  // Части ТЗ обоих прогонов финализированы — живых статусов нет.
  for (const runId of [first.runId, second.runId]) {
    // eslint-disable-next-line no-await-in-loop
    const segs = await segmentStore.listRunSegments(ENGINE_TENDER_ID, 1, runId);
    assert.ok(segs.length > 0, 'у прогона есть история частей');
    assert.ok(segs.every((s) => !['pending', 'running'].includes(s.status)),
      'у опубликованного прогона не остаётся живых частей');
  }
});

