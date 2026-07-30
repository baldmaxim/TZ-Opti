'use strict';

// Precision-критик × находка «условие отсутствует» (безъякорная).
// Раньше любая находка без цитаты и абзаца погибала на no_anchor/no_evidence —
// класс «отсутствующее условие» структурно не мог дойти до инженера. Теперь:
//   • тип «условие_отсутствует» с обоснованием получает evidence 'medium'
//     (доказательство — реестр условий + агрегация всех частей ТЗ);
//   • правило condition_gap публикует high/critical последствие без модели;
//   • medium остаётся спорным (решает LLM-критик, fail-closed → «На проверку»);
//   • обычные безъякорные находки ДРУГИХ типов по-прежнему отклоняются.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAssessment } = require('../../services/critic/precision/assessment');
const { applyHardFilters } = require('../../services/critic/precision/hardFilters');

// Безъякорная находка отсутствующего условия (как её собирает Стадия 3).
const gapDraft = (over = {}) => ({
  problem_type: 'условие_отсутствует',
  source_fragment: null,
  paragraph_index: null,
  tz_clause: null,
  basis: 'Тема «Лимит совокупной ответственности» не обнаружена ни в одной из 7 частей ТЗ.',
  suggested_action: 'clarify',
  suggested_redaction: null,
  review_comment: 'Условие отсутствует. Действие: пункт для проверки проекта договора.',
  ...over,
});

// review-стаб: веса измерений → последствие (contract+payment высокие → critical).
const review = (weights) => ({ dimension_weights: weights, material_weight: 0, corroboration: 1 });

test('условие_отсутствует + обоснование: evidence medium, а не none', () => {
  const a = buildAssessment(gapDraft(), review({ contract: 3, responsibility: 3 }));
  assert.equal(a.evidence_strength, 'medium');
  assert.equal(a.signals.condition_gap, true);
  assert.equal(a.signals.anchored, false);
});

test('высокое последствие: правило condition_gap публикует без модели', () => {
  const a = buildAssessment(gapDraft(), review({ contract: 3 }));
  assert.equal(a.business_consequence, 'high');
  const d = applyHardFilters(a, gapDraft());
  assert.ok(d, 'решено жёстким правилом');
  assert.equal(d.rule, 'condition_gap');
  assert.equal(d.outcome, 'publish_working');
});

test('критическое последствие (несколько каналов) → publish_critical', () => {
  const a = buildAssessment(gapDraft(), review({ contract: 3, payment: 3 }));
  assert.equal(a.business_consequence, 'critical');
  const d = applyHardFilters(a, gapDraft());
  assert.equal(d.rule, 'condition_gap');
  assert.equal(d.outcome, 'publish_critical');
});

test('среднее последствие: спорное — уходит LLM-критику (fail-closed без него)', () => {
  const a = buildAssessment(gapDraft(), review({ schedule: 2 }));
  assert.equal(a.business_consequence, 'medium');
  const d = applyHardFilters(a, gapDraft());
  assert.equal(d, null, 'жёсткое правило не решает — спорное');
});

test('пробел БЕЗ обоснования отклоняется (no_evidence): льгота требует basis', () => {
  const draft = gapDraft({ basis: '' });
  const a = buildAssessment(draft, review({ contract: 3 }));
  assert.equal(a.evidence_strength, 'none');
  const d = applyHardFilters(a, draft);
  assert.equal(d.outcome, 'reject_invalid');
});

test('РЕГРЕСС: безъякорная находка ДРУГОГО типа по-прежнему гибнет на no_anchor', () => {
  const draft = gapDraft({ problem_type: 'типовой_риск' });
  const a = buildAssessment(draft, review({ contract: 3 }));
  assert.equal(a.signals.condition_gap, false);
  const d = applyHardFilters(a, draft);
  assert.equal(d.rule, 'no_anchor');
  assert.equal(d.outcome, 'reject_invalid');
});

test('якорные находки не задеты: цитата+абзац+обоснование дают прежнюю доказательность', () => {
  const draft = gapDraft({
    problem_type: 'условие_противоречит',
    source_fragment: 'Гарантийный срок составляет 10 лет.',
    paragraph_index: 12,
  });
  const a = buildAssessment(draft, review({ contract: 3 }));
  assert.equal(a.evidence_strength, 'medium');
  assert.equal(a.signals.anchored, true);
});
