'use strict';

// Юнит-тесты единого анализатора (unifiedAnalysis/unifiedIssueBuilder.js) — без
// БД и LLM. Проверяют чистое ядро assembleDrafts/groupSignals: один абзац даёт
// НЕСКОЛЬКО независимых draft_issues (разные проблемы не сливаются из-за
// пересечения диапазонов) и НЕСКОЛЬКО доказательств (совпадающие по смыслу
// сигналы собираются в одно замечание). Запуск: npm test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assembleDrafts } = require('../../services/unifiedAnalysis/unifiedIssueBuilder');

const T = 'tender-1';
const PARA = 5;

// Плоский сигнал в форме flattenSignal. По умолчанию — локализован в одном
// абзаце PARA с ПОЛНОСТЬЮ пересекающимся диапазоном 0..120 (симулирует прежнее
// поведение llmStage, когда весь абзац шёл одним диапазоном): так тест проверяет,
// что пересечение диапазонов САМО ПО СЕБЕ больше не сливает замечания.
function sig(over) {
  return {
    id: over.id,
    signal_type: over.signal_type || 'risk',
    analysis_stage: over.analysis_stage ?? 4,
    tz_clause: over.tz_clause ?? 'п. 4.1 Объём работ',
    source_fragment: over.source_fragment ?? 'фрагмент',
    weight: over.weight ?? 0.7,
    problem_type: over.problem_type ?? null,
    risk_category: over.risk_category ?? null,
    criticality: over.criticality ?? 'high',
    suggested_action: over.suggested_action ?? null,
    suggested_redaction: over.suggested_redaction ?? null,
    review_comment: over.review_comment ?? null,
    basis: over.basis ?? null,
    paragraph_index: over.paragraph_index ?? PARA,
    char_start: over.char_start ?? 0,
    char_end: over.char_end ?? 120,
    context_text: over.context_text ?? null,
  };
}

// --- ГЛАВНЫЙ РЕГРЕСС ------------------------------------------------------------
// Один абзац содержит три независимые проблемы: неопределённый объём,
// дополнительные работы за счёт подрядчика и риск срока. Ожидаем ТРИ отдельных
// draft_issue, несмотря на общий абзац и полностью пересекающиеся диапазоны.

test('один абзац: неопределённый объём + доп. работы за счёт ГП + риск срока → три замечания', () => {
  const signals = [
    sig({
      id: 's-scope',
      problem_type: 'открытый_объём',
      risk_category: 'объём',
      suggested_action: 'limit_scope',
      basis: 'Объём работ не определён — «по факту».',
      source_fragment: 'объём работ определяется по факту выполнения',
    }),
    sig({
      id: 's-extra',
      problem_type: 'доп_работы_за_счёт_гп',
      risk_category: 'оплата',
      suggested_action: 'remove_from_scope',
      basis: 'Дополнительные работы выполняются за счёт подрядчика.',
      source_fragment: 'дополнительные работы выполняются за счёт подрядчика',
    }),
    sig({
      id: 's-term',
      problem_type: 'риск_срока',
      risk_category: 'срок',
      suggested_action: 'clarify',
      basis: 'Срок 30 дней без привязки к передаче фронта.',
      source_fragment: 'срок выполнения — 30 календарных дней',
    }),
  ];

  const drafts = assembleDrafts(signals, T, null);

  assert.equal(drafts.length, 3, 'три разные проблемы одного абзаца → три draft_issues');
  // каждое замечание — из одного своего сигнала (ничего не слиплось)
  assert.ok(drafts.every((d) => d.created_from_signal_ids.length === 1));
  const byProblem = Object.fromEntries(drafts.map((d) => [d.problem_type, d]));
  assert.equal(byProblem['открытый_объём'].suggested_action, 'limit_scope');
  assert.equal(byProblem['доп_работы_за_счёт_гп'].suggested_action, 'remove_from_scope');
  assert.equal(byProblem['риск_срока'].suggested_action, 'clarify');
  // основания сохранены пофрагментно, а не свёрнуты в одно
  assert.match(byProblem['открытый_объём'].basis, /Объём работ не определён/);
  assert.match(byProblem['доп_работы_за_счёт_гп'].basis, /за счёт подрядчика/);
  assert.match(byProblem['риск_срока'].basis, /Срок 30 дней/);
});

// --- несколько ДОКАЗАТЕЛЬСТВ одного замечания ----------------------------------

test('совпадающие по смыслу сигналы одного абзаца → одно замечание с несколькими доказательствами', () => {
  const signals = [
    sig({
      id: 's-cov', signal_type: 'coverage', analysis_stage: 1,
      problem_type: 'открытый_объём', risk_category: 'объём',
      suggested_action: 'limit_scope', suggested_redaction: 'Ограничить объём Приложением 1',
      basis: 'Объём не ограничен (покрытие расчёта).',
    }),
    sig({
      id: 's-risk', signal_type: 'risk', analysis_stage: 4,
      problem_type: 'открытый_объём', risk_category: 'объём',
      suggested_action: 'limit_scope', suggested_redaction: null, // доказательство без своей правки
      basis: 'Тот же открытый объём как типовой риск.',
    }),
  ];

  const drafts = assembleDrafts(signals, T, null);
  assert.equal(drafts.length, 1, 'одна проблема, подтверждённая двумя стадиями → одно замечание');
  assert.equal(drafts[0].created_from_signal_ids.length, 2, 'две доказательные основы');
  assert.equal(drafts[0].category, 'coverage+risk', 'сведены типы сигналов разных стадий');
  assert.equal(drafts[0].suggested_redaction, 'Ограничить объём Приложением 1', 'правка взята у сигнала-носителя');
});

// --- границы совместимости: действие / рекомендация ----------------------------

test('одинаковая проблема, но КОНФЛИКТУЮЩИЕ рекомендации → два замечания', () => {
  const signals = [
    sig({ id: 'r1', problem_type: 'формулировка', risk_category: 'договор',
      suggested_action: 'replace', suggested_redaction: 'Вариант А' }),
    sig({ id: 'r2', problem_type: 'формулировка', risk_category: 'договор',
      suggested_action: 'replace', suggested_redaction: 'Вариант Б (иной)' }),
  ];
  const drafts = assembleDrafts(signals, T, null);
  assert.equal(drafts.length, 2, 'разные непустые правки конфликтуют — не сливаем');
});

test('одно место, разные семейства действий (убрать vs уточнить) → два замечания', () => {
  const signals = [
    sig({ id: 'a-remove', problem_type: null, risk_category: 'объём', suggested_action: 'remove_from_scope' }),
    sig({ id: 'a-note', problem_type: null, risk_category: 'объём', suggested_action: 'clarify' }),
  ];
  const drafts = assembleDrafts(signals, T, null);
  assert.equal(drafts.length, 2, 'убрать из объёма ≠ уточнить — разные действия, разные замечания');
});

// --- context_text доносится до draft --------------------------------------------

test('context_text (полный абзац) переносится в draft_issue', () => {
  const full = 'Объём работ определяется по факту; доп. работы за счёт подрядчика; срок 30 дней.';
  const drafts = assembleDrafts(
    [sig({ id: 's1', problem_type: 'открытый_объём', context_text: full, source_fragment: 'по факту' })],
    T,
    null,
  );
  assert.equal(drafts[0].context_text, full);
  assert.equal(drafts[0].source_fragment, 'по факту', 'source_fragment — точная цитата, а не весь абзац');
});
