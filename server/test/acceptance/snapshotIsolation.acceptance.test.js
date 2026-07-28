'use strict';

// ПРИЁМОЧНЫЙ тест изоляции результатов: тот же портал целиком (HTTP-API +
// очередь + воркеры + живой PostgreSQL), модель — стаб, сети нет.
//
// Сценарии этого файла:
//   1. ПОВТОРНЫЙ ЗАПУСК не смешивает результаты: новый прогон — новый снимок,
//      счётчики не складываются, решения прошлого прогона не приклеиваются к
//      новым находкам, история прошлого прогона остаётся в БД.
//   2. ДВА ВОРКЕРА не создают дублей: одна стадия одной ревизии считается ровно
//      один раз, сколько бы воркеров ни разбирало очередь и сколько бы раз
//      инженер ни нажал «Запустить».
//   3. НОВАЯ РЕВИЗИЯ ТЗ не получает исключения прошлой: удалённый в прошлой
//      версии фрагмент снова попадает в анализ, а старые исключения помечаются
//      требующими подтверждения.
//
//   npm run test:acceptance      — без TEST_DATABASE_URL тесты SKIP
//   npm run test:acceptance:ci   — без TEST_DATABASE_URL тесты ПАДАЮТ

const H = require('./harness'); // ПЕРВЫМ: настраивает окружение до серверных модулей

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const OPTS = H.OPTS;
const PREFIX = `acc_snap_${process.pid}`;
const created = [];

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
});

after(async () => {
  if (OPTS.skip) return;
  const db = H.getDb();
  for (const id of created) await H.dropTender(db, id);
  try { await H.closeDb(); } catch { /* пул мог не открыться */ }
  H.removeUploads();
});

async function newTender(call, title) {
  const id = await H.createTender(call, `${PREFIX} — ${title}`);
  created.push(id);
  return id;
}

// --- 1. Повторный запуск не смешивает результаты ---------------------------------

test('повторный запуск стадии не смешивает результаты: новый снимок, старые решения не приклеиваются', OPTS, async (t) => {
  const db = H.getDb();
  const { call } = await H.startApi(t);
  await H.startWorker(t);
  const llm = H.scriptedLlm(t);
  llm.respond((c) => H.findingFor(c));

  const tenderId = await newTender(call, 'повтор');
  await H.uploadDocument(call, tenderId, { name: 'ТЗ.md', text: H.buildTzMarkdown() });

  // --- прогон №1
  const first = await H.runStageAndWait(call, tenderId, 1);
  assert.equal(first.outcome.status, 'completed');
  const issuesAfterFirst = (await call(`/api/tenders/${tenderId}/stages/1/issues`)).body.items;
  const countFirst = issuesAfterFirst.length;
  assert.ok(countFirst > 0, 'первый прогон обязан что-то найти');
  const runIdFirst = issuesAfterFirst[0].analysis_run_id;

  // Инженер решил вопрос по одной находке прошлого прогона.
  const decided = issuesAfterFirst[0];
  const decision = await call(`/api/issues/${decided.id}/decision`, {
    method: 'POST', body: { decision: 'accept', final_comment: 'Решение прошлого прогона' },
  });
  assert.equal(decision.status, 200);

  // --- прогон №2 (тот же ТЗ, повтор «на всякий случай»)
  const second = await H.runStageAndWait(call, tenderId, 1);
  assert.equal(second.outcome.status, 'completed');
  const issuesAfterSecond = (await call(`/api/tenders/${tenderId}/stages/1/issues`)).body.items;
  const runIdSecond = issuesAfterSecond[0].analysis_run_id;

  assert.notEqual(runIdSecond, runIdFirst, 'повтор обязан завести НОВЫЙ прогон (снимок), а не дописать прежний');
  assert.equal(
    issuesAfterSecond.length, countFirst,
    'счётчик находок не складывает старый и новый прогоны',
  );
  assert.ok(
    issuesAfterSecond.every((i) => i.analysis_run_id === runIdSecond),
    'в активном снимке нет находок из прошлого прогона',
  );
  assert.ok(
    issuesAfterSecond.every((i) => i.review_status === 'pending' && !i.decision_kind),
    'решение прошлого прогона НЕ приклеивается к находкам нового автоматически',
  );

  // История прошлого прогона осталась в БД целиком — повтор её не удаляет.
  const total = await db.queryOne('SELECT COUNT(*) AS c FROM issues WHERE tender_id = ?', tenderId);
  assert.equal(Number(total.c), countFirst * 2, 'находки прошлого прогона остаются в истории');
  const oldDecision = await db.queryOne('SELECT decision FROM review_decisions WHERE issue_id = ?', decided.id);
  assert.equal(oldDecision.decision, 'accept', 'решение прошлого прогона тоже сохранено (в своём снимке)');

  const runs = await db.queryAll(
    `SELECT id, status, superseded_at FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage = 1 ORDER BY started_at ASC`, tenderId,
  );
  assert.equal(runs.length, 2, 'два запуска — два прогона');
  assert.ok(runs[0].superseded_at, 'прежний прогон архивируется, а не удаляется');
  assert.equal(runs[1].superseded_at, null);

  // Счётчик тендера в списке портала тоже считает только актуальный снимок.
  const tender = await call(`/api/tenders/${tenderId}`);
  assert.equal(Number(tender.body.counts.issues_total), countFirst, 'карточка тендера не удваивает находки после повтора');

  // Перенос решений между прогонами существует, но он ЯВНЫЙ.
  const carry = await call(`/api/tenders/${tenderId}/review/carryovers`);
  assert.equal(carry.status, 200, 'перенос решений предлагается отдельным действием, а не происходит сам');
});

// --- 2. Два воркера не создают дублей --------------------------------------------

test('два воркера и два нажатия «Запустить» не создают дублей', OPTS, async (t) => {
  const db = H.getDb();
  const { call } = await H.startApi(t);
  // ДВА воркера в очереди — как два процесса в бою (координация целиком в БД).
  await H.startWorker(t, { id: `acc-w1-${process.pid}` });
  await H.startWorker(t, { id: `acc-w2-${process.pid}` });
  const llm = H.scriptedLlm(t);
  llm.respond((c) => H.findingFor(c));

  const tenderId = await newTender(call, 'два воркера');
  await H.uploadDocument(call, tenderId, { name: 'ТЗ.md', text: H.buildTzMarkdown() });

  // Инженер нажал «Запустить» дважды подряд (одновременно).
  const [a, b] = await Promise.all([
    call(`/api/tenders/${tenderId}/stages/1/run`, { method: 'POST' }),
    call(`/api/tenders/${tenderId}/stages/1/run`, { method: 'POST' }),
  ]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.body.job_id, b.body.job_id, 'второй запуск обязан попасть в ТО ЖЕ задание, а не завести второе');

  await H.waitFor(async () => {
    const s = await H.getStages(call, tenderId);
    return s.state.stage1_status !== 'running' ? s : null;
  }, { what: 'исход стадии 1', timeoutMs: 90_000 });

  const stages = await H.getStages(call, tenderId);
  assert.equal(stages.state.stage1_status, 'reviewing', 'стадия обязана успешно досчитаться');

  // Задание закрывается сразу после задачи, но чуть позже статуса стадии.
  const jobs = await H.waitFor(async () => {
    const rows = await db.queryAll(
      `SELECT id, status FROM analysis_jobs WHERE tender_id = ? AND scope_key = 'stage:1'`, tenderId,
    );
    return rows.length && rows.every((j) => j.status !== 'queued' && j.status !== 'running') ? rows : null;
  }, { what: 'терминальный статус задания стадии 1' });
  assert.equal(jobs.length, 1, 'два нажатия — одно задание в очереди');
  assert.equal(jobs[0].status, 'completed');

  const runs = await db.queryAll(
    `SELECT id FROM analysis_runs WHERE tender_id = ? AND kind = 'stage' AND stage = 1`, tenderId,
  );
  assert.equal(runs.length, 1, 'одно задание — один прогон, сколько бы воркеров его ни разбирало');

  // Части ТЗ: ровно одна строка истории на часть, и каждая посчитана РОВНО раз.
  const segments = await call(`/api/tenders/${tenderId}/stages/1/segments`);
  assert.equal(segments.status, 200);
  const items = segments.body.items;
  assert.ok(items.length > 1, 'ТЗ должно резаться на несколько частей — иначе гонка воркеров не проверяется');
  const indexes = items.map((s) => s.segment_index);
  assert.equal(new Set(indexes).size, indexes.length, 'дублей частей в истории прогона быть не может');
  assert.ok(items.every((s) => s.status === 'completed'));
  assert.equal(
    llm.callCount, items.length,
    'модель вызвана РОВНО по числу частей: второй воркер работу не переделывал',
  );

  const issues = (await call(`/api/tenders/${tenderId}/stages/1/issues`)).body.items;
  assert.equal(issues.length, items.length, 'находки не удвоились: по одной на часть ТЗ');
  const fragments = issues.map((i) => i.source_fragment);
  assert.equal(new Set(fragments).size, fragments.length, 'одна и та же находка не записана дважды');
});

// --- 3. Новая ревизия ТЗ не получает старые исключения ----------------------------

test('новая ревизия ТЗ не наследует исключения прошлой', OPTS, async (t) => {
  const db = H.getDb();
  const { call } = await H.startApi(t);
  await H.startWorker(t);
  const llm = H.scriptedLlm(t);
  llm.respond((c) => H.findingFor(c));

  const tenderId = await newTender(call, 'новая ревизия');
  await H.uploadDocument(call, tenderId, { name: 'ТЗ.md', text: H.buildTzMarkdown() });
  await H.seedQaEntries(db, tenderId);

  // Стадия 1: находки по маркерам.
  const first = await H.runStageAndWait(call, tenderId, 1);
  assert.equal(first.outcome.status, 'completed');
  const issues = (await call(`/api/tenders/${tenderId}/stages/1/issues`)).body.items;
  const target = issues[0];
  const removedFragment = target.source_fragment;
  assert.ok(removedFragment, 'нужна находка с дословной цитатой — по ней считается исключение');

  // Инженер удаляет фрагмент из объёма и завершает стадию: фрагмент выходит из
  // активного текста для следующих стадий (tz_excluded_ranges этой ревизии).
  const decision = await call(`/api/issues/${target.id}/decision`, {
    method: 'POST', body: { decision: 'delete', final_comment: 'Работа вне объёма ГП' },
  });
  assert.equal(decision.status, 200);
  assert.equal((await H.finishStage(call, tenderId, 1)).status, 200);

  const exclusions = await db.queryAll('SELECT * FROM tz_excluded_ranges WHERE tender_id = ?', tenderId);
  assert.equal(exclusions.length, 1, 'решение delete обязано дать ровно одно исключение');
  const revisionA = exclusions[0].document_revision_id;
  assert.ok(revisionA, 'исключение обязано быть привязано к ревизии ТЗ');
  assert.equal(Number(exclusions[0].stale), 0);

  // Стадия 2 на той же ревизии: удалённый фрагмент в модель НЕ уходит.
  llm.reset();
  llm.respond(() => H.NO_FINDINGS);
  const stage2 = await H.runStageAndWait(call, tenderId, 2);
  assert.equal(stage2.outcome.status, 'completed');
  assert.ok(llm.callCount > 0, 'стадия 2 обязана была обратиться к модели');
  assert.ok(
    !llm.seen.includes(removedFragment),
    'исключение применено: удалённый фрагмент не попадает в анализ следующей стадии',
  );

  // --- НОВАЯ ВЕРСИЯ ТЗ -----------------------------------------------------------
  // Загружается вторая .md-копия (та же структура + новый раздел): это другая
  // ревизия, координаты прошлых исключений к ней не относятся.
  await H.uploadDocument(call, tenderId, {
    name: 'ТЗ.md',
    text: `${H.buildTzMarkdown()}\n\n# 7. Раздел 7. Дополнительные требования\n\n7.1 Новый пункт версии 2. ${'Требования уточнены заказчиком. '.repeat(4)}`,
  });

  // Пометка исключений идёт следом за извлечением текста новой версии.
  const afterUpload = await H.waitFor(async () => {
    const rows = await db.queryAll('SELECT * FROM tz_excluded_ranges WHERE tender_id = ?', tenderId);
    return rows.length && Number(rows[0].stale) === 1 ? rows : null;
  }, { what: 'пометка исключений прошлой ревизии' });
  assert.equal(afterUpload.length, 1, 'исключения прошлой ревизии не удаляются — они помечаются');
  assert.equal(Number(afterUpload[0].stale), 1, 'исключение прошлой ревизии обязано стать stale');
  assert.equal(Number(afterUpload[0].needs_confirmation), 1, 'перенос исключения требует подтверждения инженером');
  assert.equal(afterUpload[0].document_revision_id, revisionA, 'исключение осталось привязано к своей ревизии');

  // Стадия 2 на НОВОЙ ревизии: ранее удалённый фрагмент снова в анализе.
  llm.reset();
  const stage2again = await H.runStageAndWait(call, tenderId, 2);
  assert.equal(stage2again.outcome.status, 'completed');
  assert.ok(llm.callCount > 0, 'новая ревизия обязана считаться заново, а не подниматься из кэша прошлой');
  assert.ok(
    llm.seen.includes(removedFragment),
    'исключение прошлой ревизии НЕ применяется к новой версии ТЗ — фрагмент снова анализируется',
  );
  assert.ok(llm.seen.includes('Новый пункт версии 2'), 'новая версия ТЗ действительно попала в анализ');
});
