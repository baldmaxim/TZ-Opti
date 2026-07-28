#!/usr/bin/env node
'use strict';

// Запуск набора тестов ДЛЯ CI со строгим разбором результата.
//
// Зачем отдельный раннер, а не просто `node --test`:
//
//   1. ПРОПУСК ≠ УСПЕХ. `node --test` завершается кодом 0, даже если все тесты
//      помечены skip. Для integration/acceptance это ложный зелёный: без
//      TEST_DATABASE_URL набор молча вырождается в ноль проверок. Здесь любой
//      skip/todo в строгом режиме (--strict) — ошибка сборки, как и «набор не
//      выполнил ни одного теста».
//   2. ФАЙЛЫ ПЕРЕЧИСЛЯЕМ САМИ. Glob-шаблоны у `node --test` появились не в
//      Node 20, а позже; CI обязан работать на Node 20+ без оговорок, поэтому
//      файлы ищет этот скрипт, а Node получает готовый список путей.
//
//   node scripts/runTests.js <каталог> [--strict] [--concurrency=1] [--env=файл]
//
// Каталог указывается относительно server/. Базовое окружение — test/env/test.env
// (+ test/env/strict.env в строгом режиме); файл с TEST_DATABASE_URL добавляется
// ЯВНО (`--env=../.env.test`) и только для наборов, которым нужна БД: юнит-тесты
// обязаны идти без неё — часть из них проверяет поведение процесса, у которого
// тестовой БД нет вовсе.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = { dir: null, strict: false, concurrency: null, envFiles: [] };
  for (const arg of argv) {
    if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('--concurrency=')) opts.concurrency = arg.split('=')[1];
    else if (arg.startsWith('--env=')) opts.envFiles.push(arg.split('=')[1]);
    else if (!arg.startsWith('--')) opts.dir = arg;
  }
  return opts;
}

function collectTestFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.test\.js$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// Итоговый блок TAP: «# pass 12», «# skipped 0», … Считаем именно его, а не
// строки отдельных тестов: подтесты Node тоже попадают в счётчики.
function parseTapSummary(text) {
  const counters = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s+(tests|suites|pass|fail|cancelled|skipped|skip|todo)\s+(\d+)\s*$/.exec(line.trim());
    if (m) counters[m[1] === 'skip' ? 'skipped' : m[1]] = Number(m[2]);
  }
  return counters;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    console.error('[tests] не указан каталог с тестами: node scripts/runTests.js test/integration --strict');
    process.exit(1);
  }
  const dir = path.resolve(SERVER_ROOT, opts.dir);
  if (!fs.existsSync(dir)) {
    console.error(`[tests] каталог не найден: ${opts.dir}`);
    process.exit(1);
  }

  const files = collectTestFiles(dir);
  if (!files.length) {
    console.error(`[tests] в ${opts.dir} нет ни одного *.test.js — пустой набор не может быть «зелёным»`);
    process.exit(1);
  }

  const args = [
    '--env-file=test/env/test.env',
    ...(opts.strict ? ['--env-file=test/env/strict.env'] : []),
    ...opts.envFiles.map((f) => `--env-file-if-exists=${f}`),
    '--test',
    '--test-reporter=tap',
    ...(opts.concurrency ? [`--test-concurrency=${opts.concurrency}`] : []),
    ...files.map((f) => path.relative(SERVER_ROOT, f).replace(/\\/g, '/')),
  ];

  console.log(`[tests] ${opts.dir}: ${files.length} файлов${opts.strict ? ' (строгий режим: skip = ошибка)' : ''}`);
  const child = spawn(process.execPath, args, { cwd: SERVER_ROOT, stdio: ['inherit', 'pipe', 'inherit'] });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk); // лог CI остаётся живым, а не появляется в конце
  });

  child.on('close', (code, signal) => {
    const c = parseTapSummary(output);
    const problems = [];

    if (code !== 0) problems.push(`node --test завершился с кодом ${code}${signal ? ` (сигнал ${signal})` : ''}`);
    if (opts.strict) {
      if (c.skipped) problems.push(`пропущено тестов: ${c.skipped} — в CI пропуск засчитывается как провал`);
      if (c.todo) problems.push(`todo-тестов: ${c.todo} — в CI незавершённый тест засчитывается как провал`);
      if (!c.pass) problems.push('не выполнено НИ ОДНОГО теста — набор не доказал ничего');
    }

    console.log(
      `[tests] ${opts.dir}: pass=${c.pass ?? '?'} fail=${c.fail ?? '?'} `
      + `skipped=${c.skipped ?? '?'} todo=${c.todo ?? '?'}`,
    );
    if (problems.length) {
      console.error(`[tests] НАБОР НЕ ЗАЧТЁН (${opts.dir}):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`[tests] ${opts.dir}: ok`);
    process.exit(0);
  });
}

main();
