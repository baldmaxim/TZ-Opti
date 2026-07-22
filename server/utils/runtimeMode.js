'use strict';

// Определение «тестового процесса» — единый источник правды для fail-closed
// защит (подключение к БД, вызовы LLM).
//
// Два независимых сигнала, чтобы защита не отключалась одной переменной:
//   1. NODE_TEST_CONTEXT — выставляет сам `node --test` в дочернем процессе
//      каждого тест-файла (Node ≥ 20). Пользователь его не задаёт.
//   2. NODE_ENV=test — явный режим (в репозитории задаётся из test/env/test.env),
//      покрывает запуск тест-файла напрямую `node test/unit/x.test.js`.
//
// Важно: `--env-file` в Node НЕ перезаписывает уже заданные переменные
// окружения, поэтому глобально выставленный NODE_ENV мог бы «размагнитить»
// сигнал (2) — сигнал (1) на это не влияет.

function isTestProcess(env = process.env) {
  if (env.NODE_TEST_CONTEXT) return true;
  return (env.NODE_ENV || '').trim().toLowerCase() === 'test';
}

module.exports = { isTestProcess };
