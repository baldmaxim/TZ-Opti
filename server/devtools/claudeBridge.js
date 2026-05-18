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
// НЕ продакшен-код. Подробности и предупреждения — server/devtools/README.md.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const path = require('path');

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
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS) || 180000;
const MAX_BODY = 32 * 1024 * 1024; // полный ТЗ + ВОР + чек-лист

const ajv = new Ajv({ allErrors: true, strict: false });

// @anthropic-ai/claude-agent-sdk — ESM-only, сервер CommonJS → ленивый import().
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
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
// Возвращает { obj } (структурированный объект) либо { text } (сырой текст).
async function callClaude(systemPrompt, userPrompt, schema) {
  const { query } = await loadSdk();
  const os = require('os');

  const options = {
    model: MODEL,
    systemPrompt,
    maxTurns: 4,
    allowedTools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: os.tmpdir(),
  };
  if (schema) options.outputFormat = { type: 'json_schema', schema };

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
        if (msg.subtype === 'success') {
          if (msg.structured_output && typeof msg.structured_output === 'object') {
            return { obj: msg.structured_output };
          }
          return { text: msg.result };
        }
        throw new Error(
          `Claude вернул ошибку (${msg.subtype}): ${
            (msg.errors || []).join('; ') || 'нет деталей'
          }`,
        );
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

// ── Структурированный вывод: схема-в-промпт + валидация + 1 repair-retry ──────
async function getSchemaConformingJson(systemContent, userContent, schema) {
  const sys = `${systemContent}

Отвечай ТОЛЬКО структурированными данными по заданной JSON Schema — без пояснений и текста вокруг.`;

  const validate = schema ? ajv.compile(schema) : null;

  // Попытка 1 — нативный structured output SDK (если есть схема)
  const r1 = await callClaude(sys, userContent, schema);

  if (r1.obj) {
    // structured_output от SDK уже форсирован под схему — отдаём как есть
    // (downstream fragmentMatcher в stage1_llm.js всё равно фильтрует мусор).
    if (validate && !validate(r1.obj)) {
      console.warn(
        `[claudeBridge] structured_output не идеален по схеме: ${ajv.errorsText(
          validate.errors,
        )} — отдаю best-effort`,
      );
    }
    return r1.obj;
  }

  // SDK вернул свободный текст — пытаемся извлечь JSON
  let obj;
  let parseErr = null;
  try {
    obj = extractJson(r1.text);
  } catch (e) {
    parseErr = e;
  }
  if (obj && (!validate || validate(obj))) return obj;

  // Repair-retry со схемой-в-промпте + причиной
  const reason = parseErr
    ? `JSON не распарсился: ${parseErr.message}`
    : `JSON не прошёл схему: ${ajv.errorsText(validate.errors)}`;
  console.warn(
    `[claudeBridge] попытка 1 без валидного JSON (${reason}); raw[0..500]=${String(
      r1.text,
    ).slice(0, 500)}`,
  );

  const repairUser = `${userContent}

--- JSON SCHEMA (ответ обязан ей соответствовать) ---
${JSON.stringify(schema)}

--- ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ (НЕВАЛИДЕН) ---
${String(r1.text).slice(0, 8000)}

--- ПРОБЛЕМА ---
${reason}

Верни ИСПРАВЛЕННЫЙ JSON-объект строго по схеме. Только JSON.`;

  const r2 = await callClaude(sys, repairUser, schema);
  if (r2.obj) return r2.obj;
  obj = extractJson(r2.text); // если и тут не парсится — бросаем наверх

  if (validate && !validate(obj)) {
    console.warn(
      `[claudeBridge] ответ не прошёл схему даже после repair: ${ajv.errorsText(
        validate.errors,
      )} — отдаю best-effort`,
    );
  }
  return obj;
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
  try {
    const body = await readBody(req);
    const reqJson = JSON.parse(body);

    const messages = Array.isArray(reqJson.messages) ? reqJson.messages : [];
    const systemContent = messages.find((m) => m.role === 'system')?.content || '';
    const userContent = messages.find((m) => m.role === 'user')?.content || '';
    const schema = reqJson.response_format?.json_schema?.schema || null;

    if (!userContent) {
      sendError(res, 'в запросе нет user-сообщения');
      return;
    }

    console.log(
      `[claudeBridge] входящий промпт: system=${systemContent.length} ch, user=${userContent.length} ch, ~${Math.round(
        (systemContent.length + userContent.length) / 2.5,
      )} токенов (грубо)`,
    );

    const resultObj = await getSchemaConformingJson(systemContent, userContent, schema);

    const findingsCount = Array.isArray(resultObj?.findings)
      ? resultObj.findings.length
      : '—';
    console.log(
      `[claudeBridge] ${MODEL} ok за ${Date.now() - t0} мс, findings=${findingsCount}`,
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
    console.error(`[claudeBridge] ошибка за ${Date.now() - t0} мс:`, err.message);
    sendError(res, err.message || 'неизвестная ошибка бриджа');
  }
});

// Длинный анализ ТЗ Claude (Sonnet 4.6 ~20–60с). Не даём HTTP-серверу
// самому оборвать запрос раньше внутреннего дедлайна.
server.requestTimeout = 240000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 240000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[claudeBridge] listening on http://127.0.0.1:${PORT}  model=${MODEL}  timeout=${TIMEOUT_MS}ms`,
  );
});
