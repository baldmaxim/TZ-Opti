'use strict';

// Юнит-тесты сопоставления решений при переносе между прогонами
// (matchDecisionsToClusters) — без БД. Проверяют: точное совпадение по cluster_key,
// фолбэк по месту (tz_clause) и по тексту фрагмента, отсутствие совпадения и
// конфликт (несколько решений на один кластер). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchDecisionsToClusters } = require('../../services/analysisRuns/analysisRunsService');

const cluster = (over) => ({ id: 'clu_new', cluster_key: null, tz_clause: null, source_fragment: null, ...over });
const decision = (over) => ({ id: 'dec1', decision: 'accept', cluster_key: null, tz_clause: null, source_fragment: null, ...over });

test('matchDecisionsToClusters: точное совпадение по cluster_key → exact, confidence 1', () => {
  const clusters = [cluster({ id: 'c_new', cluster_key: 'clause:1.2::price|remove' })];
  const decisions = [decision({ cluster_key: 'clause:1.2::price|remove' })];
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out.length, 1);
  assert.equal(out[0].match, 'exact');
  assert.equal(out[0].confidence, 1);
  assert.equal(out[0].cluster_id, 'c_new');
});

test('matchDecisionsToClusters: фолбэк по месту (tz_clause) когда ключ не совпал', () => {
  const clusters = [cluster({ id: 'c_place', cluster_key: 'other_key', tz_clause: '1.2 Объём работ' })];
  const decisions = [decision({ cluster_key: 'нет_такого', tz_clause: '1.2  Объём   работ' })]; // разница в пробелах
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out[0].match, 'place');
  assert.equal(out[0].cluster_id, 'c_place');
});

test('matchDecisionsToClusters: фолбэк по тексту фрагмента', () => {
  const clusters = [cluster({ id: 'c_text', cluster_key: 'k', source_fragment: 'Демонтаж перекрытий' })];
  const decisions = [decision({ cluster_key: 'нет', tz_clause: null, source_fragment: 'демонтаж перекрытий' })];
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out[0].match, 'text');
  assert.equal(out[0].cluster_id, 'c_text');
});

test('matchDecisionsToClusters: нет совпадения → match none, cluster_id null', () => {
  const clusters = [cluster({ id: 'c1', cluster_key: 'a', tz_clause: 'X', source_fragment: 'Y' })];
  const decisions = [decision({ cluster_key: 'b', tz_clause: 'Z', source_fragment: 'W' })];
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out[0].match, 'none');
  assert.equal(out[0].cluster_id, null);
});

test('matchDecisionsToClusters: два решения на один кластер → conflict', () => {
  const clusters = [cluster({ id: 'c_dup', cluster_key: 'k1' })];
  const decisions = [
    decision({ id: 'd1', cluster_key: 'k1' }),
    decision({ id: 'd2', cluster_key: 'k1' }),
  ];
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.conflict === true), 'оба помечены конфликтом');
  assert.ok(out.every((p) => p.cluster_id === 'c_dup'));
});

test('matchDecisionsToClusters: приоритет exact над place', () => {
  // Есть кластер с точным ключом И другой кластер с тем же местом — берём точный.
  const clusters = [
    cluster({ id: 'c_exact', cluster_key: 'k', tz_clause: '1.2' }),
    cluster({ id: 'c_place', cluster_key: 'other', tz_clause: '1.2' }),
  ];
  const decisions = [decision({ cluster_key: 'k', tz_clause: '1.2' })];
  const out = matchDecisionsToClusters(decisions, clusters);
  assert.equal(out[0].match, 'exact');
  assert.equal(out[0].cluster_id, 'c_exact');
});
