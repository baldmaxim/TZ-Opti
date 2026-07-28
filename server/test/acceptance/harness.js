'use strict';

// Оснастка ПРИЁМОЧНЫХ (acceptance) тестов: портал целиком — HTTP-API + очередь +
// воркер + живой PostgreSQL, — но БЕЗ внешней сети.
//
// Что подменяется и почему:
//   • LLM  — провайдер chatJson (официальный шов setChatJsonProvider). Модель в
//            тесте детерминирована, реальный вызов из тестового процесса
//            запрещён самим openaiClient. Никаких обращений наружу.
//   • АНТИВИРУС — AV_SCAN_MODE=disabled (разрешён только вне production).
//   • ВРЕМЯ/ОЧЕРЕДЬ — ничего: очередь, advisory-lock, воркер и БД настоящие.
// Аутентификация НЕ выключена: приложение поднимается с dev-обходом, который
// выдаёт настоящий principal (роль admin) — маршруты проходят весь конвейер
// authenticate → authorize → policy, как в бою.
//
// ВАЖНО: файл читает переменные окружения ДО require() серверных модулей
// (STAGE_SEGMENT_TOKENS и др. читаются модулями при загрузке), поэтому в
// acceptance-тесте он обязан быть ПЕРВЫМ require.

const os = require('os');
const path = require('path');
const fs = require('fs');

// --- окружение (до любых серверных require) ----------------------------------

// Мелкая нарезка ТЗ: несколько частей на небольшом документе — так проверяется
// сегментация, чекпойнт и «упала одна часть», а не «весь текст одним куском».
process.env.STAGE_SEGMENT_TOKENS = process.env.STAGE_SEGMENT_TOKENS || '600';
// Без LLM-шага межраздельной сверки: число вызовов модели детерминировано.
process.env.STAGE_CROSS_SEGMENT_REVIEW = '0';
// Ключ нужен как признак «LLM настроен» (сам вызов уходит в подменённый провайдер).
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'acceptance-stub-key';
process.env.AV_SCAN_MODE = 'disabled';
// Загруженные файлы — во временный каталог, а не в рабочий server/uploads.
const UPLOAD_ROOT = path.join(os.tmpdir(), `tz-opti-acceptance-${process.pid}`);
process.env.UPLOAD_DIR = UPLOAD_ROOT;
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// --- серверные модули ---------------------------------------------------------

const { createApp } = require('../../app');
const { buildConfig } = require('../../security/config');
const { createWorker } = require('../../services/jobs/worker');
const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { installFakeLlm } = require('../helpers/fakeLlm');

const OPTS = dbTestOptions();
const silent = { log: () => {}, warn: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- ожидание ------------------------------------------------------------------

// Опрос условия с явной причиной таймаута: в acceptance всё асинхронно
// (очередь, воркер, извлечение текста), а «спать 2 секунды» — источник флаки.
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 100, what = 'условие' } = {}) {
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Таймаут ожидания: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
}

// --- приложение ----------------------------------------------------------------

// Поднимает портал на эфемерном порту и возвращает клиент API.
// Лимиты запросов выключены (вне production это допустимо): acceptance делает
// сотни обращений подряд, и упереться в антифлуд — не то, что мы проверяем.
async function startApi(t) {
  const config = buildConfig({
    ...process.env,
    NODE_ENV: 'test',
    AUTH_DEV_BYPASS: '1',
    AUTH_DEV_ROLES: 'admin',
    AV_SCAN_MODE: 'disabled',
    RATE_LIMIT_ENABLED: '0',
    AUDIT_ENABLED: '1',
  });
  const app = createApp({ logger: false, security: { config } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (urlPath, { method = 'GET', body, form, headers = {} } = {}) => {
    const opts = { method, headers: { ...headers } };
    if (form) {
      opts.body = form; // fetch сам выставит multipart-заголовок с boundary
    } else if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + urlPath, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON — тест посмотрит текст */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  return { base, call, app };
}

// --- воркер очереди -------------------------------------------------------------

// Настоящий воркер в этом же процессе (fake LLM — тоже в этом процессе).
// Несколько воркеров = несколько вызовов: координация целиком в БД.
async function startWorker(t, { id = null, taskTypes = null } = {}) {
  const worker = createWorker({
    workerId: id || undefined,
    taskTypes,
    logger: silent,
    pollIntervalMs: 50,
    leaseMs: 20_000,
    heartbeatMs: 3_000,
    reapIntervalMs: 60_000,
    busyDelayMs: 200,
  });
  await worker.start();
  t.after(() => worker.stop());
  return worker;
}

// --- фикстуры ------------------------------------------------------------------

const FILLER = [
  'Подрядчик выполняет работы в объёме, определённом проектной документацией и настоящим',
  'техническим заданием, с соблюдением требований действующих норм, правил охраны труда',
  'и промышленной безопасности, а также утверждённого графика производства работ.',
].join(' ');

// Синтетическое ТЗ: у каждого пункта свой маркер — по нему тест узнаёт, какую
// часть документа «видела» модель и какая находка к какому месту привязана.
function buildTzMarkdown({ sections = 6, clauses = 3, tag = '' } = {}) {
  const out = [];
  for (let s = 1; s <= sections; s += 1) {
    out.push(`# ${s}. Раздел ${s}. Требования к производству работ`, '');
    for (let c = 1; c <= clauses; c += 1) {
      out.push(`${s}.${c} МАРКЕР${tag}-${s}-${c}. ${FILLER} ${FILLER}`, '');
    }
  }
  return out.join('\n');
}

// Ответ «модели» на часть ТЗ: находка с цитатой ИЗ ЭТОЙ ЖЕ части (иначе она не
// локализуется и будет отброшена). Домен стадии 1 — покрытие расчёта.
function findingFor(call, { comment = 'Проверить объём' } = {}) {
  const marker = (String(call.user).match(/МАРКЕР[^.\s]*-\d+-\d+/) || [])[0];
  if (!marker) return { findings: [] };
  return {
    findings: [{
      fragment: marker,
      problem_type: 'не_учтено_в_вор',
      criticality: 'medium',
      basis: 'работа описана в ТЗ, но не найдена в ведомости',
      review_comment: `${comment} по ${marker}`,
      suggested_action: 'clarify',
      confidence: 0.7,
    }],
  };
}

// Стадии 2–5 в acceptance играют роль «прошли без замечаний»: их домены здесь не
// проверяются, а пустой ответ — валидный для любой схемы находок.
const NO_FINDINGS = { findings: [] };

// Управляемая «модель»: тест задаёт ответ перед каждым шагом сценария
// (respond), а потом смотрит, ЧТО именно ушло в модель (calls). Гарантия
// офлайна — сам openaiClient: реальный вызов из тестового процесса запрещён.
function scriptedLlm(t) {
  const state = { responder: () => NO_FINDINGS };
  const llm = installFakeLlm(t, (call, index) => state.responder(call, index));
  return {
    calls: llm.calls,
    get callCount() { return llm.calls.length; },
    // Тексты, которые «видела» модель, — по ним проверяется активный текст ТЗ.
    get seen() { return llm.calls.map((c) => String(c.user || '')).join('\n'); },
    reset() { llm.calls.length = 0; },
    respond(fn) { state.responder = fn; },
    restore: llm.restore,
  };
}

// --- сценарии API ---------------------------------------------------------------

async function createTender(call, title) {
  const res = await call('/api/tenders', { method: 'POST', body: { title, type: 'СМР', status: 'draft' } });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`не удалось создать тендер: ${res.status} ${res.text.slice(0, 200)}`);
  }
  return res.body.id;
}

// Загрузка документа ЧЕРЕЗ API (карантин → формат → магические байты → SHA-256 →
// антивирус → папка тендера), а не вставкой строки в БД: приёмочный тест обязан
// проходить тем же путём, что инженер в портале.
async function uploadDocument(call, tenderId, { name, text, content, docType = 'tz', mime = 'text/markdown' }) {
  const payload = content !== undefined ? content : text;
  const form = new FormData();
  form.append('file', new Blob([payload], { type: mime }), name);
  form.append('doc_type', docType);
  const res = await call(`/api/tenders/${tenderId}/documents`, { method: 'POST', form });
  if (res.status !== 201) throw new Error(`загрузка ${name} отклонена: ${res.status} ${res.text.slice(0, 300)}`);
  const docId = res.body.id;
  // Извлечение текста идёт после ответа (setImmediate) — ждём готовности.
  await waitFor(async () => {
    const list = await call(`/api/tenders/${tenderId}/documents`);
    const doc = (list.body.items || []).find((d) => d.id === docId);
    return doc && doc.processing_status === 'extracted' ? doc : null;
  }, { what: `извлечение текста ${name}`, timeoutMs: 30_000 });
  return docId;
}

// Q&A-справочник для гейта стадии 2. Это ФИКСТУРА (записи переписки), а не
// проверяемый путь: импорт .xlsx проверяется своими тестами.
async function seedQaEntries(db, tenderId, count = 3) {
  const now = new Date().toISOString();
  for (let i = 1; i <= count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await db.queryRun(
      `INSERT INTO qa_entries (id, tender_id, tz_clause, question, answer, accepted_decision, order_idx, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `qa-${tenderId}-${i}`, tenderId, `${i}.1`,
      `Вопрос ${i}: кто выполняет работы по разделу ${i}?`,
      `Ответ ${i}: работы выполняет заказчик.`,
      `Принято: раздел ${i} вне объёма ГП.`,
      i, now,
    );
  }
}

async function getStages(call, tenderId) {
  const res = await call(`/api/tenders/${tenderId}/stages`);
  if (res.status !== 200) throw new Error(`GET stages: ${res.status} ${res.text.slice(0, 200)}`);
  return res.body;
}

const RUNNING_STATUSES = new Set(['running']);

// Запуск стадии через API + ожидание ИСХОДА (успех или сбой — оба возвращаются).
// Ничего не утверждает: решение «это успех» принимает сам тест.
//
// Форма ответа /stages: stages[i].summary — это СТРОКА прогона (analysis_runs),
// у которой поле summary — разобранный отчёт стадии. Чтобы тесты не путали
// узкий статус колонки с контрактом результата, раскладываем явно:
//   run     — строка прогона (status: completed|failed|running);
//   outcome — отчёт стадии (status по контракту resultStatus, error, счётчики).
async function runStageAndWait(call, tenderId, stage, { timeoutMs = 90_000 } = {}) {
  const started = await call(`/api/tenders/${tenderId}/stages/${stage}/run`, { method: 'POST' });
  if (started.status !== 202) {
    return { queued: false, response: started };
  }
  const state = await waitFor(async () => {
    const s = await getStages(call, tenderId);
    const status = s.state[`stage${stage}_status`];
    if (RUNNING_STATUSES.has(status)) return null;
    // Стадия уже не running — но исход прогона мог ещё не записаться.
    const run = s.stages[stage - 1].summary;
    if (run && run.status === 'running') return null;
    return s;
  }, { what: `исход стадии ${stage}`, timeoutMs });
  const card = state.stages[stage - 1];
  return {
    queued: true,
    response: started,
    stages: state,
    card,
    status: state.state[`stage${stage}_status`],
    run: card.summary || null,
    outcome: (card.summary && card.summary.summary) || null,
  };
}

async function finishStage(call, tenderId, stage) {
  return call(`/api/tenders/${tenderId}/stages/${stage}/finish`, { method: 'POST' });
}

// Полная уборка тендера: строки уходят каскадом, файлы — вместе с каталогом.
async function dropTender(db, tenderId) {
  await db.queryRun('DELETE FROM analysis_tasks WHERE tender_id = ?', tenderId);
  await db.queryRun('DELETE FROM analysis_jobs WHERE tender_id = ?', tenderId);
  await db.queryRun('DELETE FROM analysis_active_runs WHERE tender_id = ?', tenderId);
  await db.queryRun('DELETE FROM tenders WHERE id = ?', tenderId);
}

function removeUploads() {
  try { fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true }); } catch { /* уже нет */ }
}

module.exports = {
  OPTS,
  UPLOAD_ROOT,
  getDb,
  closeDb,
  installFakeLlm,
  waitFor,
  sleep,
  startApi,
  startWorker,
  buildTzMarkdown,
  findingFor,
  scriptedLlm,
  NO_FINDINGS,
  createTender,
  uploadDocument,
  seedQaEntries,
  getStages,
  runStageAndWait,
  finishStage,
  dropTender,
  removeUploads,
};
