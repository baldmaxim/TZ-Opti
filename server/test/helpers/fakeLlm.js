'use strict';

// Fake LLM-провайдер для тестов: подменяет chatJson в openaiClient через
// официальный шов setChatJsonProvider (dependency injection). Сети нет.
//
// Использование:
//   const { installFakeLlm } = require('../helpers/fakeLlm');
//   const llm = installFakeLlm(t, [{ findings: [] }]);   // очередь ответов
//   ... llm.calls  // что именно ушло «в модель»
//
// Если ответы кончились — бросаем (тест увидит лишний вызов, а не тишину).
// Реальный вызов LLM в тестовом процессе запрещён самим openaiClient.

const openaiClient = require('../../services/stageAnalysis/llm/openaiClient');

// responses: массив ответов ИЛИ функция (call, index) => ответ.
// Ответ может быть Error — тогда провайдер отклоняет промис (проверка fail-loud).
function installFakeLlm(t, responses = []) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : responses;

  const provider = async (call) => {
    calls.push(call);
    const value = typeof queue === 'function' ? queue(call, calls.length - 1) : queue.shift();
    if (value === undefined) {
      throw new Error(`fakeLlm: незапланированный вызов LLM #${calls.length} (очередь ответов пуста).`);
    }
    if (value instanceof Error) throw value;
    return value;
  };

  const restore = openaiClient.setChatJsonProvider(provider);
  if (t && typeof t.after === 'function') t.after(restore);

  return {
    calls,
    restore,
    get callCount() {
      return calls.length;
    },
    get pending() {
      return typeof queue === 'function' ? null : queue.length;
    },
  };
}

module.exports = { installFakeLlm };
