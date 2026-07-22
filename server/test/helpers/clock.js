'use strict';

// Контролируемые часы и ID для детерминированных тестов.
//   makeClock()     — «часы» с ручным шагом (передаются в код параметром);
//   makeIdFactory() — предсказуемая последовательность id;
//   installFakeClock(t) — глобальная подмена Date.now/new Date() с откатом
//     (для кода, который берёт время сам, — nowIso() в utils/ids.js).
// Отката ждать не надо: при переданном t уборка вешается на t.after.

const DEFAULT_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function makeClock(startMs = DEFAULT_EPOCH) {
  let now = startMs;
  return {
    now: () => now,
    iso: () => new Date(now).toISOString(),
    tick(ms = 1000) {
      now += ms;
      return now;
    },
    set(ms) {
      now = ms;
    },
  };
}

function makeIdFactory(prefix = 'id') {
  let n = 0;
  const next = () => `${prefix}-${String(++n).padStart(4, '0')}`;
  next.reset = () => {
    n = 0;
  };
  next.count = () => n;
  return next;
}

// Подменяет Date.now() и new Date() без аргументов. Возвращает clock + restore.
function installFakeClock(t, startMs = DEFAULT_EPOCH) {
  const clock = makeClock(startMs);
  const RealDate = Date;
  const realNow = Date.now;

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now());
      else super(...args);
    }
    static now() {
      return clock.now();
    }
  }

  global.Date = FakeDate;
  const restore = () => {
    global.Date = RealDate;
    RealDate.now = realNow;
  };
  if (t && typeof t.after === 'function') t.after(restore);
  return { clock, restore };
}

module.exports = { makeClock, makeIdFactory, installFakeClock, DEFAULT_EPOCH };
