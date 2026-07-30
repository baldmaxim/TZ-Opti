'use strict';

// Юнит-тесты записи слоя signals — без БД: все запросы идут через ПОДСТАВНУЮ
// транзакцию, поэтому проверяется именно контракт writeSignalsForStage:
//   • переданная tx используется для всех запросов слоя (своей не открывается);
//   • strict=true не глушит SQL-ошибку и не возвращает ложный успех;
//   • strict=false сохраняет прежнее поведение, но помечает вызов в логе;
//   • каждая записываемая строка несёт analysis_run_id прогона-владельца.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { writeSignalsForStage } = require('../../services/signals/signalWriter');

const TENDER = 'tender-1';
const RUN = 'run-42';
const STAGE = 1;

// Подставная транзакция: пишет журнал запросов и умеет падать на заданном SQL.
function fakeTx({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    inserts: () => calls.filter((c) => /INSERT INTO analysis_signals/.test(c.sql)),
    deletes: () => calls.filter((c) => /DELETE FROM analysis_signals/.test(c.sql)),
    async queryRun(sql, ...params) {
      calls.push({ sql, params });
      if (failOn && sql.includes(failOn)) throw new Error('соединение с БД потеряно');
      return { rowCount: 1 };
    },
  };
}

// Запись стадии в том виде, в каком её отдаёт движок (issueRecords).
function record(id, over = {}) {
  return {
    issueId: id,
    issue: {
      problem_type: 'не_учтено_в_кп',
      risk_category: 'coverage',
      criticality: 'high',
      suggested_action: 'comment',
      basis: 'Работа не отражена в ведомости объёмов',
      source_fragment: 'Подрядчик обеспечивает ежедневную уборку территории',
      section_path: 'п. 4.1',
      confidence: 0.8,
      ...over,
    },
  };
}

// console.warn перехватывается: legacy-режим обязан оставлять явный след.
async function runCapturingWarn(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let result = null;
  let error = null;
  try {
    result = await fn();
  } catch (e) {
    error = e;
  } finally {
    console.warn = original;
  }
  return { result, error, warnings };
}

// --- Транзакция вызывающего -----------------------------------------------------

test('передана tx: все запросы слоя идут через неё, своя транзакция не открывается', async () => {
  const tx = fakeTx();
  const res = await writeSignalsForStage({
    tenderId: TENDER,
    stage: STAGE,
    analysisRunId: RUN,
    signals: [record('issue-1'), record('issue-2')],
    tx,
    strict: true,
  });

  assert.equal(res.written, 2);
  // Порядок: сначала гасим сигналы ЭТОГО прогона (идемпотентность в его пределах),
  // потом пишем свежие. Ни одного запроса мимо tx (иначе тест упал бы на pg).
  assert.equal(tx.calls.length, 3);
  assert.match(tx.calls[0].sql, /DELETE FROM analysis_signals/);
  assert.deepEqual(tx.calls[0].params, [TENDER, RUN]);
  assert.equal(tx.inserts().length, 2);
});

test('стадия без типа сигнала (вне 1–5) ничего не пишет и не трогает транзакцию', async () => {
  const tx = fakeTx();
  const res = await writeSignalsForStage({
    tenderId: TENDER, stage: 6, analysisRunId: RUN, signals: [record('issue-1')], tx, strict: true,
  });
  assert.deepEqual(res, { written: 0, skipped: true, run_id: RUN });
  assert.equal(tx.calls.length, 0);
});

test('стадия 5 (challenger) эмитит сигналы типа challenger', async () => {
  const tx = fakeTx();
  const res = await writeSignalsForStage({
    tenderId: TENDER, stage: 5, analysisRunId: RUN, signals: [record('issue-1')], tx, strict: true,
  });
  assert.equal(res.written, 1);
  const insert = tx.inserts()[0];
  assert.ok(insert.params.includes('challenger'), 'signal_type = challenger');
});

// --- strict: ошибка доходит до вызывающего ---------------------------------------

test('strict=true: SQL-ошибка не перехватывается и уходит наверх', async () => {
  const tx = fakeTx({ failOn: 'INSERT INTO analysis_signals' });
  await assert.rejects(
    () => writeSignalsForStage({
      tenderId: TENDER,
      stage: STAGE,
      analysisRunId: RUN,
      signals: [record('issue-1')],
      tx,
      strict: true,
    }),
    /соединение с БД потеряно/,
  );
});

test('strict=true: ложного успеха нет — при сбое результат не возвращается вовсе', async () => {
  const tx = fakeTx({ failOn: 'DELETE FROM analysis_signals' });
  let res = 'не должно присвоиться';
  try {
    res = await writeSignalsForStage({
      tenderId: TENDER, stage: STAGE, analysisRunId: RUN, signals: [record('issue-1')], tx, strict: true,
    });
    assert.fail('ожидалась ошибка записи сигналов');
  } catch (e) {
    assert.match(e.message, /соединение с БД потеряно/);
  }
  assert.equal(res, 'не должно присвоиться');
  assert.equal(tx.inserts().length, 0); // до вставок не дошло
});

test('strict=true: строка с чужим analysis_run_id — ошибка, а не тихая перепривязка', async () => {
  const tx = fakeTx();
  await assert.rejects(
    () => writeSignalsForStage({
      tenderId: TENDER,
      stage: STAGE,
      analysisRunId: RUN,
      // готовая строка сигнала, привязанная к другому прогону
      signals: [{ id: 's1', tenderId: TENDER, runId: 'run-другой', stage: STAGE, signalType: 'coverage' }],
      tx,
      strict: true,
    }),
    (err) => err.code === 'SIGNALS_RUN_ID_MISMATCH',
  );
  assert.equal(tx.calls.length, 0);
});

test('strict=true без analysis_run_id: запись запрещена (сигнал вне снимка)', async () => {
  const tx = fakeTx();
  await assert.rejects(
    () => writeSignalsForStage({
      tenderId: TENDER, stage: STAGE, signals: [record('issue-1')], tx, strict: true,
    }),
    (err) => err.code === 'SIGNALS_RUN_ID_REQUIRED',
  );
  assert.equal(tx.calls.length, 0);
});

// --- legacy: прежнее поведение, но со следом в логе ------------------------------

test('strict=false: вызов помечается предупреждением в логе', async () => {
  const tx = fakeTx();
  const { result, error, warnings } = await runCapturingWarn(() => writeSignalsForStage({
    tenderId: TENDER, stage: STAGE, analysisRunId: RUN, signals: [record('issue-1')], tx,
  }));

  assert.equal(error, null);
  assert.equal(result.written, 1);
  assert.ok(
    warnings.some((w) => w.includes('legacy-режиме') && w.includes(RUN)),
    `ожидалось предупреждение о legacy-режиме, получено: ${JSON.stringify(warnings)}`,
  );
});

test('strict=false: SQL-ошибка по-прежнему не роняет стадию, а логируется', async () => {
  const tx = fakeTx({ failOn: 'INSERT INTO analysis_signals' });
  const { result, error, warnings } = await runCapturingWarn(() => writeSignalsForStage({
    tenderId: TENDER, stage: STAGE, analysisRunId: RUN, signals: [record('issue-1')], tx,
  }));

  assert.equal(error, null); // прежняя совместимость: не бросает
  assert.equal(result.written, 0);
  assert.match(result.error, /соединение с БД потеряно/);
  assert.ok(warnings.some((w) => w.includes('не удалось записать сигналы')));
});

test('strict=false: старая форма вызова (runId/records) продолжает работать', async () => {
  const tx = fakeTx();
  const { result, error } = await runCapturingWarn(() => writeSignalsForStage({
    tenderId: TENDER, stage: STAGE, runId: RUN, records: [record('issue-1')], tx,
  }));

  assert.equal(error, null);
  assert.equal(result.written, 1);
  assert.equal(tx.inserts()[0].params[2], RUN);
});

// --- Привязка к прогону ----------------------------------------------------------

test('каждая строка пишется с analysis_run_id прогона-владельца', async () => {
  const tx = fakeTx();
  await writeSignalsForStage({
    tenderId: TENDER,
    stage: STAGE,
    analysisRunId: RUN,
    signals: [record('issue-1'), record('issue-2'), record('issue-3')],
    tx,
    strict: true,
  });

  const inserts = tx.inserts();
  assert.equal(inserts.length, 3);
  for (const call of inserts) {
    // Порядок колонок: id, tender_id, analysis_run_id, analysis_stage, signal_type, …
    assert.equal(call.params[1], TENDER);
    assert.equal(call.params[2], RUN);
    assert.equal(call.params[3], STAGE);
    assert.equal(call.params[4], 'coverage');
  }
  // Гашение прошлой записи ограничено ЭТИМ прогоном — архив других не трогаем.
  assert.deepEqual(tx.deletes()[0].params, [TENDER, RUN]);
});

test('legacy: строка с чужим прогоном перепривязывается к владельцу с предупреждением', async () => {
  const tx = fakeTx();
  const { result, warnings } = await runCapturingWarn(() => writeSignalsForStage({
    tenderId: TENDER,
    stage: STAGE,
    analysisRunId: RUN,
    signals: [{
      id: 's1', tenderId: TENDER, runId: 'run-другой', stage: STAGE, signalType: 'coverage',
      sourceEntityType: 'issue', sourceEntityId: 'issue-1', tzClause: 'п. 4.1',
      sourceFragment: 'фрагмент', payloadJson: '{}', weight: 0.6, createdAt: '2026-07-28T00:00:00.000Z',
    }],
    tx,
  }));

  assert.equal(result.written, 1);
  assert.equal(tx.inserts()[0].params[2], RUN);
  assert.ok(warnings.some((w) => w.includes('чужому прогону')));
});
