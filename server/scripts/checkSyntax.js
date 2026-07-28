#!/usr/bin/env node
'use strict';

// Синтаксическая проверка ВСЕГО серверного кода: каждый .js обязан разбираться
// парсером Node — до тестов, до запуска, без подключения к БД и без сети.
//
// Почему не «просто запустить тесты»: серверные модули грузятся лениво
// (контроллеры — при первом обращении к маршруту, стадии — при первом прогоне),
// поэтому опечатка в редко используемом файле доживала до production. Здесь
// парсится КАЖДЫЙ файл, включая те, которые ни один тест не импортирует.
//
// Проверяется только СИНТАКСИС: файл не исполняется, побочных эффектов нет
// (импорт модуля выполнил бы его код). Каждый файл оборачивается в тот же
// модульный wrapper, что использует сам Node, — иначе `return` на верхнем
// уровне CommonJS-модуля выглядел бы синтаксической ошибкой.
//
//   node scripts/checkSyntax.js            # server/**/*.js
//   node scripts/checkSyntax.js ../client  # любой другой корень

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'dist', 'build', '.vite']);

function collect(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

// ESM (.mjs и файлы пакета с "type":"module") оборачивать в CommonJS-wrapper
// нельзя: import/export в нём — синтаксическая ошибка. Такие файлы проверяем
// как модуль (vm.SourceTextModule недоступен без флага, поэтому — сырой разбор).
function isEsm(file) {
  return path.extname(file) === '.mjs';
}

// Node сам срезает shebang перед разбором файла, vm.Script — нет: без этого
// любой исполняемый скрипт (`#!/usr/bin/env node`) выглядел бы сломанным.
function stripShebang(source) {
  return source.startsWith('#!') ? source.replace(/^#![^\n]*/, '') : source;
}

function checkFile(file) {
  const source = stripShebang(fs.readFileSync(file, 'utf8'));
  try {
    if (isEsm(file)) {
      // Разбор без исполнения: конструктор Script парсит, но не запускает.
      new vm.Script(source, { filename: file, importModuleDynamically: undefined });
    } else {
      new vm.Script(Module.wrap(source), { filename: file });
    }
    return null;
  } catch (err) {
    return err;
  }
}

function main() {
  const roots = process.argv.slice(2);
  const targets = (roots.length ? roots : [path.join(__dirname, '..')]).map((r) => path.resolve(r));

  const files = [];
  for (const root of targets) {
    if (!fs.existsSync(root)) {
      console.error(`[syntax] нет такого каталога: ${root}`);
      process.exit(1);
    }
    files.push(...collect(root));
  }

  const failures = [];
  for (const file of files) {
    const err = checkFile(file);
    if (err) failures.push({ file, err });
  }

  const rel = (f) => path.relative(process.cwd(), f).replace(/\\/g, '/');
  if (failures.length) {
    console.error(`[syntax] синтаксические ошибки: ${failures.length} из ${files.length} файлов`);
    for (const { file, err } of failures) {
      console.error(`  ✗ ${rel(file)}\n      ${err.message.split('\n')[0]}`);
    }
    process.exit(1);
  }

  if (!files.length) {
    console.error('[syntax] не найдено ни одного .js — проверять нечего, это ошибка конфигурации');
    process.exit(1);
  }
  console.log(`[syntax] ok: ${files.length} файлов разобрано без ошибок`);
}

main();
