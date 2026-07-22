'use strict';

// Временные каталоги/файлы для тестов с гарантированной уборкой.
// Всё создаётся в os.tmpdir() под префиксом tz-opti-test-, ничего не пишется
// в рабочее дерево репозитория и в server/uploads.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];

// Создаёт временный каталог. Если передан объект node:test (t) — уборка
// вешается на t.after, иначе — на выход процесса (см. cleanupAll ниже).
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-opti-test-'));
  created.push(dir);
  if (t && typeof t.after === 'function') {
    t.after(() => removeTmpDir(dir));
  }
  return dir;
}

// Пишет файл во временный каталог, возвращает абсолютный путь.
function writeTmpFile(dir, name, content) {
  const fp = path.join(dir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

function removeTmpDir(dir) {
  if (!dir || !dir.includes('tz-opti-test-')) return; // защита от rm чужого пути
  fs.rmSync(dir, { recursive: true, force: true });
  const i = created.indexOf(dir);
  if (i >= 0) created.splice(i, 1);
}

function cleanupAll() {
  for (const dir of [...created]) removeTmpDir(dir);
}

process.on('exit', cleanupAll);

module.exports = { makeTmpDir, writeTmpFile, removeTmpDir, cleanupAll };
