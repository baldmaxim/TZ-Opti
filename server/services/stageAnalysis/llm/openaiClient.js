'use strict';

// Тонкая обёртка над официальным `openai` SDK с structured-output (JSON Schema).
// Используется LLM-агентами стадий анализа. Лениво инициализирует клиент по
// первому вызову, чтобы старт сервера не падал из-за пустого OPENAI_API_KEY —
// валидация ключа делается на ручке runStage.

const OpenAI = require('openai');

let _client = null;

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
  _client = new OpenAI({ apiKey, baseURL });
  return _client;
}

// Вызов модели со structured output. Возвращает уже распарсенный JSON.
// Бросает ошибку с понятным сообщением, если API вернул не-JSON.
async function chatJson({ system, user, jsonSchema, schemaName = 'response', model, temperature }) {
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
    const wrapped = new Error(`OpenAI API: ${err.message || 'unknown error'}`);
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
};
