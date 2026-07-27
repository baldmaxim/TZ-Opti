'use strict';

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const {
  getActiveTzText,
  getDocumentByType,
  getTzMdDocument,
  computeRevisionId,
  nodeIdFor,
  hashText,
} = require('../tzActiveTextService');
const { parseMdToBlocks } = require('../mdParser');
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
const { writeSignalsForStage } = require('../signals/signalWriter');
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

async function buildContextForStage(tenderId, stage) {
  const {
    document: tzDoc, paragraphs, blocks, activeText, rawText, revisionId, missingMd,
  } = await getActiveTzText(tenderId, stage);
  if (missingMd || !tzDoc) {
    throw badRequest('Загрузите .md-копию ТЗ в слот «ТЗ → Markdown» — анализ ведётся только по .md.');
  }
  const ctx = {
    tenderId,
    sourceDocumentId: tzDoc.id,
    paragraphs,
    blocks,
    activeText,
    rawText,
    rawMd: rawText,
    documentRevisionId: revisionId,
    // Статус и результат КАЖДОЙ части ТЗ (analysis_segments): повтор стадии не
    // переспрашивает LLM про посчитанные части, а упавшую часть можно
    // перезапустить точечно (retryStageSegment).
    segmentStore: makeStageSegmentStore({
      tenderId, stage, revisionId, logTag: `stage${stage}_segments`,
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
// падает, прогон стадии становится failed через recordFailedRun.
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

// Неуспешный прогон стадии: фиксируем терминальный analysis_run (его увидит
// опрос статуса клиентом) и возвращаем статус стадии в исходное (re-runnable).
// Никогда не бросаем — это финализатор фоновой задачи.
// status: STATUS.FAILED (упал) | INTERRUPTED (оборван рестартом) | CANCELLED.
async function recordFailedRun(tenderId, stage, prevStatus, err, status = STATUS.FAILED) {
  const msg = (err && err.message) || 'неизвестная ошибка анализа';
  try {
    await db.queryRun(
      `INSERT INTO analysis_runs (id, tender_id, stage, started_at, finished_at, status, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      tenderId,
      stage,
      nowIso(),
      nowIso(),
      status === STATUS.FAILED ? 'failed' : status,
      JSON.stringify({ stage, label: STAGE_LABELS[stage], status, failed: true, error: msg }),
    );
    await releaseRunningStage(tenderId, stage, prevStatus);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[stageEngine] recordFailedRun сбой: ${e.message}`);
  }
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
  // Условно: воркер мог подхватить задание и увести стадию дальше ('reviewing')
  // раньше, чем сюда дойдёт управление, — тогда перетирать статус нельзя.
  if (!deduped) {
    await db.queryRun(
      `UPDATE tender_stage_state SET stage${stage}_status = 'running', current_stage = ?
        WHERE tender_id = ? AND stage${stage}_status = ?`,
      stage, tenderId, prevStatus,
    );
  }
  return { status: 'running', job_id: job.id, deduped: deduped || null };
}

// control (опц.) — мост к задаче очереди: прогресс по сегментам, чекпойнт
// (повтор продолжает с последнего готового сегмента) и кооперативная отмена.
async function runStageInner(tenderId, stage, control = null) {
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

  const ctx = await buildContextForStage(tenderId, stage);
  // Репортер прогресса по сегментам — runLlmStage зовёт setTotal/tick.
  // Пишется в строку задачи (analysis_tasks), а не в память процесса.
  ctx.progress = control
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

  // Неизменяемый снимок стадии: создаём НОВЫЙ stage-прогон (status='running').
  // Указатель переведём только по успеху (activateRun ниже) — провал не архивирует
  // прежний актуальный прогон стадии.
  const documentsRevisionId = await analysisRuns.currentDocumentsRevision(tenderId);
  const configVersion = analysisRuns.currentConfigVersion();
  const runId = await analysisRuns.beginRun(tenderId, analysisRuns.stageScope(stage), {
    stage, documentsRevisionId, configVersion,
  });
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

  // Связка issue.id ↔ находка — нужна слою signals (source_entity_id ниже).
  const issueRecords = [];

  await db.transaction(async (tx) => {
    // Неизменяемый снимок: pending прежнего прогона НЕ удаляем — прежний прогон
    // архивируется (activateRun ниже), новый несёт свои свежие issues. Строку
    // analysis_runs создал beginRun; здесь — только issues снимка.
    for (const issue of issues) {
      const issueId = newId();
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
        runId,
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
      issueRecords.push({ issueId, issue });
    }

    await setStageStatus(tenderId, stage, 'reviewing', tx);
  });

  // Параллельная запись слоя signals (новая архитектура анализа ТЗ).
  // Изолирована: best-effort writer со своей транзакцией и перехватом ошибок —
  // сбой signals НЕ влияет на уже закоммиченные issues и статус стадии.
  // Пишется ДО активации — снимок стадии материализуется целиком.
  await writeSignalsForStage({ tenderId, runId, stage, records: issueRecords });

  // Активируем снимок стадии: указатель переводится на новый прогон, прежний
  // актуальный прогон этой стадии архивируется (superseded_at). Чтения берут
  // только issues/signals актуальных stage-прогонов.
  await analysisRuns.activateRun(tenderId, analysisRuns.stageScope(stage), runId, {
    documentsRevisionId, configVersion, summary: JSON.stringify(summary),
  });

  return { runId, summary };
}

// --- Сегменты стадии (части ТЗ) ------------------------------------------------

// Список частей ТЗ этой стадии со статусом каждой: что посчитано, что упало и
// почему, сколько находок дала часть. Источник — analysis_segments.
async function listStageSegments(tenderId, stage) {
  const items = await segmentStore.listSegments(tenderId, stage);
  return { items, summary: segmentStore.summarize(items) };
}

// Перезапуск ОДНОЙ части ТЗ. Гасим сохранённый результат сегмента и ставим
// стадию в очередь: остальные части поднимутся из analysis_segments (сверка по
// input_hash), в LLM уйдёт только этот сегмент. Так упавшая/сомнительная часть
// большого ТЗ пересчитывается за одну часть стоимости прогона.
async function retryStageSegment(tenderId, stage, segmentIndex, opts = {}) {
  if (stage < 1 || stage > 5) throw badRequest('Допустимы стадии 1..5');
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    throw badRequest('Номер части должен быть целым числом ≥ 0');
  }
  const row = await segmentStore.getSegment(tenderId, stage, segmentIndex);
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

  await segmentStore.requestRetry(tenderId, stage, segmentIndex);
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
  // Применяем tz_excluded_ranges для решений delete / remove_from_scope.
  // Только issues АКТУАЛЬНОГО stage-прогона (архивные прогоны не влияют).
  const stageRunId = await analysisRuns.getActiveStageRunId(tenderId, stage);
  const closeIssues = stageRunId ? await db.queryAll(
    `
      SELECT i.*, d.decision, d.target_text FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.analysis_stage = ? AND i.analysis_run_id = ?
    `,
    tenderId,
    stage,
    stageRunId,
  ) : [];

  // Привязка исключений к КОНКРЕТНОЙ ревизии ТЗ: считаем revisionId текущего
  // документа и стабильные node_id / хэш текста по абзацу. Так исключения этой
  // версии не применятся к следующей загруженной версии ТЗ (см. getActiveTzText).
  const tzDoc = await getTzMdDocument(tenderId);
  const revisionId = tzDoc ? computeRevisionId(tzDoc) : null;
  const tzBlocks = tzDoc ? await parseMdToBlocks(tzDoc.extracted_text || '') : [];
  const blockByIndex = new Map(tzBlocks.map((b) => [b.index, b]));

  await db.transaction(async (tx) => {
    for (const issue of closeIssues) {
      const isDelete = issue.review_status === 'accepted'
        && (issue.decision === 'delete' || issue.decision === 'remove_from_scope');
      if (isDelete && issue.paragraph_index != null && issue.char_start != null && issue.char_end != null) {
        // Если инженер удалил только ПОДЧАСТЬ фрагмента — исключаем из активного
        // текста (для следующих стадий) ровно её, а не весь пункт.
        let cStart = issue.char_start;
        let cEnd = issue.char_end;
        const part = (issue.target_text || '').trim();
        if (part && issue.source_fragment) {
          const i = issue.source_fragment.indexOf(part);
          if (i !== -1) { cStart = issue.char_start + i; cEnd = cStart + part.length; }
        }
        // Стабильный id узла + хэш исходного (исключаемого) текста этой ревизии.
        const block = blockByIndex.get(issue.paragraph_index) || null;
        const nodeId = block ? nodeIdFor(block) : null;
        const fragText = block
          ? block.text.slice(Math.max(0, cStart), Math.max(0, cEnd))
          : (issue.source_fragment || '');
        const srcHash = hashText(fragText);
        await tx.queryRun(
          `
          INSERT INTO tz_excluded_ranges (
            id, tender_id, source_document_id, document_revision_id, node_id, source_text_hash,
            paragraph_index, char_start, char_end, after_stage, source_issue_id, stale, needs_confirmation, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        `,
          newId(),
          tenderId,
          issue.source_document_id || null,
          revisionId,
          nodeId,
          srcHash,
          issue.paragraph_index,
          cStart,
          cEnd,
          stage,
          issue.id,
          nowIso(),
        );
      }
    }
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
//   • чистит ПРОЕКЦИИ, а не историю: tz_excluded_ranges (исключения из активного
//     текста — иначе текст остался бы урезанным) и analysis_segments (кэш частей);
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

    // Проекции (не история): исключения из активного текста и кэш частей ТЗ.
    await tx.queryRun('DELETE FROM tz_excluded_ranges WHERE tender_id = ? AND after_stage >= ?', tenderId, stage);
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
      kept: { issues: Number((keptIssues && keptIssues.c) || 0), analysis_runs: true, signals: true, decisions: true },
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

async function getStageRunSummary(tenderId, stage) {
  const run = await db.queryOne(
    'SELECT * FROM analysis_runs WHERE tender_id = ? AND stage = ? ORDER BY started_at DESC LIMIT 1',
    tenderId,
    stage,
  );
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
  recordFailedRun,
  releaseRunningStage,
  startStageBackground,
  listStageSegments,
  retryStageSegment,
  finishStage,
  resetStage,
  listStageIssues,
  getStageRunSummary,
  recoverOrphanedRunningStages,
};
