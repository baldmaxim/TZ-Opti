'use strict';

// Реестр прогонов анализа (analysis runs) — ядро неизменяемых снимков.
//
// Каждый анализ = снимок с analysis_run_id. Два уровня (kind):
//   • 'stage'    — снимок одной стадии (issues + analysis_signals). scope 'stage:N'.
//   • 'pipeline' — снимок производных слоёв (draft_issues → issue_reviews →
//                  issue_clusters → self_analysis_results + review_decisions),
//                  собранный из АКТУАЛЬНЫХ stage-прогонов. scope 'pipeline'.
//
// Для комбинации (тендер + scope + ревизия документов + версия конфигурации)
// есть указатель актуального прогона — таблица analysis_active_runs. Чтения берут
// ТОЛЬКО прогоны из указателей (согласованный набор). Пересборка НЕ удаляет старые
// строки: создаёт новый прогон (beginRun), по успеху переводит указатель и
// архивирует прежний (activateRun, superseded_at). Инвариант: указатель всегда
// показывает на completed-прогон; провал повторного прогона не архивирует прежний.
//
// Решения инженера переносятся между прогонами ТОЛЬКО явно: listCarryOverProposals
// сопоставляет, confirmCarryOvers подтверждает. Авто-переноса нет.

const crypto = require('crypto');
const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { computeRevisionId } = require('../tzActiveTextService');

const SCOPE_PIPELINE = 'pipeline';
const stageScope = (stage) => `stage:${stage}`;

// --- Чистое ядро (детерминированное, офлайн-тесты) ---------------------------

function sha1(s) {
  return crypto.createHash('sha1').update(String(s == null ? '' : s)).digest('hex');
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Ревизия НАБОРА документов тендера: детерминированный хэш по ревизиям всех
// документов (computeRevisionId у каждого), отсортированным для стабильности.
// Любая загрузка/изменение любого документа тендера меняет результат.
function computeDocumentsRevision(docs) {
  const revs = (docs || []).map((d) => computeRevisionId(d)).filter(Boolean).sort();
  if (!revs.length) return 'docs_empty';
  return `docs_${sha1(revs.join('|')).slice(0, 24)}`;
}

// Версия конфигурации анализа: то, что меняет смысл вывода при том же тексте —
// варианты промтов стадий + модель + температура. Из env (дефолты — как в
// stageNPrompts/openaiClient). Детерминирована.
const PROMPT_VARIANT_KEYS = [
  'STAGE1_PROMPT_VARIANT', 'STAGE2_PROMPT_VARIANT', 'STAGE3_PROMPT_VARIANT',
  'STAGE4_PROMPT_VARIANT', 'STAGE5_PROMPT_VARIANT',
];
function computeConfigVersion(env = {}) {
  const parts = PROMPT_VARIANT_KEYS.map((k) => `${k}=${env[k] || 'structural'}`);
  parts.push(`OPENAI_MODEL=${env.OPENAI_MODEL || 'gpt-4o'}`);
  parts.push(`TEMPERATURE=${env.OPENAI_TEMPERATURE || '0.2'}`);
  return `cfg_${sha1(parts.join(';')).slice(0, 16)}`;
}

// Run-scoped id кластера: включает runId, поэтому кластеры разных прогонов НЕ
// сталкиваются по id и решения прошлого прогона НЕ приклеиваются автоматически
// (перенос — только явный).
function clusterRunId(tenderId, runId, key) {
  return `clu_${sha1(`${tenderId}::${runId || ''}::${key}`).slice(0, 24)}`;
}

// Согласованный набор актуальных прогонов: id из указателей, чей прогон не
// архивирован (superseded_at пуст). Чтения берут только эти прогоны.
function selectActiveRunIds(runs, pointers) {
  const bySuperseded = new Map((runs || []).map((r) => [r.id, r.superseded_at]));
  const out = new Set();
  for (const p of pointers || []) {
    const id = p && p.analysis_run_id;
    if (!id) continue;
    const sup = bySuperseded.has(id) ? bySuperseded.get(id) : null;
    if (sup == null || sup === '') out.add(id);
  }
  return out;
}

// Сопоставление решений прошлого прогона с кластерами нового (для переноса).
// Для каждого решения лучший кластер: точное по cluster_key → по месту
// (tz_clause) → по тексту фрагмента. Ничего не подтверждает — только предлагает.
function matchDecisionsToClusters(oldDecisions, newClusters) {
  const byKey = new Map();
  const byClause = new Map();
  const byFrag = new Map();
  for (const c of newClusters || []) {
    if (c.cluster_key && !byKey.has(c.cluster_key)) byKey.set(c.cluster_key, c);
    const clause = norm(c.tz_clause);
    if (clause && !byClause.has(clause)) byClause.set(clause, c);
    const frag = norm(c.source_fragment);
    if (frag && !byFrag.has(frag)) byFrag.set(frag, c);
  }
  const proposals = [];
  for (const d of oldDecisions || []) {
    let cluster = null;
    let match = 'none';
    let confidence = 0;
    if (d.cluster_key && byKey.has(d.cluster_key)) {
      cluster = byKey.get(d.cluster_key); match = 'exact'; confidence = 1;
    } else if (norm(d.tz_clause) && byClause.has(norm(d.tz_clause))) {
      cluster = byClause.get(norm(d.tz_clause)); match = 'place'; confidence = 0.6;
    } else if (norm(d.source_fragment) && byFrag.has(norm(d.source_fragment))) {
      cluster = byFrag.get(norm(d.source_fragment)); match = 'text'; confidence = 0.5;
    }
    proposals.push({ decision: d, cluster_id: cluster ? cluster.id : null, cluster, match, confidence });
  }
  // Конфликт: несколько решений претендуют на один новый кластер.
  const countByCluster = new Map();
  for (const p of proposals) {
    if (p.cluster_id) countByCluster.set(p.cluster_id, (countByCluster.get(p.cluster_id) || 0) + 1);
  }
  for (const p of proposals) {
    if (p.cluster_id && countByCluster.get(p.cluster_id) > 1) p.conflict = true;
  }
  return proposals;
}

// Гарантия отсутствия дублей в экспорте: одна строка на место (cluster_id, иначе
// абзац+диапазон). Первая по порядку побеждает.
function dedupeExportRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = r.cluster_id || r.id
      || `${r.paragraph_index ?? ''}:${r.char_start ?? ''}:${r.char_end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// --- DB-обвязка --------------------------------------------------------------

// exec(tx) — исполнитель: транзакция или общий db. Позволяет вызывать хелперы
// как внутри чужой транзакции (движок стадий), так и самостоятельно.
const exec = (tx) => tx || db;

// Создать прогон (status='running'). НЕ трогает указатель/архивацию — активация
// отдельным шагом (activateRun) после успеха. Возвращает runId.
// opts.inputsManifest — зафиксированный набор входов (для pipeline-прогона: какие
// именно stage-прогоны взяты, см. pipeline/pipelineManifest.js). Хранится в строке
// прогона, потому что конвейер может собираться очередью в НЕСКОЛЬКО процессов:
// финализатор обязан судить по тому же набору, что зафиксировал старт.
async function beginRun(tenderId, scope, opts = {}, tx) {
  const e = exec(tx);
  const runId = newId();
  const kind = opts.kind || (scope === SCOPE_PIPELINE ? 'pipeline' : 'stage');
  const manifest = opts.inputsManifest
    ? (typeof opts.inputsManifest === 'string' ? opts.inputsManifest : JSON.stringify(opts.inputsManifest))
    : null;
  await e.queryRun(
    `INSERT INTO analysis_runs
       (id, tender_id, stage, kind, documents_revision_id, config_version, started_at, status, inputs_manifest)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    runId, tenderId, opts.stage ?? null, kind,
    opts.documentsRevisionId ?? null, opts.configVersion ?? null, nowIso(), manifest,
  );
  return runId;
}

// НЕИЗМЕНЯЕМОСТЬ СНИМКОВ — страж уровня сервиса.
//
// Писать можно ТОЛЬКО в свой незавершённый прогон-кандидат: status='running' и не
// архивирован. Прогон, ставший completed (а тем более архивированный), — история:
// на него уже смотрят экспорт, решения инженера и отчёты, поэтому DELETE+INSERT в
// нём подменял бы уже выданный результат. Раньше эта дыра была открыта: build*
// без runId получал АКТИВНЫЙ прогон через ensurePipelineRun и перезаписывал его.
//
// tx (обязателен для записи): проверка идёт SELECT … FOR UPDATE, поэтому
// одновременная активация (activateRun меняет ту же строку) ждёт коммита
// строителя — «проверил и пишу» атомарно, а не «проверил, потом кто-то активировал».
function runNotWritable(runId, reason) {
  const err = new Error(`Запись в снимок ${runId} запрещена: ${reason}`);
  err.status = 409;
  err.code = 'RUN_NOT_WRITABLE';
  err.retryable = false;
  return err;
}

async function assertRunWritable(tenderId, runId, { kind = null } = {}, tx) {
  if (!runId) {
    const err = new Error('Запись слоя без analysis_run_id запрещена: нужен прогон-кандидат');
    err.status = 500;
    err.code = 'RUN_ID_REQUIRED';
    throw err;
  }
  const e = exec(tx);
  const row = await e.queryOne(
    `SELECT id, tender_id, kind, status, superseded_at FROM analysis_runs WHERE id = ?${tx ? ' FOR UPDATE' : ''}`,
    runId,
  );
  if (!row) throw runNotWritable(runId, 'прогон не найден');
  if (tenderId && row.tender_id !== tenderId) throw runNotWritable(runId, 'прогон принадлежит другому тендеру');
  if (kind && row.kind !== kind) throw runNotWritable(runId, `ожидался прогон kind='${kind}', а не '${row.kind}'`);
  if (row.superseded_at) throw runNotWritable(runId, 'снимок архивирован (superseded) — история неизменяема');
  if (row.status !== 'running') {
    throw runNotWritable(runId, `снимок уже завершён (status='${row.status}') — история неизменяема`);
  }
  return row;
}

// Новый ПРОГОН-КАНДИДАТ: пустой снимок со status='running', на который НЕ
// переведён указатель. Единственный законный адресат записи слоёв. Активируется
// только после полного успешного завершения сборки (activateRun) — до тех
// пор ни одно чтение портала его не видит.
// reason — кто и зачем начал (в summary прогона: видно происхождение снимка).
async function beginCandidateRun(tenderId, opts = {}, tx) {
  const scope = opts.scope || SCOPE_PIPELINE;
  const documentsRevisionId = opts.documentsRevisionId !== undefined
    ? opts.documentsRevisionId : await currentDocumentsRevision(tenderId, tx);
  const configVersion = opts.configVersion !== undefined ? opts.configVersion : currentConfigVersion();
  const runId = await beginRun(tenderId, scope, {
    kind: opts.kind, stage: opts.stage,
    documentsRevisionId, configVersion,
    inputsManifest: opts.inputsManifest || null,
  }, tx);
  if (opts.reason) {
    await exec(tx).queryRun(
      'UPDATE analysis_runs SET summary = ? WHERE id = ?',
      JSON.stringify({ candidate: true, reason: opts.reason }), runId,
    );
  }
  return runId;
}

// Зафиксированный набор входов прогона (JSON → объект). null, если не писался.
async function getRunInputsManifest(runId, tx) {
  const row = await exec(tx).queryOne('SELECT inputs_manifest FROM analysis_runs WHERE id = ?', runId);
  const raw = row && row.inputs_manifest;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// Строка прогона целиком: статус, времена, сохранённый в summary исход. Нужна
// отчётам и статусу конвейера — зафиксированный при завершении результат читается
// из БД, а не восстанавливается по косвенным признакам.
async function getRun(runId, tx) {
  if (!runId) return null;
  return exec(tx).queryOne(
    `SELECT id, tender_id, stage, kind, documents_revision_id, config_version,
            started_at, finished_at, status, summary, superseded_at
       FROM analysis_runs WHERE id = ?`,
    runId,
  );
}

// Последний прогон ОРКЕСТРАТОРА конвейера — независимо от указателя. Нужен, чтобы
// после перезагрузки страницы (и после рестарта процесса) показать тот же исход,
// который был зафиксирован при завершении, в том числе НЕуспешный: провалившийся
// прогон указателем не становится, и по analysis_active_runs его не найти.
// Прогоны-кандидаты одиночных build* сюда не попадают: manifest входов пишет
// только beginPipelineRun (см. pipeline/pipelineManifest.js).
async function getLatestPipelineRun(tenderId, tx) {
  return exec(tx).queryOne(
    `SELECT id, tender_id, kind, documents_revision_id, config_version,
            started_at, finished_at, status, summary, superseded_at
       FROM analysis_runs
      WHERE tender_id = ? AND kind = 'pipeline' AND inputs_manifest IS NOT NULL
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    tenderId,
  );
}

// Входы конвейера: на каждую обязательную стадию — АКТУАЛЬНЫЙ снимок (указатель)
// и id САМОГО СВЕЖЕГО прогона стадии. Второе критично: если после успешного
// прогона стадию гоняли снова и она упала, указатель остался на старом снимке —
// собирать итог из него нельзя (см. VIOLATION.STAGE_POINTER_STALE).
async function collectStageInputs(tenderId, stages = [1, 2, 3, 4], tx) {
  const e = exec(tx);
  const pointers = await e.queryAll(
    `SELECT scope, analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope LIKE 'stage:%'`,
    tenderId,
  );
  const activeByStage = new Map();
  for (const p of pointers) {
    const n = Number(String(p.scope).split(':')[1]);
    if (Number.isFinite(n) && p.analysis_run_id) activeByStage.set(n, p.analysis_run_id);
  }
  // Самый свежий прогон каждой стадии (в т.ч. failed/interrupted/running).
  const latest = await e.queryAll(
    `SELECT DISTINCT ON (stage) stage, id, status, started_at
       FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage IS NOT NULL
      ORDER BY stage, started_at DESC, id DESC`,
    tenderId,
  );
  const latestByStage = new Map(latest.map((r) => [Number(r.stage), r]));

  const activeIds = [...activeByStage.values()];
  let runsById = new Map();
  if (activeIds.length) {
    const ph = activeIds.map(() => '?').join(', ');
    const rows = await e.queryAll(
      `SELECT id, stage, status, documents_revision_id, config_version, superseded_at, started_at
         FROM analysis_runs WHERE id IN (${ph})`,
      ...activeIds,
    );
    runsById = new Map(rows.map((r) => [r.id, r]));
  }

  return stages.map((stage) => {
    const n = Number(stage);
    const activeId = activeByStage.get(n) || null;
    const latestRow = latestByStage.get(n) || null;
    return {
      stage: n,
      active_run_id: activeId,
      latest_run_id: latestRow ? latestRow.id : null,
      latest_status: latestRow ? latestRow.status : null,
      run: activeId ? (runsById.get(activeId) || null) : null,
    };
  });
}

// Число реально затронутых строк (pg → rowCount, sqlite-совместимо → changes).
const affectedRows = (res) => (res && (res.changes ?? res.rowCount)) || 0;

function activationError(message, code = 'RUN_ACTIVATION_FAILED') {
  const err = new Error(`Активация прогона не выполнена: ${message}`);
  err.code = code;
  err.status = 409;
  err.retryable = false;
  return err;
}

// Активировать прогон по успеху: архивировать прежний актуальный прогон этого
// scope (superseded_at), перевести указатель на runId, пометить прогон completed.
//
// tx (опц.) — транзакция вызывающего: тогда ВСЕ запросы идут через неё, своей
// транзакции функция не открывает и ни commit, ни rollback не делает — снимок
// публикуется и активируется одним коммитом вызывающего.
//
// КРИТИЧЕСКИЕ UPDATE проверяются по rowCount: «перевёл указатель, а строки не
// было» — это молчаливая потеря активации, худший исход из возможных (портал
// покажет успех, читать будет прежний снимок). Возвращает счётчики шагов.
async function activateRun(tenderId, scope, runId, opts = {}, tx) {
  const e = exec(tx);
  const now = nowIso();
  const prev = await e.queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = ?`,
    tenderId, scope,
  );
  const previousRunId = prev && prev.analysis_run_id && prev.analysis_run_id !== runId
    ? prev.analysis_run_id
    : null;
  let previousSuperseded = 0;
  if (previousRunId) {
    // Не критично: 0 строк = прежний прогон уже был архивирован кем-то другим.
    previousSuperseded = affectedRows(await e.queryRun(
      `UPDATE analysis_runs SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`,
      now, previousRunId,
    ));
  }
  const runUpdated = affectedRows(await e.queryRun(
    `UPDATE analysis_runs
        SET status = 'completed', finished_at = ?,
            summary = COALESCE(?, summary),
            documents_revision_id = COALESCE(?, documents_revision_id),
            config_version = COALESCE(?, config_version)
      WHERE id = ?`,
    now, opts.summary ?? null, opts.documentsRevisionId ?? null, opts.configVersion ?? null, runId,
  ));
  if (runUpdated !== 1) {
    throw activationError(
      `строка прогона ${runId} не обновлена (затронуто строк: ${runUpdated})`,
      'RUN_ACTIVATION_RUN_NOT_UPDATED',
    );
  }
  const pointerUpdated = affectedRows(await e.queryRun(
    `INSERT INTO analysis_active_runs
       (tender_id, scope, documents_revision_id, config_version, analysis_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tender_id, scope) DO UPDATE SET
       documents_revision_id = EXCLUDED.documents_revision_id,
       config_version = EXCLUDED.config_version,
       analysis_run_id = EXCLUDED.analysis_run_id,
       updated_at = EXCLUDED.updated_at`,
    tenderId, scope, opts.documentsRevisionId ?? null, opts.configVersion ?? null, runId, now,
  ));
  if (pointerUpdated !== 1) {
    throw activationError(
      `указатель ${scope} не переведён на прогон ${runId} (затронуто строк: ${pointerUpdated})`,
      'RUN_ACTIVATION_POINTER_NOT_MOVED',
    );
  }
  return {
    run_id: runId,
    scope,
    run_updated: runUpdated,
    pointer_updated: pointerUpdated,
    previous_run_id: previousRunId,
    previous_superseded: previousSuperseded,
    activated_at: now,
  };
}

// Завершить прогон БЕЗ активации: строка помечается completed и СРАЗУ
// архивируется (superseded_at), указатель НЕ двигается. Это режим debug-сборки:
// слои посчитаны и доступны по своему analysis_run_id для отладки, но ни одно
// чтение портала их не видит — актуальным остаётся прежний снимок.
async function completeRunWithoutActivation(runId, opts = {}, tx) {
  const e = exec(tx);
  const now = nowIso();
  await e.queryRun(
    `UPDATE analysis_runs
        SET status = 'completed', finished_at = ?,
            summary = COALESCE(?, summary),
            superseded_at = COALESCE(superseded_at, ?)
      WHERE id = ?`,
    now, opts.summary ?? null, now, runId,
  );
}

// Пометить прогон как проваленный. Указатель НЕ трогаем — прежний актуальный
// прогон остаётся активным.
async function failRun(runId, summary, tx) {
  const e = exec(tx);
  await e.queryRun(
    `UPDATE analysis_runs SET status = 'failed', finished_at = ?, summary = COALESCE(?, summary) WHERE id = ?`,
    nowIso(), summary ?? null, runId,
  );
}

// ЗАВЕРШИТЬ ТОТ ЖЕ ПРОГОН неуспешно — вместо отдельной «фиктивной» строки.
//
// Прогон создаётся ДО работы (status='running', реальные started_at / ревизия /
// версия конфигурации), поэтому его исход обязан быть записан В НЕГО ЖЕ: провал,
// отмена или обрыв — это состояние начатого прогона, а не новый прогон.
// Раньше движок стадий вставлял после ошибки ВТОРУЮ строку analysis_runs с
// started_at = finished_at = «сейчас», без ревизии и версии конфигурации: по
// такой записи нельзя было ни узнать, сколько шёл анализ, ни на каких входах он
// упал, а настоящий прогон (если он всё же создавался) навсегда оставался
// 'running'.
//
// Условие `status = 'running'` делает вызов идемпотентным и безопасным при гонке
// «финализатор задания против самого прогона»: побеждает тот, кто пришёл первым,
// второй ничего не перезаписывает. Возвращает true, если статус реально изменён.
const TERMINAL_RUN_STATUS = new Set(['failed', 'cancelled', 'interrupted']);

async function finalizeRun(runId, { status = 'failed', summary = null, finishedAt = null } = {}, tx) {
  if (!runId) return false;
  if (!TERMINAL_RUN_STATUS.has(status)) {
    throw new Error(`finalizeRun: недопустимый терминальный статус «${status}»`);
  }
  const res = await exec(tx).queryRun(
    `UPDATE analysis_runs
        SET status = ?, finished_at = ?, summary = COALESCE(?, summary)
      WHERE id = ? AND status = 'running'`,
    status, finishedAt || nowIso(),
    summary == null ? null : (typeof summary === 'string' ? summary : JSON.stringify(summary)),
    runId,
  );
  return Boolean((res && (res.changes ?? res.rowCount)) || 0);
}

// Осиротевшие прогоны стадии: у (тендер + стадия) начат НОВЫЙ прогон, а прежний
// так и остался 'running' (процесс умер между попытками задачи). Оставлять их
// «вечно бегущими» нельзя — история стадии должна состоять из завершённых
// прогонов. Закрываем их как interrupted с реальными временами.
async function interruptStaleStageRuns(tenderId, stage, { exceptRunId = null, reason = null } = {}, tx) {
  const res = await exec(tx).queryRun(
    `UPDATE analysis_runs
        SET status = 'interrupted', finished_at = ?,
            summary = json_build_object(
              'stage', stage, 'status', 'interrupted', 'error', ?::text,
              'started_at', started_at, 'finished_at', ?::text)::text
      WHERE tender_id = ? AND kind = 'stage' AND stage = ? AND status = 'running'
        AND id <> COALESCE(?::text, '')
      RETURNING id`,
    nowIso(),
    reason || 'прогон оборван: у стадии начат новый прогон',
    nowIso(), tenderId, stage, exceptRunId,
  );
  return ((res && res.rows) || []).map((r) => r.id);
}

// Глобальное восстановление после падения/рестарта (зовётся на старте сервера и
// воркера, рядом с recoverOrphanedRunningStages). Прогон стадии в статусе
// 'running', за которым НЕ стоит ни одного живого задания очереди, — оборванный:
// его никто не досчитает и никто не завершит. Живое задание (queued|running)
// защищает прогон, который прямо сейчас ведёт воркер в другом процессе.
// tenderId (опц.) — ограничить восстановление одним тендером (тесты, ручная
// починка). По умолчанию — вся база: это старт процесса.
async function recoverOrphanedStageRuns({ tenderId = null } = {}) {
  const res = await db.queryRun(
    `UPDATE analysis_runs r
        SET status = 'interrupted', finished_at = ?,
            summary = json_build_object(
              'stage', r.stage, 'status', 'interrupted',
              'error', 'прогон оборван (рестарт сервера / потеря воркера)',
              'started_at', r.started_at, 'finished_at', ?::text)::text
      WHERE r.kind = 'stage' AND r.status = 'running' AND r.stage IS NOT NULL
        AND (?::text IS NULL OR r.tender_id = ?::text)
        AND NOT EXISTS (
          SELECT 1 FROM analysis_jobs j
           WHERE j.tender_id = r.tender_id
             AND j.scope_key = 'stage:' || r.stage
             AND j.status IN ('queued', 'running'))
      RETURNING id`,
    nowIso(), nowIso(), tenderId, tenderId,
  );
  const ids = ((res && res.rows) || []).map((r) => r.id);
  if (ids.length) {
    // eslint-disable-next-line no-console
    console.log(`[analysisRuns] оборванных прогонов стадий закрыто: ${ids.length} → interrupted`);
  }
  return ids;
}

// Последний по времени прогон стадии — независимо от указателя и статуса.
// Карточка стадии показывает исход ПОСЛЕДНЕЙ попытки, а не последнего успеха.
async function getLatestStageRun(tenderId, stage, tx) {
  return exec(tx).queryOne(
    `SELECT id, tender_id, stage, kind, documents_revision_id, config_version,
            started_at, finished_at, status, summary, superseded_at
       FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage = ?
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    tenderId, stage,
  );
}

// Прогоны стадии (новые сверху) — история попыток для debug-страницы частей ТЗ.
async function listStageRuns(tenderId, stage, { limit = 10 } = {}) {
  return db.queryAll(
    `SELECT id, stage, status, started_at, finished_at, documents_revision_id, config_version, superseded_at
       FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage = ?
      ORDER BY started_at DESC, id DESC LIMIT ?`,
    tenderId, stage, Math.min(50, Math.max(1, Number(limit) || 10)),
  );
}

async function getActiveRunId(tenderId, scope, tx) {
  const row = await exec(tx).queryOne(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope = ?`,
    tenderId, scope,
  );
  return row ? row.analysis_run_id : null;
}
const getActivePipelineRunId = (tenderId, tx) => getActiveRunId(tenderId, SCOPE_PIPELINE, tx);
const getActiveStageRunId = (tenderId, stage, tx) => getActiveRunId(tenderId, stageScope(stage), tx);

async function getActiveStageRunIds(tenderId, tx) {
  const rows = await exec(tx).queryAll(
    `SELECT analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope LIKE 'stage:%'`,
    tenderId,
  );
  return rows.map((r) => r.analysis_run_id).filter(Boolean);
}

// Готовый фрагмент WHERE для скоупа таблицы `issues` (legacy issue-путь) по
// АКТУАЛЬНЫМ stage-прогонам. Возвращает { sql, params } для вставки в конец WHERE
// (перед ORDER BY) с добавлением params в конец списка. Нет активных прогонов →
// заведомо ложное условие (снимок пуст).
async function issuesRunFilter(tenderId, alias = 'i') {
  const ids = await getActiveStageRunIds(tenderId);
  if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
  const ph = ids.map(() => '?').join(', ');
  return { sql: ` AND ${alias}.analysis_run_id IN (${ph})`, params: ids };
}

// Снять указатели scope 'stage:N' для stage >= from (используется resetStage).
async function clearStagePointers(tenderId, fromStage, tx) {
  const e = exec(tx);
  const rows = await e.queryAll(
    `SELECT scope, analysis_run_id FROM analysis_active_runs WHERE tender_id = ? AND scope LIKE 'stage:%'`,
    tenderId,
  );
  for (const r of rows) {
    const n = Number(String(r.scope).split(':')[1]);
    if (Number.isFinite(n) && n >= fromStage) {
      await e.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ? AND scope = ?', tenderId, r.scope);
    }
  }
}

// Текущие ревизия документов / версия конфигурации тендера (для beginRun/activate).
async function currentDocumentsRevision(tenderId, tx) {
  const docs = await exec(tx).queryAll(
    'SELECT id, version, extracted_text FROM documents WHERE tender_id = ?', tenderId,
  );
  return computeDocumentsRevision(docs);
}
const currentConfigVersion = () => computeConfigVersion(process.env);

// ВНИМАНИЕ: функции ensurePipelineRun здесь БОЛЬШЕ НЕТ и возвращать её нельзя.
// Она отдавала АКТИВНЫЙ pipeline-прогон (а если его не было — создавала и сразу
// активировала пустой), и любой build* без runId писал DELETE+INSERT прямо в
// действующий снимок. Вместо неё: beginCandidateRun (адресат записи) +
// activateRun строго после полного успеха сборки.

// Архивировать stage-прогоны сброшенных стадий (>= fromStage): строки остаются
// (история не удаляется), но перестают быть «актуальными» — snapshot не выглядит
// живым после снятия указателя. Возвращает id архивированных прогонов.
async function archiveStageRunsFrom(tenderId, fromStage, tx) {
  const e = exec(tx);
  const rows = await e.queryAll(
    `SELECT id FROM analysis_runs
      WHERE tender_id = ? AND kind = 'stage' AND stage >= ? AND superseded_at IS NULL`,
    tenderId, fromStage,
  );
  if (rows.length) {
    const ph = rows.map(() => '?').join(', ');
    await e.queryRun(
      `UPDATE analysis_runs SET superseded_at = ? WHERE id IN (${ph})`,
      nowIso(), ...rows.map((r) => r.id),
    );
  }
  return rows.map((r) => r.id);
}

// Снять указатель pipeline (производный снимок): его входы отозваны, показывать
// его как актуальный итог — врать. Строка прогона и его слои остаются в БД.
async function clearPipelinePointer(tenderId, tx) {
  const e = exec(tx);
  const prev = await getActiveRunId(tenderId, SCOPE_PIPELINE, tx);
  if (!prev) return null;
  await e.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ? AND scope = ?', tenderId, SCOPE_PIPELINE);
  await e.queryRun(
    'UPDATE analysis_runs SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL',
    nowIso(), prev,
  );
  return prev;
}

// --- Перенос решений (явное сопоставление + подтверждение) -------------------

// Предложения переноса: решения последнего АРХИВНОГО pipeline-прогона,
// сопоставленные с ОТКРЫТЫМИ (ещё не решёнными) кластерами АКТУАЛЬНОГО прогона.
async function listCarryOverProposals(tenderId) {
  const activeRunId = await getActivePipelineRunId(tenderId);
  if (!activeRunId) return { active_run_id: null, from_run_id: null, proposals: [] };

  const prevRun = await db.queryOne(
    `SELECT id FROM analysis_runs
      WHERE tender_id = ? AND kind = 'pipeline' AND superseded_at IS NOT NULL AND id <> ?
      ORDER BY superseded_at DESC LIMIT 1`,
    tenderId, activeRunId,
  );
  if (!prevRun) return { active_run_id: activeRunId, from_run_id: null, proposals: [] };

  const oldDecisions = await db.queryAll(
    `SELECT rd.*, c.tz_clause AS tz_clause, c.cluster_title AS cluster_title
       FROM review_decisions rd
       LEFT JOIN issue_clusters c ON c.id = rd.cluster_id
      WHERE rd.analysis_run_id = ? AND rd.cluster_id IS NOT NULL AND rd.decision <> 'reject'`,
    prevRun.id,
  );
  const newClusters = await db.queryAll(
    `SELECT c.*,
            (SELECT d.source_fragment FROM issue_cluster_items ci
               JOIN draft_issues d ON d.id = ci.draft_issue_id
              WHERE ci.cluster_id = c.id AND ci.item_role = 'primary' LIMIT 1) AS source_fragment
       FROM issue_clusters c
      WHERE c.tender_id = ? AND c.analysis_run_id = ?`,
    tenderId, activeRunId,
  );
  const decided = await db.queryAll(
    `SELECT cluster_id FROM review_decisions WHERE analysis_run_id = ? AND cluster_id IS NOT NULL`,
    activeRunId,
  );
  const decidedSet = new Set(decided.map((r) => r.cluster_id));
  const openClusters = newClusters.filter((c) => !decidedSet.has(c.id));

  const proposals = matchDecisionsToClusters(oldDecisions, openClusters).filter((p) => p.cluster_id);
  return { active_run_id: activeRunId, from_run_id: prevRun.id, proposals };
}

// Подтвердить перенос выбранных решений в АКТУАЛЬНЫЙ прогон.
// selections: [{ decision_id (из прошлого прогона), cluster_id (актуального) }].
async function confirmCarryOvers(tenderId, selections) {
  const activeRunId = await getActivePipelineRunId(tenderId);
  if (!activeRunId) return { applied: 0, active_run_id: null };
  let applied = 0;
  await db.transaction(async (tx) => {
    for (const sel of selections || []) {
      if (!sel || !sel.decision_id || !sel.cluster_id) continue;
      const old = await tx.queryOne('SELECT * FROM review_decisions WHERE id = ?', sel.decision_id);
      if (!old) continue;
      const cluster = await tx.queryOne(
        'SELECT cluster_key FROM issue_clusters WHERE id = ? AND tender_id = ? AND analysis_run_id = ?',
        sel.cluster_id, tenderId, activeRunId,
      );
      if (!cluster) continue;
      // Одно активное решение на кластер в актуальном прогоне.
      await tx.queryRun(
        'DELETE FROM review_decisions WHERE cluster_id = ? AND analysis_run_id = ?',
        sel.cluster_id, activeRunId,
      );
      await tx.queryRun(
        `INSERT INTO review_decisions
           (id, issue_id, cluster_id, analysis_run_id, cluster_key, decision,
            edited_redaction, final_comment, target_text, decided_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), sel.cluster_id, activeRunId, cluster.cluster_key, old.decision,
        old.edited_redaction, old.final_comment, old.target_text, nowIso(),
      );
      applied += 1;
    }
  });
  return { applied, active_run_id: activeRunId };
}

module.exports = {
  // константы / scope
  SCOPE_PIPELINE,
  stageScope,
  // чистое ядро (офлайн-тесты)
  computeDocumentsRevision,
  computeConfigVersion,
  clusterRunId,
  selectActiveRunIds,
  matchDecisionsToClusters,
  dedupeExportRows,
  // DB: жизненный цикл прогона
  beginRun,
  beginCandidateRun,
  assertRunWritable,
  activateRun,
  completeRunWithoutActivation,
  failRun,
  finalizeRun,
  interruptStaleStageRuns,
  recoverOrphanedStageRuns,
  getRunInputsManifest,
  getRun,
  getLatestStageRun,
  listStageRuns,
  getLatestPipelineRun,
  collectStageInputs,
  archiveStageRunsFrom,
  clearPipelinePointer,
  getActivePipelineRunId,
  getActiveStageRunId,
  getActiveStageRunIds,
  issuesRunFilter,
  clearStagePointers,
  currentDocumentsRevision,
  currentConfigVersion,
  // DB: перенос решений
  listCarryOverProposals,
  confirmCarryOvers,
};
