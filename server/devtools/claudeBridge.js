'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Локальный OpenAI-совместимый бридж к Claude (dev-only).
//
// Зачем: Стадия 1 (stage1_llm.js) ходит в LLM через openaiClient.js, которому
// нужен OPENAI_API_KEY. Ключа OpenAI у пользователя нет. Этот процесс поднимает
// эндпоинт POST /v1/chat/completions в формате OpenAI, а внутри вызывает Claude
// через @anthropic-ai/claude-agent-sdk, переиспользуя авторизацию Claude Code
// (подписка пользователя — НИКАКОГО API-ключа).
//
// openaiClient.js конструирует new OpenAI({ apiKey, baseURL }); при
// OPENAI_BASE_URL=http://127.0.0.1:4010/v1 SDK шлёт POST .../v1/chat/completions
// сюда. Бридж зеркалит ровно тот контракт, что ждёт openaiClient:
//   запрос  : { model, temperature, messages:[{role:'system'},{role:'user'}],
//              response_format:{ json_schema:{ name, schema, strict } } }
//   ответ   : { choices:[{ message:{ content: "<JSON-строка>" } }] }
//
// Диагностика: каждый запрос пишет полный дамп (subtype, наличие
// structured_output, num_turns, ошибки, сырой ответ Claude целиком) в
// server/devtools/.debug/ — каталог под .gitignore, dev-only.
//
// НЕ продакшен-код. Подробности и предупреждения — server/devtools/README.md.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// .env лежит в корне репозитория (см. server/app.js). Бридж — отдельный
// процесс, поэтому грузит .env сам.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Авторизация должна идти через подписку Claude Code, а НЕ через платный API.
// Стираем ANTHROPIC_API_KEY, чтобы случайная переменная окружения не увела
// SDK на биллинг по ключу.
delete process.env.ANTHROPIC_API_KEY;

const Ajv = require('ajv');

const PORT = Number(process.env.BRIDGE_PORT) || 4010;
const MODEL = (process.env.BRIDGE_MODEL || 'claude-sonnet-4-6').trim();
// 15 мин/вызов: один НЕпараллельный прогон Стадии 1 на тендере 311 — ~8 мин
// (489с), но с вариативностью LLM близко к 10-мин лимиту → 600000 иногда не
// хватало. 900000 даёт надёжный запас. См. README / project_stage1_context_limit.
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS) || 900000;
const MAX_BODY = 32 * 1024 * 1024; // полный ТЗ + ВОР + чек-лист

// Диагностические дампы (dev-only, под .gitignore).
const DEBUG_DIR = path.join(__dirname, '.debug');
const DEBUG_REL = 'server/devtools/.debug'; // путь для сообщений пользователю
const MAX_RAW = 200 * 1024; // потолок на сырой ответ Claude в дампе
const KEEP_DUMPS = 50; // держим последние N дампов, остальное чистим

const ajv = new Ajv({ allErrors: true, strict: false });

// @anthropic-ai/claude-agent-sdk — ESM-only, сервер CommonJS → ленивый import().
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

// ── Диагностический дамп ─────────────────────────────────────────────────────
// Пишем полную картину запроса в .debug/ + лёгкий prune (последние KEEP_DUMPS).
// Любой сбой записи проглатываем — диагностика не должна ломать запрос.
function writeDebugDump(fileName, record) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DEBUG_DIR, fileName),
      JSON.stringify(record, null, 2),
      'utf8',
    );
    const files = fs
      .readdirSync(DEBUG_DIR)
      .filter((f) => f.startsWith('bridge-') && f.endsWith('.json'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - KEEP_DUMPS))) {
      try {
        fs.unlinkSync(path.join(DEBUG_DIR, stale));
      } catch (_) {
        /* не критично */
      }
    }
  } catch (e) {
    console.error('[claudeBridge] не удалось записать дамп:', e.message);
  }
}

// ── Санитайзер JSON Schema для нативного structured output ────────────────────
// Anthropic structured output строг к форме схемы: union-типы вида
// type:['string','null'] заставляют харнесс игнорировать outputFormat и вернуть
// прозу-резюме вместо структуры. Схлопываем union в первый не-null примитив.
// enum / minimum / maximum / additionalProperties:false оставляем как есть —
// они принимаются по отдельности, реальный блокер именно union-type.
// Чистая функция: возвращает глубокую копию, оригинал (для ajv) не трогаем.
function sanitizeSchemaForStructuredOutput(schema) {
  if (Array.isArray(schema)) {
    return schema.map((s) => sanitizeSchemaForStructuredOutput(s));
  }
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(val)) {
      const primitive = val.find((t) => t !== 'null');
      out[key] = primitive || 'string';
    } else if (val && typeof val === 'object') {
      out[key] = sanitizeSchemaForStructuredOutput(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// ── Извлечение JSON из ответа модели ─────────────────────────────────────────
// Срезаем ```json-заборы, при наличии прозы — баланс-скан от первой { до парной.
function extractJson(text) {
  if (!text) throw new Error('пустой ответ модели');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    /* падаем в баланс-скан ниже */
  }
  const start = s.indexOf('{');
  if (start === -1) throw new Error('в ответе модели нет JSON-объекта');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('не удалось извлечь сбалансированный JSON-объект');
}

// ── Один вызов Claude через Agent SDK ────────────────────────────────────────
// Headless, без инструментов. systemPrompt заменяет дефолтный агентный промпт
// Claude Code — нам нужна чистая генерация. При наличии схемы используем
// нативный structured output SDK (options.outputFormat) — модель форсируется
// под JSON Schema, результат приходит готовым объектом в result.structured_output
// (надёжнее, чем парсить свободный текст).
// Возвращает { obj?, text?, subtype, structuredOutputPresent, numTurns, errors }.
// На не-success subtype / таймаут / отсутствие result — бросает Error с
// прикреплёнными .subtype/.numTurns/.errors (вызывающий их логирует).
async function callClaude(systemPrompt, userPrompt, schema) {
  const { query } = await loadSdk();

  const options = {
    model: MODEL,
    systemPrompt,
    // 2 раунда достаточно (успешный ответ = num_turns=2, инструментов нет);
    // 4 лишь тратили время.
    maxTurns: 2,
    allowedTools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: os.tmpdir(),
  };
  // Опционально (по умолчанию ВЫКЛ — поведение/качество не меняются):
  // отключить extended thinking для ускорения. Принимать только после
  // A/B-сравнения с эталоном (см. план/README).
  if (/^(1|true|on|yes)$/i.test(String(process.env.STAGE1_FAST_THINKING || ''))) {
    options.thinking = { type: 'disabled' };
  }
  // В нативный outputFormat отдаём САНИТАЙЗЕННУЮ схему (без union-типов).
  if (schema) {
    options.outputFormat = {
      type: 'json_schema',
      schema: sanitizeSchemaForStructuredOutput(schema),
    };
  }

  const iterator = query({ prompt: userPrompt, options });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Claude не ответил за ${TIMEOUT_MS} мс`)),
      TIMEOUT_MS,
    );
  });

  const run = (async () => {
    for await (const msg of iterator) {
      if (msg && msg.type === 'result') {
        const numTurns = typeof msg.num_turns === 'number' ? msg.num_turns : null;
        if (msg.subtype === 'success') {
          const hasObj =
            msg.structured_output && typeof msg.structured_output === 'object';
          if (hasObj) {
            return {
              obj: msg.structured_output,
              subtype: 'success',
              structuredOutputPresent: true,
              numTurns,
              errors: [],
            };
          }
          return {
            text: msg.result,
            subtype: 'success',
            structuredOutputPresent: false,
            numTurns,
            errors: [],
          };
        }
        const errs = msg.errors || [];
        const e = new Error(
          `Claude вернул ошибку (${msg.subtype}): ${
            errs.join('; ') || 'нет деталей'
          }`,
        );
        e.subtype = msg.subtype;
        e.numTurns = numTurns;
        e.errors = errs;
        throw e;
      }
    }
    throw new Error('Claude завершился без result-сообщения');
  })();

  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    if (typeof iterator.return === 'function') {
      iterator.return().catch(() => {});
    }
  }
}

// ── Структурированный вывод: outputFormat → repair → noOutputFormat → fail ────
// Каждая попытка пишет запись в debugRecord.attempts и безусловно логируется.
async function getSchemaConformingJson(systemContent, userContent, schema, debugRecord) {
  const sys = `${systemContent}

Отвечай ТОЛЬКО структурированными данными по заданной JSON Schema — без пояснений и текста вокруг.`;

  // Валидируем против ОРИГИНАЛЬНОЙ (строгой) схемы; outputFormat получает
  // санитайзенную внутри callClaude.
  let validate = null;
  if (schema) {
    try {
      validate = ajv.compile(schema);
      debugRecord.schema.ajvCompileOk = true;
    } catch (e) {
      debugRecord.schema.ajvCompileOk = false;
      debugRecord.schema.ajvCompileError = e.message;
      console.warn(`[claudeBridge] ajv.compile упал: ${e.message} — без валидации`);
    }
  }

  // Один прогон callClaude с диагностикой. Никогда не бросает — нормализует
  // успех/ошибку в { obj?, text?, subtype, ... } и пушит attempts[].
  async function attempt(phase, sysPrompt, userPrompt, schemaArg) {
    let r = null;
    let err = null;
    try {
      r = await callClaude(sysPrompt, userPrompt, schemaArg);
    } catch (e) {
      err = e;
    }
    const subtype = r ? r.subtype : (err && err.subtype) || 'error';
    const structuredOutputPresent = !!(r && r.obj);
    const numTurns = r ? r.numTurns : (err && err.numTurns) != null ? err.numTurns : null;
    const errors = r
      ? r.errors
      : (err && err.errors && err.errors.length ? err.errors : [err && err.message].filter(Boolean));
    const rawText = r && r.text != null ? String(r.text) : '';
    debugRecord.attempts.push({
      phase,
      subtype,
      structuredOutputPresent,
      numTurns,
      errors,
      rawLen: rawText.length,
      rawFull: structuredOutputPresent
        ? '[structured_output]'
        : rawText
          ? rawText.slice(0, MAX_RAW)
          : err
            ? `[error] ${err.message}`
            : '',
    });
    console.log(
      `[claudeBridge] attempt=${phase} subtype=${subtype} structured_output=${structuredOutputPresent} num_turns=${numTurns} raw_len=${rawText.length}`,
    );
    return { r, err };
  }

  // Пытаемся достать валидный объект из результата попытки.
  function pick(res) {
    if (!res.r) return null;
    if (res.r.obj) {
      if (validate && !validate(res.r.obj)) {
        console.warn(
          `[claudeBridge] structured_output не идеален по схеме: ${ajv.errorsText(
            validate.errors,
          )} — отдаю best-effort`,
        );
      }
      return res.r.obj; // structured_output форсирован под схему — best-effort
    }
    try {
      const obj = extractJson(res.r.text);
      if (!validate || validate(obj)) return obj;
    } catch (_) {
      /* нет JSON в тексте — идём дальше */
    }
    return null;
  }

  // Попытка 1 — нативный structured output (санитайзенная схема).
  const a1 = await attempt('outputFormat', sys, userContent, schema);
  const p1 = pick(a1);
  if (p1) return p1;

  // Таймаут — не ретраим: repair/noOutputFormat (с тем же/бо́льшим промптом)
  // тоже упрутся в дедлайн, только утроят ожидание. Fail-fast с понятным
  // сообщением.
  if (a1.err && /не ответил за/.test(a1.err.message)) {
    throw new Error(
      `ИИ не успел проанализировать ТЗ за ${Math.round(
        TIMEOUT_MS / 60000,
      )} мин (промпт ~${debugRecord.promptSizes.approxTokens} токенов — это долго). ` +
        `Полный отчёт: ${DEBUG_REL}/${debugRecord.file}. Повторите запуск.`,
    );
  }

  // Попытка 2 — repair: схема-в-промпте + причина + предыдущий ответ.
  const reason = a1.err
    ? `вызов упал: ${a1.err.message}`
    : 'ответ без валидного JSON';
  console.warn(
    `[claudeBridge] попытка 1 без JSON (${reason}); полный дамп: ${DEBUG_REL}/${debugRecord.file}`,
  );
  const repairUser = `${userContent}

--- JSON SCHEMA (ответ обязан ей соответствовать) ---
${JSON.stringify(schema)}

--- ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ (НЕВАЛИДЕН) ---
${String(a1.r && a1.r.text ? a1.r.text : '').slice(0, 8000)}

--- ПРОБЛЕМА ---
${reason}

Верни ИСПРАВЛЕННЫЙ JSON-объект строго по схеме. Только JSON.`;

  const a2 = await attempt('repair', sys, repairUser, schema);
  const p2 = pick(a2);
  if (p2) return p2;

  // Попытка 3 — без outputFormat: убираем structured-output-машинерию SDK,
  // просим чистый JSON в промпте, тащим баланс-сканом.
  const sysPureJson = `${systemContent}

Ответь ОДНИМ JSON-объектом по схеме. Никакого текста до или после. Без markdown-заборов.`;
  const a3 = await attempt('noOutputFormat', sysPureJson, repairUser, null);
  const p3 = pick(a3);
  if (p3) return p3;

  // Всё провалилось — fail-loud с понятным actionable-сообщением.
  const origSubtype = (debugRecord.attempts[0] && debugRecord.attempts[0].subtype) || 'error';
  throw new Error(
    `ИИ не смог проанализировать ТЗ (ответ без JSON, subtype=${origSubtype}). ` +
      `Полный отчёт: ${DEBUG_REL}/${debugRecord.file}. Нажмите «Запустить» ещё раз.`,
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('тело запроса превышает лимит бриджа'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// OpenAI-style ошибка. Статус 400 (НЕ 5xx) намеренно: openai SDK не делает
// retry на 4xx — иначе медленный сбой множился бы на 3 попытки.
function sendError(res, message) {
  sendJson(res, 400, { error: { message, type: 'bridge_error', code: 'bridge_error' } });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, model: MODEL });
    return;
  }

  if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
    sendError(res, `неизвестный маршрут ${req.method} ${url}`);
    return;
  }

  const t0 = Date.now();
  const reqId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dumpName = `bridge-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')}-${reqId}.json`;
  const debugRecord = {
    ts: new Date().toISOString(),
    reqId,
    model: MODEL,
    elapsedMs: 0,
    file: dumpName,
    promptSizes: { systemChars: 0, userChars: 0, approxTokens: 0 },
    schema: { present: false, ajvCompileOk: null, ajvCompileError: null },
    attempts: [],
    outcome: null,
    finalError: null,
  };

  try {
    const body = await readBody(req);
    const reqJson = JSON.parse(body);

    const messages = Array.isArray(reqJson.messages) ? reqJson.messages : [];
    const systemContent = messages.find((m) => m.role === 'system')?.content || '';
    const userContent = messages.find((m) => m.role === 'user')?.content || '';
    const schema = reqJson.response_format?.json_schema?.schema || null;

    debugRecord.promptSizes = {
      systemChars: systemContent.length,
      userChars: userContent.length,
      approxTokens: Math.round((systemContent.length + userContent.length) / 2.5),
    };
    debugRecord.schema.present = !!schema;

    if (!userContent) {
      debugRecord.outcome = 'error';
      debugRecord.finalError = 'в запросе нет user-сообщения';
      debugRecord.elapsedMs = Date.now() - t0;
      writeDebugDump(dumpName, debugRecord);
      sendError(res, 'в запросе нет user-сообщения');
      return;
    }

    console.log(
      `[claudeBridge] входящий промпт: system=${systemContent.length} ch, user=${userContent.length} ch, ~${debugRecord.promptSizes.approxTokens} токенов (грубо)`,
    );

    const resultObj = await getSchemaConformingJson(
      systemContent,
      userContent,
      schema,
      debugRecord,
    );

    const findingsCount = Array.isArray(resultObj?.findings)
      ? resultObj.findings.length
      : '—';
    debugRecord.outcome = 'success';
    debugRecord.elapsedMs = Date.now() - t0;
    writeDebugDump(dumpName, debugRecord);
    console.log(
      `[claudeBridge] ${MODEL} ok за ${debugRecord.elapsedMs} мс, findings=${findingsCount}`,
    );

    // Точная OpenAI-форма, которую читает openaiClient.js:65-74
    sendJson(res, 200, {
      id: `chatcmpl-bridge-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(resultObj) },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    debugRecord.outcome = 'error';
    debugRecord.finalError = err.message || 'неизвестная ошибка бриджа';
    debugRecord.elapsedMs = Date.now() - t0;
    writeDebugDump(dumpName, debugRecord);
    console.error(
      `[claudeBridge] ошибка за ${debugRecord.elapsedMs} мс: ${debugRecord.finalError}; дамп: ${DEBUG_REL}/${dumpName}`,
    );
    sendError(res, debugRecord.finalError);
  }
});

// Анализ ~110-160K токенов идёт минутами. HTTP-сервер не должен рвать запрос
// раньше внутреннего дедлайна (TIMEOUT_MS) — иначе openai SDK видит обрыв
// соединения и делает скрытый ретрай (дублирующиеся параллельные запросы).
// Держим запас НАД TIMEOUT_MS.
server.requestTimeout = TIMEOUT_MS + 60000;
server.headersTimeout = 65000;
server.keepAliveTimeout = TIMEOUT_MS + 60000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[claudeBridge] listening on http://127.0.0.1:${PORT}  model=${MODEL}  timeout=${TIMEOUT_MS}ms  debug=${DEBUG_REL}/`,
  );
});
