'use strict';

// Тонкая обёртка над официальным `openai` SDK с structured-output (JSON Schema).
// Используется LLM-агентами стадий анализа. Лениво инициализирует клиент по
// первому вызову, чтобы старт сервера не падал из-за пустого OPENAI_API_KEY —
// валидация ключа делается на ручке runStage.

const OpenAI = require('openai');
const { isTestProcess } = require('../../../utils/runtimeMode');

let _client = null;

// Тестовый провайдер (dependency injection). Ставится ТОЛЬКО в тестовом
// процессе — в проде подмена запрещена, чтобы шов нельзя было включить
// случайно/незаметно. Возвращает функцию отката.
let _provider = null;

function setChatJsonProvider(fn) {
  if (!isTestProcess()) {
    throw new Error('setChatJsonProvider доступен только в тестовом процессе (NODE_ENV=test / node --test).');
  }
  if (typeof fn !== 'function' && fn !== null) {
    throw new TypeError('setChatJsonProvider: ожидается функция или null.');
  }
  const prev = _provider;
  _provider = fn;
  return () => {
    _provider = prev;
  };
}

function isConfigured() {
  return Boolean((process.env.OPENAI_API_KEY || '').trim());
}

function getModel() {
  return (process.env.OPENAI_MODEL || 'gpt-4o').trim();
}

function getClient() {
  if (_client) return _client;
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY не настроен. Добавьте ключ в .env и перезапустите сервер.');
    err.status = 500;
    err.code = 'OPENAI_API_KEY_MISSING';
    throw err;
  }
  const baseURL = (process.env.OPENAI_BASE_URL || '').trim() || undefined;
  // Анализ через локальный бридж идёт минутами. Таймаут SDK должен быть ВЫШЕ
  // BRIDGE_TIMEOUT_MS, иначе SDK оборвёт соединение раньше бриджа и сделает
  // скрытый ретрай (дублирующиеся параллельные запросы). maxRetries:0 — на
  // 4xx бридж не ретраим (медленный сбой не множим).
  const bridgeTimeout = Number(process.env.BRIDGE_TIMEOUT_MS) || 600000;
  _client = new OpenAI({
    apiKey,
    baseURL,
    timeout: bridgeTimeout + 120000,
    maxRetries: 0,
  });
  return _client;
}

// Сетевые сбои SDK (нет соединения с baseURL) распознаём и превращаем в
// инструкцию инженеру: типичная причина на Стадии 1 — не поднят локальный
// Claude-бридж (npm run bridge). Сырое «Connection error.» инженеру ни о чём
// не говорит — даём адрес и команду.
function isConnectionError(err) {
  const code = err?.code || err?.cause?.code || '';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true;
  const name = err?.name || err?.constructor?.name || '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;
  return /connection error|fetch failed|connect ECONNREFUSED/i.test(err?.message || '');
}

function describeLlmError(err) {
  if (isConnectionError(err)) {
    const baseURL = (process.env.OPENAI_BASE_URL || '').trim();
    const isLocalBridge = /127\.0\.0\.1|localhost/.test(baseURL);
    if (isLocalBridge) {
      return (
        `LLM-бридж недоступен по ${baseURL} — он не запущен или упал. ` +
        'Запустите его командой «npm run bridge» (или весь стек «npm run dev») и повторите анализ.'
      );
    }
    return `Нет соединения с LLM (${baseURL || 'OpenAI API'}). Проверьте сеть/адрес и повторите.`;
  }
  return `OpenAI API: ${err?.message || 'unknown error'}`;
}

// Вызов модели со structured output. Возвращает уже распарсенный JSON.
// Бросает ошибку с понятным сообщением, если API вернул не-JSON.
async function chatJson({ system, user, jsonSchema, schemaName = 'response', model, temperature }) {
  const call = { system, user, jsonSchema, schemaName, model, temperature };
  if (_provider) return _provider(call);
  // Fail-closed: тесты никогда не ходят в реальный LLM. Если провайдер не
  // установлен — это ошибка теста, а не повод открыть сеть.
  if (isTestProcess()) {
    const err = new Error(
      'Тестовый процесс: реальный вызов LLM запрещён. Установите fake-провайдер (test/helpers/fakeLlm.js).',
    );
    err.code = 'LLM_CALL_IN_TEST_PROCESS';
    throw err;
  }
  const client = getClient();
  const useModel = model || getModel();

  let response;
  try {
    response = await client.chat.completions.create({
      model: useModel,
      temperature: typeof temperature === 'number' ? temperature : 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          schema: jsonSchema,
          strict: true,
        },
      },
    });
  } catch (err) {
    const wrapped = new Error(describeLlmError(err));
    wrapped.status = err.status || 502;
    wrapped.cause = err;
    throw wrapped;
  }

  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const err = new Error('OpenAI: пустой ответ модели.');
    err.status = 502;
    throw err;
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    const err = new Error('OpenAI: не удалось распарсить JSON-ответ модели.');
    err.status = 502;
    err.cause = e;
    err.raw = content;
    throw err;
  }
}

module.exports = {
  isConfigured,
  getModel,
  chatJson,
  setChatJsonProvider,
};
