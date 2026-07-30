'use strict';

// Юнит-тесты сервиса публикации результата стадии — без БД: вся работа идёт через
// подставную транзакцию, поэтому проверяется именно контракт publishStageResult:
//   • порядок шагов (право на запись → issues → signals → части ТЗ → активация);
//   • сигналы обязательны для стадий 1–4 и отсутствуют по определению у стадии 5;
//   • сбой любого шага останавливает публикацию — активации не происходит;
//   • activateRun идёт ТОЙ ЖЕ транзакцией, её ошибка не подавляется;
//   • сервис не коммитит транзакцию и НЕ трогает workflow-статус стадии.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const publish = require('../../services/stageAnalysis/publishStageResult');
const analysisRuns = require('../../services/analysisRuns/analysisRunsService');
const stageState = require('../../services/stageAnalysis/stageState');

const { publishStageResult, assertActivatable } = publish;

const TENDER = 'tender-1';
const RUN = 'run-42';

function runRow(over = {}) {
  return {
    id: RUN, tender_id: TENDER, kind: 'stage', stage: 1, status: 'running', superseded_at: null, ...over,
  };
}

// Подставная транзакция: журнал запросов, счётчики записанных строк (COUNT(*)
// отвечает по фактически выполненным INSERT — как настоящая БД в этой же
// транзакции), управляемый сбой и управляемый rowCount. commit/rollback
// намеренно бросают: транзакцией владеет вызывающий.
function fakeTx({
  run = runRow(),
  failOn = null,
  previousRunId = null,
  zeroRowsOn = null,
  countOverride = {},
  // Статус стадии в tender_stage_state: условный UPDATE попадёт в строку, только
  // если ожидаемый предыдущий статус совпал.
  workflowStatus = 'running',
  // Чем становится строка прогона ПОСЛЕ активации (по умолчанию — completed).
  runAfterActivation = null,
} = {}) {
  const calls = [];
  let activated = false;
  const maybeFail = (sql) => {
    if (failOn && sql.includes(failOn)) throw new Error(`сбой на «${failOn}»`);
  };
  const written = (re) => calls.filter((c) => c.op === 'queryRun' && re.test(c.sql)).length;
  const tx = {
    calls,
    sql: () => calls.map((c) => c.sql),
    // Компактная метка шага — по ней сверяем порядок.
    steps: () => calls.map((c) => {
      if (/FOR UPDATE/.test(c.sql)) return 'lock-run';
      if (/SELECT stage FROM analysis_runs/.test(c.sql)) return 'read-run-stage';
      if (/SELECT id, tender_id, stage, status, superseded_at FROM analysis_runs/.test(c.sql)) return 'verify-run';
      if (/COUNT\(\*\) AS c FROM issues/.test(c.sql)) return 'count-issues';
      if (/COUNT\(\*\) AS c FROM analysis_signals/.test(c.sql)) return 'count-signals';
      if (/SELECT analysis_run_id FROM analysis_active_runs/.test(c.sql)) return 'read-pointer';
      if (/UPDATE analysis_runs SET superseded_at/.test(c.sql)) return 'supersede-previous';
      if (/SET status = 'completed'/.test(c.sql)) return 'complete-run';
      if (/INSERT INTO analysis_active_runs/.test(c.sql)) return 'move-pointer';
      if (/DELETE FROM issues/.test(c.sql)) return 'clear-issues';
      if (/INSERT INTO issues/.test(c.sql)) return 'insert-issue';
      if (/DELETE FROM analysis_signals/.test(c.sql)) return 'clear-signals';
      if (/INSERT INTO analysis_signals/.test(c.sql)) return 'insert-signal';
      if (/UPDATE analysis_run_segments/.test(c.sql)) return 'finalize-segment';
      if (/UPDATE tender_stage_state/.test(c.sql)) return 'set-reviewing';
      return `other:${c.sql.slice(0, 40)}`;
    }),
    async queryOne(sql, ...params) {
      calls.push({ op: 'queryOne', sql, params });
      maybeFail(sql);
      if (/COUNT\(\*\) AS c FROM issues/.test(sql)) {
        return { c: countOverride.issues ?? written(/INSERT INTO issues/) };
      }
      if (/COUNT\(\*\) AS c FROM analysis_signals/.test(sql)) {
        return { c: countOverride.signals ?? written(/INSERT INTO analysis_signals/) };
      }
      if (/FROM analysis_active_runs/.test(sql)) return previousRunId ? { analysis_run_id: previousRunId } : null;
      if (/FROM analysis_runs/.test(sql)) {
        if (!activated) return run;
        return { ...run, status: 'completed', ...(runAfterActivation || {}) };
      }
      return null;
    },
    async queryAll(sql, ...params) {
      calls.push({ op: 'queryAll', sql, params });
      maybeFail(sql);
      return [];
    },
    async queryRun(sql, ...params) {
      calls.push({ op: 'queryRun', sql, params });
      maybeFail(sql);
      const zeroed = zeroRowsOn && sql.includes(zeroRowsOn);
      // Условный UPDATE статуса стадии: строка обновится, только если ожидаемый
      // предыдущий статус (последний параметр) совпал с текущим.
      if (/UPDATE tender_stage_state/.test(sql)) {
        return { rowCount: !zeroed && params[params.length - 1] === workflowStatus ? 1 : 0 };
      }
      if (zeroed) return { rowCount: 0 };
      // Активация состоялась — дальнейшие чтения строки прогона видят completed.
      if (/SET status = 'completed'/.test(sql)) activated = true;
      return { rowCount: 1 };
    },
    commit: () => { throw new Error('сервис не должен коммитить транзакцию'); },
    rollback: () => { throw new Error('сервис не должен откатывать транзакцию'); },
  };
  return tx;
}

function issue(over = {}) {
  return {
    problem_type: 'не_учтено_в_кп',
    criticality: 'high',
    basis: 'Работа не отражена в ведомости объёмов',
    source_fragment: 'Подрядчик обеспечивает ежедневную уборку территории',
    section_path: 'п. 4.1',
    confidence: 0.8,
    ...over,
  };
}

const signalRecord = (issueId) => ({ issueId, issue: issue() });

// Подмена activateRun на время одного теста: перехватываем аргументы (в т.ч. tx)
// или подставляем сбой. Восстанавливается всегда.
async function withActivateSpy(impl, fn) {
  const original = analysisRuns.activateRun;
  const seen = { calls: [] };
  analysisRuns.activateRun = (...args) => {
    seen.calls.push(args);
    return impl ? impl(...args) : original(...args);
  };
  try {
    return { seen, result: await fn(), error: null };
  } catch (error) {
    return { seen, result: null, error };
  } finally {
    analysisRuns.activateRun = original;
  }
}

// --- Порядок шагов ---------------------------------------------------------------

test('порядок: право на запись → issues → signals → части ТЗ → активация → reviewing', async () => {
  const tx = fakeTx();
  const report = await publishStageResult({
    tx,
    tenderId: TENDER,
    stage: 1,
    analysisRunId: RUN,
    issues: [issue(), issue({ criticality: 'medium' })],
    signals: [signalRecord('i1'), signalRecord('i2')],
    targetWorkflowStatus: 'reviewing',
  });

  assert.deepEqual(tx.steps(), [
    'lock-run',
    'read-run-stage',
    'clear-issues',
    'insert-issue',
    'insert-issue',
    'clear-signals',
    'insert-signal',
    'insert-signal',
    'finalize-segment', // running → interrupted
    'finalize-segment', // pending → skipped
    'verify-run',       // проверки перед активацией
    'count-issues',
    'count-signals',
    'read-pointer',     // activateRun
    'complete-run',
    'move-pointer',
    'verify-run',       // проверки перед переводом статуса стадии
    'set-reviewing',    // ПОСЛЕДНИЙ шаг
  ]);
  assert.equal(report.issues_written, 2);
  assert.equal(report.signals.written, 2);
  assert.equal(report.activated, true);
  assert.equal(report.pointer_moved, true);
  assert.deepEqual(report.verified, { issues: 2, signals: 2, signals_required: true });
  assert.equal(report.activation.run_updated, 1);
  assert.equal(report.activation.pointer_updated, 1);
  assert.deepEqual(report.workflow, {
    tender_id: TENDER, stage: 1, from: 'running', to: 'reviewing', changed: 1,
  });
  assert.equal(report.workflow_status_applied, true);
  assert.equal(report.committed, false);
});

// --- Статус стадии: reviewing строго после активации -------------------------------

test('reviewing выставляется ПОСЛЕ activateRun и ровно один раз', async () => {
  const tx = fakeTx();
  await publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  });

  const steps = tx.steps();
  assert.equal(steps.filter((s) => s === 'set-reviewing').length, 1);
  assert.ok(steps.indexOf('set-reviewing') > steps.indexOf('move-pointer'));
  assert.ok(steps.indexOf('set-reviewing') > steps.indexOf('complete-run'));
  assert.equal(steps[steps.length - 1], 'set-reviewing');

  // Обновляется именно нужный тендер, нужная стадия и только из 'running'.
  const upd = tx.calls.find((c) => /UPDATE tender_stage_state/.test(c.sql));
  assert.match(upd.sql, /stage1_status = \?/);
  assert.match(upd.sql, /WHERE tender_id = \? AND stage1_status = \?/);
  assert.deepEqual(upd.params, ['reviewing', 1, TENDER, 'running']);
});

test('перевод статуса идёт той же транзакцией, что и вся публикация', async () => {
  const tx = fakeTx();
  const original = stageState.transitionStageStatus;
  const seen = [];
  stageState.transitionStageStatus = (tenderId, stage, opts) => {
    seen.push({ tenderId, stage, opts });
    return original(tenderId, stage, opts);
  };
  try {
    await publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    });
  } finally {
    stageState.transitionStageStatus = original;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tenderId, TENDER);
  assert.equal(seen[0].stage, 1);
  assert.equal(seen[0].opts.tx, tx, 'workflow-update обязан идти транзакцией вызывающего');
  assert.equal(seen[0].opts.from, 'running');
  assert.equal(seen[0].opts.to, 'reviewing');
});

test('стадия 5 тоже переводится в reviewing (пустой challenger-снимок, 0 сигналов)', async () => {
  const tx = fakeTx({ run: runRow({ stage: 5 }) });
  const report = await publishStageResult({
    tx, tenderId: TENDER, stage: 5, analysisRunId: RUN, issues: [], signals: [],
  });
  assert.equal(report.workflow.stage, 5);
  assert.equal(report.workflow.to, 'reviewing');
  assert.match(tx.calls.find((c) => /UPDATE tender_stage_state/.test(c.sql)).sql, /stage5_status/);
});

test('активация переводит указатель именно этой стадии и архивирует прежний прогон', async () => {
  const tx = fakeTx({ previousRunId: 'run-старый' });
  const report = await publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  });

  const pointerRead = tx.calls.find((c) => /FROM analysis_active_runs/.test(c.sql));
  assert.deepEqual(pointerRead.params, [TENDER, analysisRuns.stageScope(1)]);
  assert.equal(analysisRuns.stageScope(1), 'stage:1');
  assert.ok(tx.steps().includes('supersede-previous'));
  assert.equal(report.activation.previous_run_id, 'run-старый');
  assert.equal(report.activation.previous_superseded, 1);

  const upsert = tx.calls.find((c) => /INSERT INTO analysis_active_runs/.test(c.sql));
  assert.equal(upsert.params[0], TENDER);
  assert.equal(upsert.params[1], 'stage:1');
  assert.equal(upsert.params[4], RUN);
});

test('activateRun получает ту же транзакцию, что передана в publishStageResult', async () => {
  const tx = fakeTx();
  const { seen, result, error } = await withActivateSpy(null, () => publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  }));

  assert.equal(error, null);
  assert.equal(seen.calls.length, 1);
  const [tenderArg, scopeArg, runArg, , txArg] = seen.calls[0];
  assert.equal(tenderArg, TENDER);
  assert.equal(scopeArg, 'stage:1');
  assert.equal(runArg, RUN);
  assert.equal(txArg, tx, 'activateRun обязана работать в транзакции вызывающего');
  assert.equal(result.activated, true);
});

test('issues и signals пишутся с analysis_run_id публикуемого прогона', async () => {
  const tx = fakeTx();
  await publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  });

  const insertIssue = tx.calls.find((c) => /INSERT INTO issues/.test(c.sql));
  assert.equal(insertIssue.params[1], TENDER);
  assert.equal(insertIssue.params[2], RUN);
  assert.equal(insertIssue.params[3], 1); // analysis_stage

  const insertSignal = tx.calls.find((c) => /INSERT INTO analysis_signals/.test(c.sql));
  assert.equal(insertSignal.params[2], RUN);
});

test('signals-функция получает записи уже сохранённых issues (id известны только после записи)', async () => {
  const tx = fakeTx({ run: runRow({ stage: 2 }) });
  let seen = null;
  const report = await publishStageResult({
    tx,
    tenderId: TENDER,
    stage: 2,
    analysisRunId: RUN,
    issues: [issue()],
    signals: (records) => {
      seen = records;
      return records.map((r) => ({ issueId: r.issueId, issue: r.issue }));
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].issueId, 'string');
  assert.equal(report.signals.written, 1);
  assert.equal(report.activated, true);
});

// --- Сигналы: обязательность по стадиям --------------------------------------------

test('стадии 1–4: signals не переданы — ни записи, ни активации', async () => {
  for (const stage of [1, 2, 3, 4]) {
    const tx = fakeTx({ run: runRow({ stage }) });
    // eslint-disable-next-line no-await-in-loop
    const { seen, error } = await withActivateSpy(null, () => publishStageResult({
      tx, tenderId: TENDER, stage, analysisRunId: RUN, issues: [issue()],
    }));
    assert.equal(error.code, 'PUBLISH_SIGNALS_REQUIRED', `стадия ${stage} обязана требовать сигналы`);
    assert.equal(seen.calls.length, 0);
    assert.ok(!tx.steps().includes('clear-signals'));
    assert.ok(!tx.steps().includes('finalize-segment'));
    assert.ok(!tx.steps().includes('move-pointer'));
  }
});

test('стадии 1–4: находки есть, а сигналов ноль — публикация и активация запрещены', async () => {
  const tx = fakeTx();
  const { seen, error } = await withActivateSpy(null, () => publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [],
  }));
  assert.equal(error.code, 'PUBLISH_SIGNALS_REQUIRED');
  assert.equal(seen.calls.length, 0);
  assert.ok(!tx.steps().includes('move-pointer'));
});

test('страж активации: стадия 1–4 с находками, но без сигналов в БД — активация отменяется', async () => {
  // Прямая проверка стража (через публичный путь сюда не дойти: запись сигналов
  // обязательна раньше). issueRecords есть, в БД сигналов нет.
  const tx = fakeTx({ countOverride: { issues: 1, signals: 0 } });
  await assert.rejects(
    () => assertActivatable(tx, {
      tenderId: TENDER,
      stage: 1,
      analysisRunId: RUN,
      issueRecords: [{ issueId: 'i1', issue: issue() }],
      signalsReport: { written: 0 },
    }),
    (err) => err.code === 'ACTIVATE_SIGNALS_REQUIRED',
  );
});

test('страж активации: расхождение записанного и лежащего в БД — активация отменяется', async () => {
  const tx = fakeTx({ countOverride: { issues: 0 } });
  await assert.rejects(
    () => assertActivatable(tx, {
      tenderId: TENDER,
      stage: 1,
      analysisRunId: RUN,
      issueRecords: [{ issueId: 'i1', issue: issue() }],
      signalsReport: { written: 1 },
    }),
    (err) => err.code === 'ACTIVATE_ISSUES_NOT_PERSISTED',
  );
});

test('стадии 1–4: находок нет — пустой массив сигналов допустим, снимок активируется', async () => {
  const tx = fakeTx();
  const report = await publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [], signals: [],
  });
  assert.equal(report.issues_written, 0);
  assert.equal(report.signals.written, 0);
  assert.equal(report.activated, true);
  assert.ok(tx.steps().includes('move-pointer'));
});

test('стадия 5: сигналы теперь ОБЯЗАТЕЛЬНЫ как у добытчиков — challenger-находки не теряются', async () => {
  // Пустой снимок (0 находок) публикуется с пустым массивом сигналов…
  const tx = fakeTx({ run: runRow({ stage: 5 }) });
  const report = await publishStageResult({
    tx, tenderId: TENDER, stage: 5, analysisRunId: RUN, issues: [], signals: [],
  });
  assert.equal(report.signals.written, 0);
  assert.equal(report.verified.signals_required, true);
  assert.equal(report.activated, true);
  assert.equal(tx.calls.find((c) => /INSERT INTO analysis_active_runs/.test(c.sql)).params[1], 'stage:5');

  // …а вовсе БЕЗ сигналов (null) публикация отклоняется, как у стадий 1–4:
  // снимок с находками, но без сигналов был бы невидим конвейеру.
  const tx2 = fakeTx({ run: runRow({ stage: 5 }) });
  await assert.rejects(
    () => publishStageResult({
      tx: tx2, tenderId: TENDER, stage: 5, analysisRunId: RUN, issues: [], signals: null,
    }),
    /сигналы обязательны/,
  );
});

// --- Сбой шага останавливает публикацию (активации не происходит) ------------------

test('прогон не в работе: ни записи, ни активации', async () => {
  const tx = fakeTx({ run: runRow({ status: 'completed' }) });
  const { seen, error } = await withActivateSpy(null, () => publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  }));
  assert.match(error.message, /снимок уже завершён|не в работе/);
  assert.equal(seen.calls.length, 0);
  assert.ok(!tx.steps().some((s) => s.startsWith('insert')));
});

test('архивированный прогон: публикация отклоняется до записи', async () => {
  const tx = fakeTx({ run: runRow({ superseded_at: '2026-07-28T10:00:00.000Z' }) });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [], signals: [],
    }),
    /superseded|архивирован/,
  );
  assert.deepEqual(tx.steps(), ['lock-run']);
});

test('прогон чужой стадии: публикация отклоняется', async () => {
  const tx = fakeTx({ run: runRow({ stage: 3 }) });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [], signals: [],
    }),
    (err) => err.code === 'PUBLISH_RUN_STAGE_MISMATCH',
  );
});

test('сбой на любом шаге до активации: activateRun не вызывается вовсе', async () => {
  const steps = ['INSERT INTO issues', 'INSERT INTO analysis_signals', 'UPDATE analysis_run_segments'];
  for (const failOn of steps) {
    const tx = fakeTx({ failOn });
    // eslint-disable-next-line no-await-in-loop
    const { seen, error } = await withActivateSpy(null, () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }));
    assert.match(error.message, /сбой на/, `ожидался сбой на «${failOn}»`);
    assert.equal(seen.calls.length, 0, `после сбоя на «${failOn}» активации быть не должно`);
    assert.ok(!tx.steps().includes('move-pointer'));
  }
});

test('прогон перехвачен другим прогоном во время публикации: активация отменяется', async () => {
  // Строка прогона к моменту проверки перед активацией уже архивирована.
  let reads = 0;
  const tx = fakeTx();
  const originalQueryOne = tx.queryOne;
  tx.queryOne = async (sql, ...params) => {
    const row = await originalQueryOne(sql, ...params);
    if (/SELECT id, tender_id, stage, status, superseded_at FROM analysis_runs/.test(sql)) {
      reads += 1;
      return { ...row, superseded_at: '2026-07-28T11:00:00.000Z' };
    }
    return row;
  };
  const { seen, error } = await withActivateSpy(null, () => publishStageResult({
    tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
  }));
  assert.equal(reads, 1);
  assert.equal(error.code, 'ACTIVATE_RUN_SUPERSEDED');
  assert.equal(seen.calls.length, 0);
});

// --- Ошибка активации уходит наверх ------------------------------------------------

test('activateRun: строка прогона не обновилась — ошибка пробрасывается наружу', async () => {
  const tx = fakeTx({ zeroRowsOn: "SET status = 'completed'" });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
    (err) => err.code === 'RUN_ACTIVATION_RUN_NOT_UPDATED',
  );
});

test('activateRun: указатель не переведён — ошибка пробрасывается наружу', async () => {
  const tx = fakeTx({ zeroRowsOn: 'INSERT INTO analysis_active_runs' });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
    (err) => err.code === 'RUN_ACTIVATION_POINTER_NOT_MOVED',
  );
});

test('activateRun бросила — publishStageResult ничего не подавляет', async () => {
  const tx = fakeTx();
  const { error } = await withActivateSpy(
    () => { throw new Error('указатель заблокирован другим процессом'); },
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
  );
  assert.match(error.message, /указатель заблокирован другим процессом/);
});

// --- Сбои перевода статуса стадии -------------------------------------------------------

test('сбой activateRun: статус стадии не трогается вовсе', async () => {
  for (const zeroRowsOn of ["SET status = 'completed'", 'INSERT INTO analysis_active_runs']) {
    const tx = fakeTx({ zeroRowsOn });
    const original = stageState.transitionStageStatus;
    let called = 0;
    stageState.transitionStageStatus = (...args) => { called += 1; return original(...args); };
    try {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => publishStageResult({
          tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
        }),
        (err) => String(err.code).startsWith('RUN_ACTIVATION_'),
      );
    } finally {
      stageState.transitionStageStatus = original;
    }
    assert.equal(called, 0, `после сбоя «${zeroRowsOn}» статус стадии переводить нельзя`);
    assert.ok(!tx.steps().includes('set-reviewing'));
  }
});

test('нулевой rowCount перевода статуса — конфликт жизненного цикла, ошибка наверх', async () => {
  const tx = fakeTx({ zeroRowsOn: 'UPDATE tender_stage_state' });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
    (err) => err.code === 'STAGE_LIFECYCLE_CONFLICT',
  );
});

test('неожидаемый предыдущий статус стадии — перевод отклоняется', async () => {
  // Стадия уже не 'running' (например, её кто-то сбросил в 'open') — условный
  // UPDATE не найдёт строку, и это ошибка, а не «нечего менять».
  const tx = fakeTx({ workflowStatus: 'open' });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
    (err) => err.code === 'STAGE_LIFECYCLE_CONFLICT' && /ожидался статус «running»/.test(err.message),
  );
  // Попытка была — с правильным ожидаемым статусом в WHERE.
  assert.deepEqual(
    tx.calls.find((c) => /UPDATE tender_stage_state/.test(c.sql)).params,
    ['reviewing', 1, TENDER, 'running'],
  );
});

test('ошибка сервиса статусов пробрасывается наружу без подавления', async () => {
  const tx = fakeTx();
  const original = stageState.transitionStageStatus;
  stageState.transitionStageStatus = () => { throw new Error('строка состояния заблокирована'); };
  try {
    await assert.rejects(
      () => publishStageResult({
        tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
      }),
      /строка состояния заблокирована/,
    );
  } finally {
    stageState.transitionStageStatus = original;
  }
});

test('неуспешный исход прогона (failed / cancelled / interrupted) не даёт перевести стадию', async () => {
  for (const status of publish.RUN_STATUSES_BLOCKING_WORKFLOW) {
    const tx = fakeTx({ runAfterActivation: { status } });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => publishStageResult({
        tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
      }),
      (err) => err.code === 'WORKFLOW_RUN_NOT_PUBLISHED',
      `исход «${status}» не должен открывать стадию`,
    );
    assert.ok(!tx.steps().includes('set-reviewing'));
  }
});

test('прогон архивирован после активации — стадия не переводится', async () => {
  const tx = fakeTx({ runAfterActivation: { superseded_at: '2026-07-28T12:00:00.000Z' } });
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, issues: [issue()], signals: [signalRecord('i1')],
    }),
    (err) => err.code === 'WORKFLOW_RUN_SUPERSEDED',
  );
  assert.ok(!tx.steps().includes('set-reviewing'));
});

// --- Сервис статусов сам по себе ---------------------------------------------------------

test('transitionStageStatus: условный UPDATE, проверка rowCount, работа через tx', async () => {
  const tx = fakeTx();
  const res = await stageState.transitionStageStatus(TENDER, 3, { from: 'running', to: 'reviewing', tx });
  assert.deepEqual(res, { tender_id: TENDER, stage: 3, from: 'running', to: 'reviewing', changed: 1 });
  assert.match(tx.calls[0].sql, /stage3_status = \?/);

  await assert.rejects(
    () => stageState.transitionStageStatus(TENDER, 1, { from: 'running', to: 'опубликовано', tx }),
    (err) => err.code === 'STAGE_TRANSITION_INVALID',
  );
  await assert.rejects(
    () => stageState.transitionStageStatus(TENDER, 9, { from: 'running', to: 'reviewing', tx }),
    (err) => err.code === 'STAGE_TRANSITION_INVALID',
  );
});

// --- Границы ответственности -----------------------------------------------------------

test('сервис переводит стадию в reviewing, но транзакцию не коммитит', async () => {
  const tx = fakeTx();
  const report = await publishStageResult({
    tx,
    tenderId: TENDER,
    stage: 1,
    analysisRunId: RUN,
    issues: [issue()],
    signals: [signalRecord('i1')],
    targetWorkflowStatus: 'reviewing',
  });

  const sql = tx.sql().join(' | ');
  // commit/rollback у подставной транзакции бросают — сюда мы бы не дошли.
  assert.ok(!/COMMIT|BEGIN|ROLLBACK/i.test(sql), 'транзакцией управляет вызывающий');
  assert.equal(report.target_workflow_status, 'reviewing');
  assert.equal(report.workflow_status_applied, true);
  assert.equal(report.committed, false);
  assert.ok(/analysis_active_runs/.test(sql));
  assert.ok(/tender_stage_state/.test(sql));
  assert.equal(report.pointer_moved, true);
});

test('публикация переводит стадию только в reviewing — другой целевой статус отклоняется', async () => {
  const tx = fakeTx();
  await assert.rejects(
    () => publishStageResult({
      tx, tenderId: TENDER, stage: 1, analysisRunId: RUN, targetWorkflowStatus: 'finished',
    }),
    (err) => err.code === 'PUBLISH_WORKFLOW_STATUS_UNSUPPORTED',
  );
  assert.equal(tx.calls.length, 0);
});

test('вход проверяется до любых запросов: нет tx / нет прогона / чужая стадия', async () => {
  await assert.rejects(
    () => publishStageResult({ tenderId: TENDER, stage: 1, analysisRunId: RUN }),
    (err) => err.code === 'PUBLISH_TX_REQUIRED',
  );
  const tx1 = fakeTx();
  await assert.rejects(
    () => publishStageResult({ tx: tx1, tenderId: TENDER, stage: 1 }),
    (err) => err.code === 'PUBLISH_RUN_ID_REQUIRED',
  );
  assert.equal(tx1.calls.length, 0);
  const tx2 = fakeTx();
  await assert.rejects(
    () => publishStageResult({ tx: tx2, tenderId: TENDER, stage: 7, analysisRunId: RUN }),
    (err) => err.code === 'PUBLISH_STAGE_INVALID',
  );
  const tx3 = fakeTx();
  await assert.rejects(
    () => publishStageResult({
      tx: tx3, tenderId: TENDER, stage: 1, analysisRunId: RUN, targetWorkflowStatus: 'опубликовано',
    }),
    (err) => err.code === 'PUBLISH_WORKFLOW_STATUS_INVALID',
  );
  assert.equal(tx3.calls.length, 0);
});
