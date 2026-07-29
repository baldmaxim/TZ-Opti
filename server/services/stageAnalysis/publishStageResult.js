'use strict';

// ПУБЛИКАЦИЯ РЕЗУЛЬТАТА СТАДИИ — весь снимок одной транзакцией вызывающего.
//
// Сегодня движок публикует стадию четырьмя независимыми шагами (issues + статус
// одной транзакцией, затем сигналы своей, затем сегменты, затем активация), и
// падение между ними оставляет стадию «успешной» без опубликованного снимка.
// Этот сервис собирает материализацию снимка в ОДИН шаг: все запросы идут через
// переданную tx, поэтому либо есть всё, либо нет ничего.
//
// СЕРВИС ПОКА НЕ ПОДКЛЮЧЁН к production-потоку: stageAnalysisEngine публикует
// по-прежнему. Здесь материализация снимка, его активация И перевод стадии в
// 'reviewing' — намеренно узкие границы:
//   • не коммитит и не откатывает — транзакцией владеет вызывающий;
//   • не перехватывает ошибок — сбой любого шага останавливает публикацию и
//     уходит наверх (вызывающий откатывает транзакцию).
//
// Порядок шагов значим: сперва право на запись (прогон-кандидат жив и наш), затем
// issues, затем сигналы (для стадий 1–4 обязательны — иначе снимок опубликован
// без входа для конвейера), затем закрытие незавершённых частей ТЗ, затем
// активация указателя и ТОЛЬКО ПОСЛЕ НЕЁ — статус стадии.
//
// Статус стадии идёт ПОСЛЕДНИМ и той же транзакцией. Это и есть смысл сервиса:
// сегодня движок коммитит 'reviewing' ПЕРВЫМ, до сигналов и до перевода
// указателя, поэтому падение в середине оставляет стадию «успешной» без
// опубликованного снимка. Здесь до коммита вызывающего стадия для читателей
// остаётся в прежнем статусе, а после коммита виден весь результат сразу.

const analysisRuns = require('../analysisRuns/analysisRunsService');
const segmentStore = require('./segments/segmentStore');
const stageState = require('./stageState');
const { writeSignalsForStage } = require('../signals/signalWriter');
const { newId } = require('../../utils/ids');

// Стадии-добытчики: их находки идут в конвейер ТОЛЬКО через слой signals, поэтому
// снимок без сигналов для них — молча потерянный анализ. Стадия 5 (QC) сигналов
// не эмитит по определению (signalTypeForStage(5) === null).
const SIGNAL_STAGES = Object.freeze([1, 2, 3, 4]);

// Допустимые значения tender_stage_state.stageN_status.
const WORKFLOW_STATUSES = stageState.STAGE_STATUSES;

// Публикация переводит стадию РОВНО в один статус и ровно из одного: анализ шёл
// ('running') → результат ждёт инженера ('reviewing'). Другие переходы (finish,
// reset, возврат в 'open' после сбоя) — не про публикацию и здесь запрещены.
const WORKFLOW_TARGET = 'reviewing';
const WORKFLOW_EXPECTED_FROM = 'running';

// Прогон с таким исходом опубликованным не считается: перевод стадии в
// 'reviewing' по нему открыл бы гейт следующей стадии по НЕуспеху.
const RUN_STATUSES_BLOCKING_WORKFLOW = Object.freeze(['failed', 'cancelled', 'interrupted']);

function publishError(message, code, status = 500) {
  const err = new Error(`[publishStageResult] ${message}`);
  err.code = code;
  err.status = status;
  err.retryable = false;
  return err;
}

// --- 0. Вход -------------------------------------------------------------------

function assertInput({ tx, tenderId, stage, analysisRunId, issues, targetWorkflowStatus }) {
  if (!tx) throw publishError('нужна транзакция вызывающего (tx)', 'PUBLISH_TX_REQUIRED');
  if (!tenderId) throw publishError('не передан tenderId', 'PUBLISH_TENDER_REQUIRED');
  if (!Number.isInteger(stage) || stage < 1 || stage > 5) {
    throw publishError(`недопустимая стадия «${stage}» (допустимы 1..5)`, 'PUBLISH_STAGE_INVALID');
  }
  if (!analysisRunId) {
    throw publishError('не передан analysisRunId — публиковать снимок некуда', 'PUBLISH_RUN_ID_REQUIRED');
  }
  if (issues != null && !Array.isArray(issues)) {
    throw publishError('issues должен быть массивом находок', 'PUBLISH_ISSUES_INVALID');
  }
  if (targetWorkflowStatus != null && !WORKFLOW_STATUSES.includes(targetWorkflowStatus)) {
    throw publishError(
      `недопустимый targetWorkflowStatus «${targetWorkflowStatus}»`,
      'PUBLISH_WORKFLOW_STATUS_INVALID',
    );
  }
  if (targetWorkflowStatus != null && targetWorkflowStatus !== WORKFLOW_TARGET) {
    throw publishError(
      `публикация переводит стадию только в «${WORKFLOW_TARGET}», а запрошен «${targetWorkflowStatus}»`,
      'PUBLISH_WORKFLOW_STATUS_UNSUPPORTED',
    );
  }
}

// --- 1–2. Право на запись в прогон ------------------------------------------------

// Единый страж неизменяемости снимков — analysisRuns.assertRunWritable: SELECT …
// FOR UPDATE в ЭТОЙ транзакции (значит, активация не проскочит между проверкой и
// записью), отказ при чужом тендере, чужом kind, архивированном или завершённом
// прогоне. Статус и superseded проверяем ещё раз явно: это инвариант публикации,
// и он должен быть виден здесь, а не только внутри чужой функции.
async function assertRunPublishable(tx, { tenderId, stage, analysisRunId }) {
  const run = await analysisRuns.assertRunWritable(tenderId, analysisRunId, { kind: 'stage' }, tx);
  if (run.status !== 'running') {
    throw publishError(
      `прогон ${analysisRunId} не в работе (status='${run.status}') — публиковать в него нельзя`,
      'PUBLISH_RUN_NOT_RUNNING', 409,
    );
  }
  if (run.superseded_at) {
    throw publishError(
      `прогон ${analysisRunId} архивирован (superseded_at=${run.superseded_at})`,
      'PUBLISH_RUN_SUPERSEDED', 409,
    );
  }
  // Строка уже заблокирована предыдущим SELECT … FOR UPDATE, поэтому дочитать
  // стадию владельца дёшево. Публикация в прогон ЧУЖОЙ стадии смешала бы снимки.
  const owner = await tx.queryOne('SELECT stage FROM analysis_runs WHERE id = ?', analysisRunId);
  const ownerStage = owner && owner.stage != null ? Number(owner.stage) : null;
  if (ownerStage != null && ownerStage !== stage) {
    throw publishError(
      `прогон ${analysisRunId} принадлежит стадии ${ownerStage}, а публикуется стадия ${stage}`,
      'PUBLISH_RUN_STAGE_MISMATCH', 409,
    );
  }
  return run;
}

// --- 3. Issues -------------------------------------------------------------------

// Идемпотентность в пределах ПРОГОНА: чистим только issues этого прогона (повторная
// попытка той же задачи не должна их удваивать), прежние прогоны — архив, не трогаем.
async function writeIssues(tx, { tenderId, stage, analysisRunId, issues }) {
  await tx.queryRun(
    'DELETE FROM issues WHERE tender_id = ? AND analysis_run_id = ?',
    tenderId, analysisRunId,
  );
  const records = [];
  for (const issue of issues) {
    const issueId = issue.id || newId();
    // eslint-disable-next-line no-await-in-loop
    await tx.queryRun(
      `
      INSERT INTO issues (
        id, tender_id, analysis_run_id, analysis_stage, source_document_id, source_clause,
        source_fragment, paragraph_index, char_start, char_end,
        problem_type, risk_category, criticality, price_impact, schedule_impact,
        basis, suggested_action, suggested_redaction, review_comment, confidence,
        section_path, review_status, selected_for_export
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1
      )
    `,
      issueId,
      tenderId,
      analysisRunId,
      stage,
      issue.source_document_id || null,
      issue.source_clause || null,
      issue.source_fragment || null,
      issue.paragraph_index ?? null,
      issue.char_start ?? null,
      issue.char_end ?? null,
      issue.problem_type || null,
      issue.risk_category || null,
      issue.criticality || 'medium',
      issue.price_impact || null,
      issue.schedule_impact || null,
      issue.basis || null,
      issue.suggested_action || 'comment',
      issue.suggested_redaction || null,
      issue.review_comment || null,
      issue.confidence ?? 0.6,
      issue.section_path || null,
    );
    records.push({ issueId, issue });
  }
  return records;
}

// --- 4–5. Signals ------------------------------------------------------------------

// signals может быть массивом (готовые строки сигналов или записи { issueId, issue })
// либо функцией от записей сохранённых issues — id находок известны только ПОСЛЕ
// шага 3, а сигнал обязан ссылаться на них (source_entity_id).
async function resolveSignals(signals, issueRecords) {
  if (typeof signals === 'function') return signals(issueRecords);
  return signals;
}

// Стадии 1–4: сигналы обязательны. Отсутствие (null/undefined/не массив) — ошибка
// публикации; пустой массив при непустых находках — тоже: конвейер читает только
// signals, и такой снимок означал бы «стадия отработала, находок нет».
function assertSignalsPresent(stage, resolved, issueCount) {
  if (resolved == null || !Array.isArray(resolved)) {
    throw publishError(
      `стадия ${stage}: сигналы обязательны — без них снимок опубликован без входа для конвейера`,
      'PUBLISH_SIGNALS_REQUIRED', 500,
    );
  }
  if (issueCount > 0 && resolved.length === 0) {
    throw publishError(
      `стадия ${stage}: ${issueCount} находок не дали ни одного сигнала — находки были бы потеряны`,
      'PUBLISH_SIGNALS_REQUIRED', 500,
    );
  }
}

async function writeSignals(tx, { tenderId, stage, analysisRunId, signals, issueRecords }) {
  const resolved = await resolveSignals(signals, issueRecords);

  // Стадия 5 (QC над итогом) сигналов не эмитит — их отсутствие здесь НОРМА,
  // а не сбой публикации (см. signalWriter.signalTypeForStage).
  if (!SIGNAL_STAGES.includes(stage)) {
    const passed = Array.isArray(resolved) ? resolved.length : 0;
    return {
      written: 0,
      skipped: true,
      reason: `стадия ${stage} сигналов не эмитит`,
      ...(passed ? { ignored: passed } : {}),
    };
  }

  assertSignalsPresent(stage, resolved, issueRecords.length);
  // strict: ошибка записи сигналов обязана обрушить публикацию, а не быть
  // проглоченной — снимок без сигналов активировать нельзя.
  return writeSignalsForStage({
    tx, strict: true, tenderId, stage, analysisRunId, signals: resolved,
  });
}

// --- 6. Части ТЗ ---------------------------------------------------------------------

// Живых (pending/running) строк у опубликованного прогона быть не должно: то, что
// считалось в момент завершения → interrupted, то, до чего не дошли → skipped.
// Тем же коммитом, что и снимок, — иначе история частей разъезжается с прогоном.
function finalizeSegments(tx, { analysisRunId, stage }) {
  return segmentStore.finalizeRunSegments(analysisRunId, {
    tx, reason: `публикация результата стадии ${stage}`,
  });
}

// --- 7. Активация снимка --------------------------------------------------------------

// Перед переводом указателя проверяем ОБА условия активации: прогон всё ещё наш
// и в работе (строка заблокирована с шага 1, но инвариант должен быть виден явно),
// и записанное шагами 3–5 физически лежит в БД. Считаем строки, а не верим
// счётчикам в памяти: активировать снимок, в котором ничего нет, — худший исход
// (портал покажет успех и пустой результат).
async function assertActivatable(tx, { tenderId, stage, analysisRunId, issueRecords, signalsReport }) {
  const run = await tx.queryOne(
    'SELECT id, tender_id, stage, status, superseded_at FROM analysis_runs WHERE id = ?',
    analysisRunId,
  );
  if (!run) {
    throw publishError(`прогон ${analysisRunId} исчез до активации`, 'ACTIVATE_RUN_NOT_FOUND', 409);
  }
  if (run.tender_id !== tenderId) {
    throw publishError(
      `прогон ${analysisRunId} принадлежит другому тендеру (${run.tender_id})`,
      'ACTIVATE_RUN_FOREIGN_TENANT', 409,
    );
  }
  if (run.stage != null && Number(run.stage) !== stage) {
    throw publishError(
      `прогон ${analysisRunId} принадлежит стадии ${run.stage}, а активируется стадия ${stage}`,
      'ACTIVATE_RUN_STAGE_MISMATCH', 409,
    );
  }
  if (run.status !== 'running') {
    throw publishError(
      `прогон ${analysisRunId} уже не в работе (status='${run.status}') — активировать нечего`,
      'ACTIVATE_RUN_NOT_RUNNING', 409,
    );
  }
  if (run.superseded_at) {
    throw publishError(
      `прогон ${analysisRunId} архивирован во время публикации — активация отменена`,
      'ACTIVATE_RUN_SUPERSEDED', 409,
    );
  }

  const issuesRow = await tx.queryOne(
    'SELECT COUNT(*) AS c FROM issues WHERE tender_id = ? AND analysis_run_id = ?',
    tenderId, analysisRunId,
  );
  const issuesInDb = Number((issuesRow && issuesRow.c) || 0);
  if (issuesInDb !== issueRecords.length) {
    throw publishError(
      `в прогоне ${analysisRunId} лежит ${issuesInDb} находок вместо ${issueRecords.length} — активация отменена`,
      'ACTIVATE_ISSUES_NOT_PERSISTED', 500,
    );
  }

  // Стадия 5 сигналов не эмитит — активируется без них (это норма, а не пробел).
  if (!SIGNAL_STAGES.includes(stage)) {
    return { issues: issuesInDb, signals: 0, signals_required: false };
  }

  const signalsRow = await tx.queryOne(
    'SELECT COUNT(*) AS c FROM analysis_signals WHERE tender_id = ? AND analysis_run_id = ?',
    tenderId, analysisRunId,
  );
  const signalsInDb = Number((signalsRow && signalsRow.c) || 0);
  const expected = Number(signalsReport && signalsReport.written) || 0;
  if (signalsInDb !== expected) {
    throw publishError(
      `в прогоне ${analysisRunId} лежит ${signalsInDb} сигналов вместо ${expected} — активация отменена`,
      'ACTIVATE_SIGNALS_NOT_PERSISTED', 500,
    );
  }
  if (issueRecords.length > 0 && signalsInDb === 0) {
    throw publishError(
      `стадия ${stage}: снимок без сигналов активировать нельзя — находки были бы невидимы конвейеру`,
      'ACTIVATE_SIGNALS_REQUIRED', 500,
    );
  }
  return { issues: issuesInDb, signals: signalsInDb, signals_required: true };
}

// Перевод указателя. Той же транзакцией: activateRun с tx не открывает свою,
// не коммитит и не откатывает. Критические UPDATE внутри проверяются по rowCount
// (см. analysisRuns.activateRun), ошибка не подавляется здесь ничем.
function activate(tx, { tenderId, stage, analysisRunId, summary, documentsRevisionId, configVersion }) {
  return analysisRuns.activateRun(
    tenderId,
    analysisRuns.stageScope(stage),
    analysisRunId,
    {
      summary: summary == null || typeof summary === 'string' ? summary ?? null : JSON.stringify(summary),
      documentsRevisionId: documentsRevisionId ?? null,
      configVersion: configVersion ?? null,
    },
    tx,
  );
}

// --- 8. Статус стадии ------------------------------------------------------------------

// Перевод в 'reviewing' разрешён ТОЛЬКО по опубликованному прогону. После
// активации строка прогона обязана быть completed и не архивированной: любой
// неуспешный исход (failed / cancelled / interrupted) или перехват снимка другим
// прогоном означает, что показывать инженеру нечего, а гейт следующей стадии
// открывать нельзя.
async function assertWorkflowTransitionAllowed(tx, { tenderId, stage, analysisRunId }) {
  const run = await tx.queryOne(
    'SELECT id, tender_id, stage, status, superseded_at FROM analysis_runs WHERE id = ?',
    analysisRunId,
  );
  if (!run) {
    throw publishError(
      `прогон ${analysisRunId} исчез до перевода статуса стадии`,
      'WORKFLOW_RUN_NOT_FOUND', 409,
    );
  }
  if (run.tender_id !== tenderId) {
    throw publishError(
      `прогон ${analysisRunId} принадлежит другому тендеру (${run.tender_id})`,
      'WORKFLOW_RUN_FOREIGN_TENANT', 409,
    );
  }
  if (run.stage != null && Number(run.stage) !== stage) {
    throw publishError(
      `прогон ${analysisRunId} принадлежит стадии ${run.stage}, а переводится стадия ${stage}`,
      'WORKFLOW_RUN_STAGE_MISMATCH', 409,
    );
  }
  if (RUN_STATUSES_BLOCKING_WORKFLOW.includes(run.status)) {
    throw publishError(
      `прогон ${analysisRunId} завершился как «${run.status}» — стадию нельзя переводить в «${WORKFLOW_TARGET}»`,
      'WORKFLOW_RUN_NOT_PUBLISHED', 409,
    );
  }
  if (run.status !== 'completed') {
    throw publishError(
      `прогон ${analysisRunId} после активации имеет статус «${run.status}» вместо «completed»`,
      'WORKFLOW_RUN_NOT_COMPLETED', 409,
    );
  }
  if (run.superseded_at) {
    throw publishError(
      `прогон ${analysisRunId} архивирован (перехвачен другим прогоном) — статус стадии не переводим`,
      'WORKFLOW_RUN_SUPERSEDED', 409,
    );
  }
  return run;
}

// Сам перевод: условный UPDATE (ожидаемый предыдущий статус в WHERE) с проверкой
// rowCount — 0 строк это конфликт жизненного цикла, а не «нечего менять».
// Той же транзакцией: до коммита вызывающего стадия остаётся в прежнем статусе.
function transitionWorkflow(tx, { tenderId, stage }) {
  return stageState.transitionStageStatus(tenderId, stage, {
    from: WORKFLOW_EXPECTED_FROM, to: WORKFLOW_TARGET, tx,
  });
}

// --- Публикация -----------------------------------------------------------------------

// Материализовать снимок стадии в переданной транзакции. Возвращает отчёт о том,
// что записано; коммит, активация указателя и перевод workflow-статуса — за
// вызывающим (см. границы в шапке файла).
async function publishStageResult({
  tx = null,
  tenderId = null,
  stage = null,
  analysisRunId = null,
  issues = [],
  signals = null,
  targetWorkflowStatus = null,
  // Опционально — уходит в строку прогона при активации (COALESCE: null сохраняет
  // то, что записал beginStageRun).
  summary = null,
  documentsRevisionId = null,
  configVersion = null,
} = {}) {
  assertInput({ tx, tenderId, stage, analysisRunId, issues, targetWorkflowStatus });
  const list = issues || [];

  // 1–2. Прогон существует, наш, в работе и не архивирован (SELECT … FOR UPDATE).
  await assertRunPublishable(tx, { tenderId, stage, analysisRunId });

  // 3. Находки стадии.
  const issueRecords = await writeIssues(tx, { tenderId, stage, analysisRunId, issues: list });

  // 4–5. Сигналы: обязательны для 1–4, отсутствуют по определению у 5.
  const signalsReport = await writeSignals(tx, {
    tenderId, stage, analysisRunId, signals, issueRecords,
  });

  // 6. Закрытие незавершённых частей ТЗ этого прогона.
  const segmentsReport = await finalizeSegments(tx, { analysisRunId, stage });

  // 7. Активация: только после того, как всё выше записано и перепроверено.
  const verified = await assertActivatable(tx, {
    tenderId, stage, analysisRunId, issueRecords, signalsReport,
  });
  const activation = await activate(tx, {
    tenderId, stage, analysisRunId, summary, documentsRevisionId, configVersion,
  });

  // 8. Статус стадии — ПОСЛЕ активации и только по опубликованному прогону.
  await assertWorkflowTransitionAllowed(tx, { tenderId, stage, analysisRunId });
  const workflow = await transitionWorkflow(tx, { tenderId, stage });

  return {
    tender_id: tenderId,
    stage,
    analysis_run_id: analysisRunId,
    issues_written: issueRecords.length,
    issue_ids: issueRecords.map((r) => r.issueId),
    signals: signalsReport,
    segments: segmentsReport,
    // Что подтверждено в БД перед активацией (счётчики строк, а не памяти).
    verified,
    activation,
    activated: true,
    pointer_moved: true,
    // Статус стадии переведён В ТОЙ ЖЕ транзакции — видимым он станет только
    // после коммита вызывающего.
    workflow,
    target_workflow_status: targetWorkflowStatus || WORKFLOW_TARGET,
    workflow_status_applied: true,
    // Коммит — исключительно за вызывающим.
    committed: false,
  };
}

module.exports = {
  publishStageResult,
  // Константы и шаги — для тестов и будущей интеграции.
  SIGNAL_STAGES,
  WORKFLOW_STATUSES,
  WORKFLOW_TARGET,
  WORKFLOW_EXPECTED_FROM,
  RUN_STATUSES_BLOCKING_WORKFLOW,
  assertInput,
  assertRunPublishable,
  writeIssues,
  writeSignals,
  finalizeSegments,
  assertActivatable,
  assertWorkflowTransitionAllowed,
  transitionWorkflow,
};
