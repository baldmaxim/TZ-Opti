'use strict';

// Реестр прогресса фоновых стадий — IN-MEMORY (без БД).
// Стадия считается в том же процессе, что отвечает на GET /tenders/:id/stages,
// поэтому хватает Map в памяти: фоновый прогон пишет сюда прогресс по сегментам,
// а getState читает. Реальный сигнал есть только у многосегментных стадий (1/4/5);
// стадии 2/3 — всегда 1 сегмент (один LLM-вызов, под-прогресса нет).
//
// Значение: { total, done, startedAt } — сколько сегментов всего, сколько готово,
// и момент старта (мс). Клиент строит из этого кольцо (детерминированное при
// total>1, иначе индетерминированное).

const registry = new Map();

function keyOf(tenderId, stage) {
  return `${tenderId}:${stage}`;
}

// Старт прогона: total ещё неизвестен (узнаём после сегментации) — ставим 0.
function init(tenderId, stage) {
  registry.set(keyOf(tenderId, stage), { total: 0, done: 0, startedAt: Date.now() });
}

// Зафиксировать число сегментов (после segmentBlocks).
function setTotal(tenderId, stage, total) {
  const cur = registry.get(keyOf(tenderId, stage));
  if (cur) cur.total = total;
}

// Один сегмент завершён.
function tick(tenderId, stage) {
  const cur = registry.get(keyOf(tenderId, stage));
  if (cur) cur.done += 1;
}

// Снимок для клиента ({ total, done, startedAt } или null, если прогон не идёт).
function get(tenderId, stage) {
  const cur = registry.get(keyOf(tenderId, stage));
  return cur ? { ...cur } : null;
}

// Очистка по завершении/ошибке прогона (чтобы следующий запуск стартовал с нуля).
function clear(tenderId, stage) {
  registry.delete(keyOf(tenderId, stage));
}

module.exports = { init, setTotal, tick, get, clear };
