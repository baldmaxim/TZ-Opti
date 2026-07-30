'use strict';

const db = require('../../db/connection');
const { badRequest } = require('../../utils/errors');
const {
  getTzText,
  getDocumentByType,
} = require('../tzActiveTextService');
const analysisRuns = require('../analysisRuns/analysisRunsService');
const { runStage1Llm } = require('./stage1_llm');
const { runStage2Llm } = require('./stage2_llm');
const { runStage3Llm } = require('./stage3_llm');
const { runStage4Llm } = require('./stage4_llm');
const { runPipeline } = require('../pipeline/analysisPipeline');
const audit = require('../audit/auditService');
const { importQaXlsx } = require('../qaImportService');
const { ensureVorItems } = require('../vor/vorImportService');
const { isConfigured: isOpenAiConfigured } = require('./llm/openaiClient');
const { isOwnedBy, stageResultType } = require('../review/stageDomains');
const { publishStageResult } = require('./publishStageResult');
const segmentStore = require('./segments/segmentStore');
const { makeStageSegmentStore } = segmentStore;
const jobService = require('../jobs/jobService');
const jobQueue = require('../jobs/jobQueue');
const { stageScopeKey } = require('../jobs/jobModel');
const { STATUS } = require('../analysis/resultStatus');
// Статус стадии и гейты (tender_stage_state) — отдельный слой stageState.js:
// движок отвечает за ПРОГОН стадии, тот — за её СОСТОЯНИЕ. Функции
// реэкспортируются ниже, поэтому внешний API движка не изменился.
const {
  classifyStageRun,
  canFinishStage,
  isStageRunnable,
  getStageState,
  setStageStatus,
  unlockNextStage,
  releaseRunningStage,
  recoverOrphanedRunningStages,
} = require('./stageState');

// Единый серверный источник названий стадий (идёт в summary.label).
// Тексты должны совпадать с STAGE_META на клиенте (client/src/utils/labels.js).
const STAGE_LABELS = {
  1: 'ТЗ + Чек-лист + ВОР',
  2: 'Q&A + Характеристики',
  3: 'Существенные условия компании',
  4: 'Типовые риски',
  5: 'Самоанализ ТЗ',
};

// runId ОБЯЗАТЕЛЕН: прогон стадии создан ДО оркестратора, и каждая часть ТЗ
// пишет свою историю выполнения именно в него (analysis_run_segments).
async function buildContextForStage(tenderId, stage, { runId, configVersion = null } = {}) {
  const {
    document: tzDoc, paragraphs, blocks, activeText, rawText, revisionId, missingMd,
  } = await getTzText(tenderId);
  if (missingMd || !tzDoc) {
    throw badRequest('Загрузите .md-копию ТЗ в слот «ТЗ → Markdown» — анализ ведётся только по .md.');
  }
  // Источником может быть согласованная версия (синтетический документ
  // 'agr:…' — его нет в documents): FK-ссылки issues ведут на исходный .md,
  // а если тот удалён — остаются пустыми.
  let sourceDocumentId = tzDoc.id;
  if (tzDoc.agreed_version_id) {
    const base = tzDoc.base_document_id
      ? await db.queryOne('SELECT id FROM documents WHERE id = ?', tzDoc.base_document_id)
      : null;
    sourceDocumentId = base ? base.id : null;
  }
  const ctx = {
    tenderId,
    analysisRunId: runId || null,
    sourceDocumentId,
    paragraphs,
    blocks,
    activeText,
    rawText,
    rawMd: rawText,
    documentRevisionId: revisionId,
    // Части ТЗ: КЭШ результата (analysis_segments, скоуплен ревизией) + ИСТОРИЯ
    // выполнения в ЭТОМ прогоне (analysis_run_segments). Повтор стадии не
    // переспрашивает LLM про посчитанные части, упавшую часть можно
    // перезапустить точечно (retryStageSegment), а летопись прошлого прогона
    // при этом не затирается.
    segmentStore: makeStageSegmentStore({
      tenderId, stage, revisionId, configVersion, runId, logTag: `stage${stage}_segments`,
    }),
  };
  if (stage === 1) {
    const vorDoc = await getDocumentByType(tenderId, 'vor');
    // Основной путь — СТРУКТУРНЫЕ позиции ВОР (vor_items): номер, шифр, раздел,
    // наименование, единица, количество, координаты. ensureVorItems ленивo
    // импортирует таблицу, если её загрузили до появления структурного импорта.
    // vorText остаётся фолбэком для ВОР не таблицей (pdf/docx).
    const { items } = await ensureVorItems(tenderId, vorDoc);
    ctx.vorItems = items;
    ctx.vorText = vorDoc ? (vorDoc.extracted_text || '') : '';
    ctx.checklist = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ?', tenderId);
  }
  if (stage === 2) {
    ctx.qaEntries = await db.queryAll('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC', tenderId);
    // Таблица характеристик — второй справочник принятого (значения, принятые
    // компанией в расчёт). Стадия 2 сверяет ТЗ и с Q&A-решениями, и с ней.
    ctx.characteristics = await db.queryAll(
      'SELECT * FROM characteristics WHERE tender_id = ? ORDER BY sort_order ASC, name ASC',
      tenderId,
    );
  }
  // Стадия 3 (Существенные условия) и Стадия 4 (Типовые риски) сами загружают
  // нужные данные из БД (company_conditions / risks_state) — отдельный
  // ctx-prefetch не требуется.
  return ctx;
}

// Стадия 5 — НОВАЯ роль: self-analysis как quality-control над ИТОГОМ
// (кластеры новой архитектуры + исходный ТЗ), а НЕ второй поток issues по тексту.
// Поэтому она НЕ пишет в таблицу issues — возвращает пустой issues[], а находки
// о качестве разбора кладёт в self_analysis_results (selfAnalysisService).
// Стадия 5 НЕ мутирует действующий pipeline-снимок. Прежде она звала
// buildSelfAnalysis без runId, тот брал АКТИВНЫЙ прогон и перезаписывал в нём
// self_analysis_results — правка уже выданного результата. Теперь стадия
// заказывает у оркестратора НОВЫЙ снимок (кандидат: draft_issues → critic →
// clustering → self-analysis) и он активируется целиком только по успеху; при
// сбое указатель остаётся на прежнем снимке.
// Полного отказа QC buildSelfAnalysis не маскирует (бросает) — шаг конвейера
// падает, а прогон стадии завершается как failed (finalizeStageRun — тот же
// прогон, что был начат до оркестратора).
async function runStage5SelfAnalysis(ctx) {
  const report = await runPipeline(ctx.tenderId, { withSelfAnalysis: true });
  if (!report.ok) {
    const reason = report.error
      || (report.failed_step ? `шаг «${report.failed_step}» не выполнен` : 'сборка снимка не удалась');
    const err = new Error(`Самоанализ (Стадия 5): ${reason}`);
    err.status = report.blocked === 'inputs' ? 409 : 502;
    throw err;
  }
  const step = (report.steps || []).find((s) => s.step === 'self_analysis');
  const sa = (step && step.summary) || {};
  const issues = [];
  const qc = sa.llm_status
    ? ` LLM-QC: ${sa.llm_status}${sa.llm_reason ? ` (${sa.llm_reason})` : ''}.`
    : '';
  issues.analysisNote =
    `Самоанализ (QC) над итогом: ${sa.findings ?? 0} замечаний о качестве разбора ` +
    `по ${sa.clusters ?? 0} кластерам — см. self_analysis_results (issues не порождаются). ` +
    `Собран НОВЫЙ снимок конвейера ${report.run_id}; решения прошлого снимка переносятся ` +
    `явно (Перенос решений).${qc}`;
  issues.selfAnalysis = sa;
  issues.pipelineRunId = report.run_id;
  return issues;
}

function runStageOrchestrator(stage, ctx) {
  switch (stage) {
    case 1: return runStage1Llm(ctx);
    case 2: return runStage2Llm(ctx);
    case 3: return runStage3Llm(ctx);
    case 4: return runStage4Llm(ctx);
    case 5: return runStage5SelfAnalysis(ctx);
    default: throw badRequest('Допустимы стадии 1..5');
  }
}

// Подписка Claude Code НЕ держит параллель: одновременные прогоны Стадии 1
// душат друг друга и ловят таймаут (см. project_stage1_context_limit).
// Гард «один прогон на (tender,stage)» больше НЕ живёт в памяти процесса: его
// держит очередь (живое задание на область + advisory-lock на время работы),
// поэтому он действует и между процессами, и после рестарта.
async function runStage(tenderId, stage) {
  const scope = stageScopeKey(stage);
  const busy = await jobQueue.getActiveJobForScope(tenderId, scope);
  if (busy) {
    throw badRequest(
      `Анализ стадии ${stage} уже выполняется. Дождитесь завершения ` +
        `(Стадия 1 — до ~15 минут) и не запускайте повторно: параллельные ` +
        `прогоны мешают друг другу и приводят к таймауту.`,
    );
  }
  return runStageInner(tenderId, stage);
}

// --- Жизненный цикл прогона стадии ---------------------------------------------
//
// ПРОГОН СОЗДАЁТСЯ ДО РАБОТЫ, а не после неё. Раньше analysis_run писался в
// самом конце успешного анализа, а на ошибке движок вставлял ОТДЕЛЬНУЮ строку с
// started_at = finished_at = «сейчас», без ревизии документов и версии
// конфигурации. Из-за этого: длительность прогона была фикцией, вход (на чём
// именно упало) — неизвестен, а части ТЗ во время работы писались в «ничей»
// прогон. Теперь:
//   1) beginStageRun — status='running', реальные started_at / documents_revision_id
//      / config_version. Этот runId идёт в ctx и в КАЖДУЮ часть ТЗ;
//   2) успех — activateRun (completed + перевод указателя);
//   3) любой неуспех — finalizeStageRun ТОГО ЖЕ прогона: failed | cancelled |
//      interrupted, реальный finished_at, error в summary. Второй строки нет.
//
// Владение: кто прогон создал, тот его и завершает. Прогон, начатый заданием
// очереди (control.runId), завершает финализатор задания (onJobSettled) — иначе
// первая же неудачная попытка закрыла бы прогон, который очередь собирается
// повторить.

// Пустая (кроме плана) строка прогона стадии: status='running', реальные
// started_at / ревизия документов / версия конфигурации. Побочных эффектов нет —
// закрытие прежних 'running'-прогонов делает тот, кто прогон ЗАКРЕПИЛ за работой
// (attachStageRunToJob / синхронный runStageInner): иначе проигравший гонку
// закрыл бы чужой, только что начатый прогон.
async function beginStageRun(tenderId, stage, { reason = null } = {}) {
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(tenderId);
  const configVersion = analysisRuns.currentConfigVersion();
  const runId = await analysisRuns.beginRun(tenderId, analysisRuns.stageScope(stage), {
    stage, documentsRevisionId, configVersion,
  });
  await db.queryRun(
    'UPDATE analysis_runs SET summary = ? WHERE id = ?',
    JSON.stringify({
      stage, label: STAGE_LABELS[stage], status: 'running', reason: reason || 'stage.run',
    }),
    runId,
  );
  return { runId, documentsRevisionId, configVersion };
}

// У стадии может быть только один живой прогон: начатый вытесняет прежние.
const closeStaleStageRuns = (tenderId, stage, runId) => analysisRuns.interruptStaleStageRuns(
  tenderId, stage,
  { exceptRunId: runId, reason: `прогон оборван: у стадии ${stage} начат новый прогон ${runId}` },
);

// Закрепить прогон за заданием. Гонку «постановка в очередь против воркера,
// уже забравшего задачу» разрешает БД: analysis_run_id проставляется УСЛОВНО
// (WHERE analysis_run_id IS NULL), и выигрывает ровно один. Проигравший берёт
// чужой прогон, а свой — пустой, ни разу не использованный — удаляет: держать
// вторую «начатую» строку на одно задание значит врать истории.
async function attachStageRunToJob(jobId, tenderId, stage, runId) {
  const res = await db.queryRun(
    'UPDATE analysis_jobs SET analysis_run_id = ? WHERE id = ? AND analysis_run_id IS NULL RETURNING id',
    runId, jobId,
  );
  if (res && res.rows && res.rows.length) {
    await closeStaleStageRuns(tenderId, stage, runId);
    return runId;
  }
  const job = await db.queryOne('SELECT analysis_run_id FROM analysis_jobs WHERE id = ?', jobId);
  const winner = (job && job.analysis_run_id) || null;
  if (winner && winner !== runId) {
    await db.queryRun(`DELETE FROM analysis_runs WHERE id = ? AND status = 'running'`, runId);
  }
  return winner || runId;
}

// Восстановление после падения/рестарта (старт сервера и воркера): прогон
// стадии, оставшийся 'running' без единого живого задания очереди, закрывается
// как interrupted — вместе со своими частями ТЗ. Прогон, который прямо сейчас
// ведёт воркер в другом процессе, защищён живым заданием и не трогается.
async function recoverOrphanedStageRuns(opts = {}) {
  const ids = await analysisRuns.recoverOrphanedStageRuns(opts);
  for (const runId of ids) {
    // eslint-disable-next-line no-await-in-loop
    await segmentStore.finalizeRunSegments(runId, {
      reason: 'прогон оборван (рестарт сервера / потеря воркера)',
    });
  }
  return ids;
}

// Терминальный статус прогона по исходу задания/ошибке (чистая функция).
function runFailureStatus(source) {
  if (source === 'cancelled' || (source && source.cancelled)) return STATUS.CANCELLED;
  if (source === 'interrupted' || (source && source.leaseLost)) return STATUS.INTERRUPTED;
  return STATUS.FAILED;
}

// Summary неуспешного прогона стадии — тот же контракт, что у успешного
// (severity читают и сервер, и клиент), плюс причина и место сбоя.
function failureSummary(stage, status, err, extra = {}) {
  const msg = (err && err.message) || String(err || 'неизвестная ошибка анализа');
  return {
    stage,
    label: STAGE_LABELS[stage],
    status,
    result_type: stageResultType(stage),
    failed: true,
    error: msg,
    // Часть ТЗ, на которой прогон встал (llmStage кладёт segmentIndex в ошибку).
    failed_segment_index: err && Number.isInteger(err.segmentIndex) ? err.segmentIndex : null,
    ...extra,
  };
}

// Завершить НАЧАТЫЙ прогон стадии неуспешно + закрыть его незавершённые части +
// вернуть стадию в исходный статус (re-runnable). Никогда не бросает: это
// финализатор. Возвращает { run_id, status, finalized }.
//
// ОДНА ТРАНЗАКЦИЯ на весь неуспешный исход: история частей не может разъехаться
// со статусом прогона, а стадия — остаться «крутящейся» при закрытом прогоне
// (раньше это были три независимых шага). Порядок значим: сначала части
// (running → interrupted, pending → skipped), затем сам прогон (терминальный
// статус + failureSummary), затем возврат workflow-статуса. Указатель
// (analysis_active_runs) не трогается вовсе — прежний активный снимок остаётся.
// Повторный вызов идемпотентен: прогон уже не 'running' → finalizeRun вернёт
// false, у частей и статуса стадии условные UPDATE не найдут строк.
async function finalizeStageRun(tenderId, stage, runId, err, {
  status = null, prevStatus = null, reason = null,
} = {}) {
  const outcome = status || runFailureStatus(err);
  let finalized = false;
  try {
    if (runId) {
      await db.transaction(async (tx) => {
        await segmentStore.finalizeRunSegments(runId, {
          reason: (err && err.message) || reason || `прогон завершён со статусом «${outcome}»`,
          tx,
        });
        finalized = await analysisRuns.finalizeRun(runId, {
          status: outcome,
          summary: failureSummary(stage, outcome, err, reason ? { reason } : {}),
        }, tx);
        if (prevStatus != null) await releaseRunningStage(tenderId, stage, prevStatus, tx);
      });
    } else {
      // Прогон не начинался (сбой до beginStageRun — например, гейт стадии).
      // Фиктивную строку НЕ создаём: прогона не было, и притворяться, что он
      // был, значит врать истории. Видимый след остаётся в задании очереди.
      // eslint-disable-next-line no-console
      console.warn(
        `[stageEngine] стадия ${stage}: сбой до начала прогона — ${(err && err.message) || outcome}`,
      );
      if (prevStatus != null) await releaseRunningStage(tenderId, stage, prevStatus);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[stageEngine] finalizeStageRun сбой: ${e.message}`);
  }
  return { run_id: runId || null, status: outcome, finalized };
}

// Фоновый запуск: быстрые проверки синхронно (гард/доступность → понятная
// ошибка сразу), затем стадия ставится в устойчивую очередь и считается
// воркером сколько нужно. Клиент опрашивает статус (state.stageN_status +
// прогресс задания) и узнаёт исход по последнему analysis_run.
// Ни прогресс, ни факт «идёт прогон» больше не живут в памяти процесса:
// рестарт сервера не теряет задание, а повторный клик не создаёт дубль.
async function startStageBackground(tenderId, stage, opts = {}) {
  const state = await getStageState(tenderId);
  if (stage < 1 || stage > 5) throw badRequest('Допустимы стадии 1..5');
  if (!isStageRunnable(state, stage)) {
    throw badRequest(`Стадия ${stage} недоступна. Сначала завершите стадию ${stage - 1}.`);
  }
  const prevStatus = state[`stage${stage}_status`];
  const { job, deduped } = await jobService.enqueueStageAnalysis(tenderId, stage, {
    prevStatus: prevStatus === 'running' ? 'open' : prevStatus,
    idempotencyKey: opts.idempotencyKey || null,
    createdBy: opts.createdBy || null,
  });
  // ПРОГОН СОЗДАЁТСЯ ЗДЕСЬ — до того, как воркер запустит LLM-оркестратор.
  // Один прогон на задание: повторная попытка задачи продолжает ЕГО (части ТЗ
  // подхватываются из кэша), а не заводит второй снимок. Дедуплицированное
  // задание уже несёт свой прогон — второго не создаём.
  let runId = job.analysis_run_id || null;
  if (!deduped && !runId) {
    const started = await beginStageRun(tenderId, stage, { reason: `stage.run job=${job.id}` });
    runId = await attachStageRunToJob(job.id, tenderId, stage, started.runId);
  }
  // Условно: воркер мог подхватить задание и увести стадию дальше ('reviewing')
  // раньше, чем сюда дойдёт управление, — тогда перетирать статус нельзя.
  if (!deduped) {
    await db.queryRun(
      `UPDATE tender_stage_state SET stage${stage}_status = 'running', current_stage = ?
        WHERE tender_id = ? AND stage${stage}_status = ?`,
      stage, tenderId, prevStatus,
    );
  }
  return { status: 'running', job_id: job.id, run_id: runId, deduped: deduped || null };
}

// control (опц.) — мост к задаче очереди: прогресс по сегментам, чекпойнт
// (повтор продолжает с последнего готового сегмента), кооперативная отмена и
// ПРОГОН задания (control.runId): все попытки одной задачи пишут в один прогон,
// а завершает его финализатор задания.
async function runStageInner(tenderId, stage, control = null) {
  // Прогон, начатый заданием, принадлежит заданию: свой создаём только в
  // синхронном (внеочередном) вызове и тогда же сами его и завершаем.
  const ownsRun = !(control && control.runId);
  let runId = (control && control.runId) || null;
  let documentsRevisionId = null;
  let configVersion = null;
  try {
    if (ownsRun) {
      ({ runId, documentsRevisionId, configVersion } = await beginStageRun(tenderId, stage, {
        reason: 'stage.run.sync',
      }));
      await closeStaleStageRuns(tenderId, stage, runId);
    } else {
      const run = await analysisRuns.getRun(runId);
      documentsRevisionId = (run && run.documents_revision_id) || null;
      configVersion = (run && run.config_version) || null;
    }
    return await runStageWork(tenderId, stage, control, { runId, documentsRevisionId, configVersion });
  } catch (err) {
    // Прогон задания завершает onJobSettled (задача может быть повторена) —
    // здесь закрываем только свой, синхронный.
    if (ownsRun) await finalizeStageRun(tenderId, stage, runId, err);
    throw err;
  }
}

async function runStageWork(tenderId, stage, control, { runId, documentsRevisionId, configVersion }) {
  const state = await getStageState(tenderId);
  if (stage < 1 || stage > 5) throw badRequest('Допустимы стадии 1..5');
  if (!isStageRunnable(state, stage)) {
    throw badRequest(`Стадия ${stage} недоступна. Сначала завершите стадию ${stage - 1}.`);
  }
  // Все стадии 1–5 — LLM-агенты, требуют настроенного ключа.
  if (!isOpenAiConfigured()) {
    throw badRequest(`OPENAI_API_KEY не настроен на сервере. Стадия ${stage} (LLM-агент) недоступна.`);
  }
  if (stage === 2) {
    const qaCountRow = await db.queryOne('SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?', tenderId);
    let qaCount = Number(qaCountRow?.c || 0);
    if (!qaCount) {
      // qa_entries пуст — пробуем авто-импортировать из загруженного на вкладке
      // «Документация» Q&A-файла. Это типичный кейс: пользователь залил .xlsx,
      // но импорт по какой-то причине не отработал.
      const qaDoc = await db.queryOne(
        `SELECT * FROM documents
         WHERE tender_id = ? AND doc_type = 'qa'
         ORDER BY uploaded_at DESC LIMIT 1`,
        tenderId,
      );
      if (qaDoc?.file_path) {
        try {
          await importQaXlsx(tenderId, qaDoc.file_path);
          const recheck = await db.queryOne(
            'SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?',
            tenderId,
          );
          qaCount = Number(recheck?.c || 0);
        } catch (e) {
          // ignore — попадаем в ошибку ниже с исходным текстом
        }
      }
    }
    if (!qaCount) {
      throw badRequest('Загрузите Q&A форму (.xlsx) на вкладке «Документация» — без переписки стадия 2 не запускается.');
    }
  }

  const ctx = await buildContextForStage(tenderId, stage, { runId, configVersion });
  // Репортер прогресса по сегментам — runLlmStage зовёт setTotal/tick.
  // Пишется в строку задачи (analysis_tasks), а не в память процесса.
  // Мост может нести только прогон задания (без счётчика прогресса) — тогда
  // репортёра нет, а не «нет метода setTotal».
  ctx.progress = control && typeof control.setTotal === 'function'
    ? { setTotal: (n) => control.setTotal(n), tick: () => control.tick() }
    : null;
  // Чекпойнт по сегментам + кооперативная отмена (см. jobs/handlers/stageAnalysisJob).
  ctx.jobControl = control;
  const issues = await runStageOrchestrator(stage, ctx);

  // Гард зоны ответственности: стадия должна писать только в свой домен
  // (см. stageDomains). Backstop против регрессий — не теряем данные, но логируем.
  const offDomain = issues.filter((i) => i.problem_type && !isOwnedBy(stage, i.problem_type));
  if (offDomain.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[stageEngine] стадия ${stage}: ${offDomain.length} находок с чужим problem_type ` +
        `(${[...new Set(offDomain.map((i) => i.problem_type))].join(', ')}) — вне домена стадии.`,
    );
  }

  // Снимок стадии — это прогон runId, СОЗДАННЫЙ ДО оркестратора (см.
  // beginStageRun). Здесь он только наполняется и активируется: указатель
  // переводится по успеху (publishStageResult ниже), провал не архивирует
  // прежний актуальный прогон стадии.
  // Частичный результат (Стадия 5 QC: часть ТЗ не досчитана) — это НЕ полный
  // успех. Единый контракт результата: warning, а не completed. Добытчики 1–4
  // fail-loud (упавшая часть бросает и роняет весь прогон), поэтому partial у них
  // не возникает — только QC-стадия помечает себя частичной.
  // Источник истины — статус слоя self-analysis (он же несёт llm_status:
  // completed | completed_with_warnings | skipped | not_applicable); partial —
  // совместимый фолбэк. FAILED сюда не доходит: buildSelfAnalysis бросает.
  const sa = issues.selfAnalysis || null;
  const stageStatus = (sa && sa.status === STATUS.COMPLETED_WITH_WARNINGS) || (sa && sa.partial)
    ? STATUS.COMPLETED_WITH_WARNINGS
    : STATUS.COMPLETED;
  const summary = {
    stage,
    label: STAGE_LABELS[stage],
    status: stageStatus, // единый контракт результата (см. resultStatus)
    result_type: stageResultType(stage),
    issues_count: issues.length,
    off_domain: offDomain.length,
    by_criticality: countBy(issues, 'criticality'),
    by_problem_type: countBy(issues, 'problem_type'),
    notes: issues.analysisNote || null,
    // Как ТЗ было нарезано на части + итог межраздельной сверки (см. llmStage).
    segmentation: issues.segmentation || null,
    // Стадия 5 (QC) issues не порождает — несёт сводку self-analysis вместо них.
    self_analysis: issues.selfAnalysis || null,
  };

  // ПУБЛИКАЦИЯ СНИМКА — единственный production-путь: publishStageResult в ОДНОЙ
  // транзакции пишет issues, сигналы (для стадий 1–4 обязательны), закрывает
  // незавершённые части ТЗ, активирует прогон (прежний активный архивируется
  // тем же коммитом) и ПОСЛЕДНИМ шагом переводит стадию в 'reviewing'.
  // До коммита читатели видят прежний снимок и прежний статус; откат не
  // оставляет ни частичных строк, ни 'reviewing' без опубликованного снимка.
  // Раньше здесь было четыре независимых шага (issues+статус, затем сигналы
  // best-effort, затем части, затем активация) — сбой между ними оставлял
  // стадию «успешной» без опубликованного снимка.
  const publication = await db.transaction(async (tx) => {
    // Публикация переводит стадию строго 'running' → 'reviewing'. Фоновый путь
    // ставит 'running' при постановке в очередь; синхронный (внеочередной)
    // прогон мог стартовать из 'open'/'reviewing' — выравниваем ТОЙ ЖЕ
    // транзакцией: при откате публикации исходный статус вернётся.
    await tx.queryRun(
      `UPDATE tender_stage_state SET stage${stage}_status = 'running', current_stage = ?
        WHERE tender_id = ? AND stage${stage}_status <> 'running'`,
      stage, tenderId,
    );
    return publishStageResult({
      tx,
      tenderId,
      stage,
      analysisRunId: runId,
      issues,
      // Сигналы строятся из УЖЕ сохранённых находок этого прогона
      // (source_entity_id обязан ссылаться на их id); стадия 5 сигналов не
      // эмитит — publishStageResult пропускает шаг сам.
      signals: (records) => records,
      summary,
      documentsRevisionId,
      configVersion,
    });
  });

  return { runId, summary, publication };
}

// --- Сегменты стадии (части ТЗ) ------------------------------------------------

// Части ТЗ КОНКРЕТНОГО прогона стадии: что посчитано, что взято из кэша, что
// упало и почему. Источник — история выполнения (analysis_run_segments), а не
// кэш: у каждого прогона свой набор строк, и повтор стадии не затирает картину
// прошлого. Без runId — последний прогон, у которого история есть.
// runs[] — прогоны стадии со сводкой (история двух последовательных прогонов
// видна рядом, без раскопок в БД).
async function listStageSegments(tenderId, stage, { runId = null, limit = 10 } = {}) {
  const runs = await segmentStore.listSegmentRuns(tenderId, stage, { limit });
  const items = await segmentStore.listRunSegments(tenderId, stage, runId);
  const resolvedRunId = runId || (items.length ? items[0].analysis_run_id : (runs[0] && runs[0].id) || null);
  return {
    run_id: resolvedRunId,
    runs,
    items,
    summary: segmentStore.summarize(items),
  };
}

// Перезапуск ОДНОЙ части ТЗ. Гасим КЭШ этой части и ставим стадию в очередь:
// остальные части поднимутся из кэша (сверка по input_hash + config_version), в
// LLM уйдёт только этот сегмент. Так упавшая/сомнительная часть большого ТЗ
// пересчитывается за одну часть стоимости прогона. История прошлых прогонов при
// этом не трогается — новый прогон заведёт свою.
async function retryStageSegment(tenderId, stage, segmentIndex, opts = {}) {
  if (stage < 1 || stage > 5) throw badRequest('Допустимы стадии 1..5');
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    throw badRequest('Номер части должен быть целым числом ≥ 0');
  }
  const row = await segmentStore.getCacheSegment(tenderId, stage, segmentIndex);
  if (!row) {
    throw badRequest(
      `Часть №${segmentIndex + 1} стадии ${stage} не найдена. Сначала запустите анализ стадии — ` +
        'части ТЗ создаются при первом прогоне.',
    );
  }
  const state = await getStageState(tenderId);
  const cur = state[`stage${stage}_status`];
  if (cur === 'finished') {
    throw badRequest(
      `Стадия ${stage} уже завершена — пересчитать часть нельзя. Сбросьте стадию (reset) и запустите заново.`,
    );
  }
  if (cur === 'running') throw badRequest(`Стадия ${stage} сейчас считается — дождитесь завершения.`);
  if (!isStageRunnable(state, stage)) {
    throw badRequest(`Стадия ${stage} недоступна. Сначала завершите стадию ${stage - 1}.`);
  }

  await segmentStore.invalidateCache(tenderId, stage, segmentIndex);
  // Ключ идемпотентности включает номер части: повтор именно этой части не
  // схлопнется с обычным запуском стадии той же ревизии.
  const started = await startStageBackground(tenderId, stage, {
    ...opts,
    idempotencyKey:
      opts.idempotencyKey || `seg-retry:${tenderId}:${stage}:${segmentIndex}:${Date.now()}`,
  });
  return { ...started, stage, segment_index: segmentIndex, retried: true };
}

async function finishStage(tenderId, stage) {
  const state = await getStageState(tenderId);
  const cur = state[`stage${stage}_status`];
  if (cur === 'locked') throw badRequest('Стадия залочена');
  if (cur === 'finished') throw badRequest('Стадия уже завершена');
  if (cur === 'running') throw badRequest(`Стадия ${stage} ещё считается — дождитесь завершения.`);
  // Завершить стадию можно только после УСПЕШНОГО прогона (статус 'reviewing').
  // Провалившийся анализ возвращает статус в 'open' — такую стадию завершать
  // нельзя, иначе следующий гейт откроется по сбою (портал «отрапортует успех»).
  if (!canFinishStage(cur)) {
    throw badRequest(
      `Стадию ${stage} нельзя завершить: успешного анализа не было (статус «${cur}»). Запустите анализ заново.`,
    );
  }
  // Чистый гейт статусов: вход анализа неизменяем, решения инженера на текст
  // следующих стадий не влияют (влияние — через согласованную версию ТЗ).
  await db.transaction(async (tx) => {
    await setStageStatus(tenderId, stage, 'finished', tx);
    await unlockNextStage(tenderId, stage, tx);
  });
  return getStageState(tenderId);
}

// СБРОС СТАДИИ — операция УКАЗАТЕЛЕЙ И РАБОЧЕГО СОСТОЯНИЯ, а не удаление истории.
//
// Раньше reset физически удалял analysis_runs, issues, решения инженера и связанные
// исключения — история анализа исчезала безвозвратно, восстановить «что портал
// показывал вчера» было нечем, а журнал аудита ссылался на несуществующие строки.
// Теперь reset:
//   • снимает указатели актуальных stage-прогонов для стадий ≥ N и АРХИВИРУЕТ эти
//     прогоны (superseded_at) — строки, issues, signals и решения остаются в БД;
//   • снимает указатель pipeline: производный снимок собран из отозванных входов,
//     показывать его как актуальный итог нельзя (его слои тоже остаются в БД);
//   • возвращает workflow-состояние стадий (open / locked, current_stage);
//   • чистит ПРОЕКЦИИ, а не историю: analysis_segments (кэш частей);
//   • пишет событие в журнал аудита (что снято, что сохранено).
// Физическое удаление истории — только отдельной admin-командой
// (services/admin/purgeService.js).
// actor (опц.) — субъект из токена для записи аудита.
async function resetStage(tenderId, stage, { actor = null, requestId = null } = {}) {
  const outcome = await db.transaction(async (tx) => {
    // Что именно уводим из актуального состояния — фиксируем ДО изменений.
    const stageRunIds = [];
    for (let s = stage; s <= 5; s += 1) {
      // eslint-disable-next-line no-await-in-loop
      const id = await analysisRuns.getActiveStageRunId(tenderId, s, tx);
      if (id) stageRunIds.push({ stage: s, run_id: id });
    }
    const keptIssues = await tx.queryOne(
      'SELECT COUNT(*) AS c FROM issues WHERE tender_id = ? AND analysis_stage >= ?', tenderId, stage,
    );

    // Проекции (не история): КЭШ частей ТЗ.
    // analysis_run_segments (история выполнения частей по прогонам) НЕ трогаем —
    // это история наравне с analysis_runs/issues/signals/решениями.
    await tx.queryRun(
      'DELETE FROM analysis_segments WHERE tender_id = ? AND analysis_stage >= ?', tenderId, stage,
    );

    // Указатели: стадии ≥ N + производный pipeline-снимок. Прогоны архивируются,
    // но НЕ удаляются.
    await analysisRuns.clearStagePointers(tenderId, stage, tx);
    const archived = await analysisRuns.archiveStageRunsFrom(tenderId, stage, tx);
    const pipelineRunId = await analysisRuns.clearPipelinePointer(tenderId, tx);

    // Workflow-состояние.
    for (let s = stage; s <= 5; s += 1) {
      const status = s === stage ? 'open' : 'locked';
      // eslint-disable-next-line no-await-in-loop
      await tx.queryRun(`UPDATE tender_stage_state SET stage${s}_status = ? WHERE tender_id = ?`, status, tenderId);
    }
    await tx.queryRun('UPDATE tender_stage_state SET current_stage = ? WHERE tender_id = ?', stage, tenderId);

    return {
      from_stage: stage,
      cleared_stage_pointers: stageRunIds,
      archived_stage_runs: archived,
      cleared_pipeline_pointer: pipelineRunId,
      kept: {
        issues: Number((keptIssues && keptIssues.c) || 0),
        analysis_runs: true, signals: true, decisions: true, run_segments: true,
      },
    };
  });

  // Событие аудита: сброс — заметное действие над результатом анализа. Запись
  // best-effort (журнал не должен ронять уже выполненную операцию).
  await audit.record({
    requestId,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    actorEmail: actor && actor.email,
    actorRoles: actor && actor.roles,
    authMethod: actor && actor.authMethod,
    action: 'stage.reset',
    category: 'analysis',
    outcome: 'allowed',
    resourceType: 'stage',
    resourceId: String(stage),
    tenderId,
    reason: `сброс стадий ≥ ${stage}: сняты указатели, история сохранена`,
    meta: outcome,
  });

  return getStageState(tenderId);
}

async function listStageIssues(tenderId, stage, filters = {}) {
  // Только issues АКТУАЛЬНОГО stage-прогона (снимок); архивные не показываем.
  const stageRunId = await analysisRuns.getActiveStageRunId(tenderId, stage);
  if (!stageRunId) return [];
  let sql = `
    SELECT i.*, d.decision as decision_kind, d.final_comment as decision_comment, d.edited_redaction as decision_redaction, d.target_text as decision_target_text
    FROM issues i
    LEFT JOIN review_decisions d ON d.issue_id = i.id
    WHERE i.tender_id = ? AND i.analysis_stage = ? AND i.analysis_run_id = ?
  `;
  const params = [tenderId, stage, stageRunId];
  if (filters.criticality) { sql += ' AND i.criticality = ?'; params.push(filters.criticality); }
  if (filters.review_status) { sql += ' AND i.review_status = ?'; params.push(filters.review_status); }
  if (filters.problem_type) { sql += ' AND i.problem_type = ?'; params.push(filters.problem_type); }
  sql += ' ORDER BY i.criticality DESC, i.paragraph_index ASC, i.char_start ASC';
  return db.queryAll(sql, ...params);
}

// Исход ПОСЛЕДНЕЙ попытки стадии — включая ещё не завершённую (status='running'
// у прогона, который прямо сейчас считается) и неуспешную. Показывать вместо неё
// прошлый успех нельзя: портал отрапортовал бы вчерашний зелёный после
// сегодняшнего сбоя.
async function getStageRunSummary(tenderId, stage) {
  const run = await analysisRuns.getLatestStageRun(tenderId, stage);
  if (!run) return null;
  let summary = null;
  try { summary = run.summary ? JSON.parse(run.summary) : null; } catch (_e) { summary = null; }
  return { ...run, summary };
}

function countBy(arr, key) {
  const out = {};
  for (const i of arr) {
    const v = i[key] || '—';
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

module.exports = {
  STAGE_LABELS,
  // чистые функции контракта результата (офлайн-тесты)
  classifyStageRun,
  canFinishStage,
  getStageState,
  setStageStatus,
  isStageRunnable,
  runStage,
  runStageInner,
  // жизненный цикл прогона стадии
  beginStageRun,
  attachStageRunToJob,
  finalizeStageRun,
  runFailureStatus,
  failureSummary,
  releaseRunningStage,
  startStageBackground,
  listStageSegments,
  retryStageSegment,
  finishStage,
  resetStage,
  listStageIssues,
  getStageRunSummary,
  recoverOrphanedRunningStages,
  recoverOrphanedStageRuns,
};
