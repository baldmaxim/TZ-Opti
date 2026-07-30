'use strict';

// Юнит-тесты чистой свёртки карты затронутого (impactService.summarizeStageImpact)
// — без БД и LLM. Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeStageImpact } = require('../../services/agreedVersion/impactService');

const seg = (index, over = {}) => ({
  index, heading_path: `${index + 1}. Раздел`, tokens: 1000, input_hash: `h${index}`, ...over,
});

test('summarizeStageImpact: все части в кэше → стадия не затронута', () => {
  const out = summarizeStageImpact(2, [seg(0), seg(1), seg(2)], [true, true, true]);
  assert.equal(out.stage, 2);
  assert.equal(out.total, 3);
  assert.equal(out.cached, 3);
  assert.equal(out.to_compute, 0);
  assert.equal(out.affected, false);
  assert.deepEqual(out.segments_to_compute, []);
});

test('summarizeStageImpact: изменённые части перечислены с местом и размером', () => {
  const out = summarizeStageImpact(1, [seg(0), seg(1), seg(2)], [true, false, false]);
  assert.equal(out.cached, 1);
  assert.equal(out.to_compute, 2);
  assert.equal(out.affected, true);
  assert.deepEqual(out.segments_to_compute.map((s) => s.index), [1, 2]);
  assert.equal(out.segments_to_compute[0].heading_path, '2. Раздел');
});

test('summarizeStageImpact: пустая нарезка — не затронута, нули', () => {
  const out = summarizeStageImpact(3, [], []);
  assert.deepEqual(
    { total: out.total, cached: out.cached, to_compute: out.to_compute, affected: out.affected },
    { total: 0, cached: 0, to_compute: 0, affected: false },
  );
});
