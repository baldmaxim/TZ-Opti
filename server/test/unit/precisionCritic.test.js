'use strict';

// Юнит-тесты PRECISION-КРИТИКА — независимой проверки draft_issues перед
// публикацией. Без БД; LLM подменяется fake-провайдером (реальный вызов в
// тестовом процессе запрещён самим openaiClient).
//
// Что защищаем:
//   • УРОВЕНЬ 1 — детерминированные жёсткие фильтры решают типовые случаи без
//     модели: стилистическая правка, проблема без последствия, дубликат,
//     слабое предположение, противоречие ВОР, расширение объёма;
//   • УРОВЕНЬ 2 — к LLM уходят ТОЛЬКО спорные, и модель работает как фильтр:
//     может ужесточить решение, но не может опубликовать low/none и не может
//     отменить детерминированно установленный повтор;
//   • FAIL-CLOSED — при полном сбое критика спорные medium/low НЕ публикуются;
//   • высокая confidence исходного агента не публикует замечание сама по себе.
//
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installFakeLlm } = require('../helpers/fakeLlm');
const critic = require('../../services/critic/criticService');
const precision = require('../../services/critic/precision');
const { applyHardFilters } = require('../../services/critic/precision/hardFilters');
const { buildAssessment } = require('../../services/critic/precision/assessment');

// --- Фикстуры ----------------------------------------------------------------

let seq = 0;
function draft(extra = {}) {
  seq += 1;
  return {
    id: extra.id || `d${seq}`,
    tz_clause: '3.1 Объём работ',
    source_fragment: 'Подрядчик выполняет работы.',
    context_text: null,
    problem_type: null,
    category: 'risk',
    basis: 'Обоснование замечания.',
    review_comment: null,
    suggested_action: 'replace',
    suggested_redaction: null,
    confidence: 0.7,
    created_from_signal_ids: [],
    paragraph_index: 4,
    ...extra,
  };
}

function signal(extra = {}) {
  return {
    id: extra.id || 's1',
    problem_type: null,
    risk_category: null,
    criticality: 'medium',
    evidence_level: null,
    impact_dimensions: [],
    materiality_flags: [],
    ...extra,
  };
}

// Один прогон критика над набором замечаний. signals — по одному набору на драфт.
async function runCritic(items, options = {}) {
  const prepared = items.map(({ d, signals }) => ({
    draft: d,
    review: critic.evaluateDraft(d, signals || [signal()]),
  }));
  return precision.runPrecisionCritic(prepared, { llmEnabled: false, ...options });
}

// Решение по одному замечанию (по умолчанию LLM выключен — проверяем уровень 1).
async function decide(d, signals, options = {}) {
  const { decisions } = await runCritic([{ d, signals }], options);
  return decisions.get(d.id);
}

// --- Требуемые сценарии ------------------------------------------------------

test('стилистическая правка скрывается', async () => {
  const d = draft({
    category: 'decision',
    source_fragment: 'В пункте 4.3 нарушена сквозная нумерация подпунктов.',
    basis: 'Опечатка в нумерации: подпункты идут не по порядку.',
    suggested_action: 'comment',
  });
  const decision = await decide(d);
  assert.equal(decision.outcome, 'hide_informational');
  assert.equal(decision.source, 'hard_filter');
  assert.equal(decision.rule, 'editorial');
  // Замечание лежит в денежном разделе («3.1 Объём работ»), поэтому критерии
  // компании дают ненулевой вес — но опечатка остаётся опечаткой: правило
  // редактуры срабатывает, пока последствие не выше среднего.
  assert.ok(['none', 'low', 'medium'].includes(decision.assessment.business_consequence));
  assert.ok(decision.reason, 'причина скрытия обязана быть названа');
  assert.equal(precision.isPublished(decision.outcome), false);
});

test('проблема без последствия скрывается', async () => {
  const d = draft({
    // Раздел нейтральный: критерии компании ловят и заголовок («… Объём работ»),
    // поэтому «нет последствия» проверяем на описательном разделе.
    tz_clause: '1.2 Общие сведения об объекте',
    category: 'decision',
    source_fragment: 'Объект расположен в границах существующей застройки квартала.',
    basis: 'Приведено описание местоположения площадки.',
    suggested_action: 'comment',
  });
  const decision = await decide(d);
  assert.equal(decision.outcome, 'hide_informational');
  assert.equal(decision.rule, 'no_consequence');
  // Все пять каналов пусты — именно это и означает «последствия нет».
  for (const key of ['scope_impact', 'cost_impact', 'schedule_impact', 'contract_impact', 'responsibility_impact']) {
    assert.equal(decision.assessment[key], 'none', `${key} должен быть none`);
  }
});

test('противоречие ВОР публикуется', async () => {
  const d = draft({
    category: 'coverage',
    problem_type: 'не_в_обоих',
    source_fragment: 'Подрядчик выполняет демонтаж существующих железобетонных конструкций.',
    basis: 'Работа требуется ТЗ, но в ВОР не учтена и в чек-листе не значится — прямой недоучёт стоимости.',
    suggested_action: 'replace',
  });
  const decision = await decide(d, [signal({ problem_type: 'не_в_обоих', risk_category: 'покрытие_расчёта' })]);
  assert.ok(precision.isPublished(decision.outcome), `outcome=${decision.outcome}`);
  assert.equal(decision.source, 'hard_filter');
  assert.equal(decision.rule, 'coverage_conflict');
  assert.equal(decision.assessment.cost_impact, 'high');
  assert.ok(['high', 'critical'].includes(decision.assessment.business_consequence));
});

test('расширение объёма публикуется', async () => {
  const d = draft({
    category: 'risk',
    source_fragment: 'Подрядчик выполняет весь комплекс работ собственными силами и за свой счёт.',
    basis: 'Формулировка возлагает на ГП работы сверх расчёта — открытый объём обязательств.',
    suggested_action: 'limit_scope',
  });
  const decision = await decide(d, [signal({ risk_category: 'объём_и_обязательства' })]);
  assert.ok(precision.isPublished(decision.outcome), `outcome=${decision.outcome}`);
  assert.equal(decision.source, 'hard_filter');
  assert.ok(['scope_expansion', 'strong_critical', 'strong_high'].includes(decision.rule), `rule=${decision.rule}`);
  assert.equal(decision.assessment.scope_impact, 'high');
  assert.equal(decision.assessment.actionability, 'actionable');
});

test('дубликат отклоняется', async () => {
  const first = draft({
    id: 'dup-1',
    category: 'coverage',
    problem_type: 'не_в_обоих',
    source_fragment: 'Подрядчик выполняет демонтаж существующих железобетонных конструкций.',
    basis: 'Работа требуется ТЗ, но в ВОР не учтена — прямой недоучёт стоимости.',
  });
  // То же требование, вынесенное второй раз (другой абзац, тот же смысл).
  const second = draft({ ...first, id: 'dup-2', paragraph_index: 11 });

  const sig = [signal({ problem_type: 'не_в_обоих', risk_category: 'покрытие_расчёта' })];
  const { decisions } = await runCritic([{ d: first, signals: sig }, { d: second, signals: sig }]);

  assert.ok(precision.isPublished(decisions.get('dup-1').outcome), 'первое вхождение публикуется');
  const dup = decisions.get('dup-2');
  assert.equal(dup.outcome, 'reject_invalid');
  assert.equal(dup.rule, 'duplicate');
  assert.equal(dup.assessment.novelty, 'duplicate');
});

test('слабое предположение скрывается', async () => {
  const d = draft({
    category: 'risk',
    source_fragment: 'Работы выполняются в сроки, согласованные сторонами.',
    // Обоснования нет — доказательность слабая; вывод сформулирован догадкой.
    basis: null,
    review_comment: 'Возможно, сроки сдвинутся и подрядчику придётся ускоряться.',
    suggested_action: 'clarify',
  });
  const decision = await decide(d);
  assert.equal(decision.outcome, 'hide_informational');
  assert.equal(decision.rule, 'weak_assumption');
  assert.equal(decision.assessment.evidence_strength, 'weak');
  assert.equal(precision.isPublished(decision.outcome), false);
});

// --- Уверенность агента не публикует ----------------------------------------

test('высокая confidence агента сама по себе не публикует замечание', async () => {
  const base = {
    tz_clause: '1.2 Общие сведения об объекте',
    category: 'decision',
    source_fragment: 'Объект расположен в границах существующей застройки квартала.',
    basis: 'Описание расположения объекта.',
    suggested_action: 'comment',
  };
  const low = await decide(draft({ ...base, id: 'conf-low', confidence: 0.3 }));
  const high = await decide(draft({ ...base, id: 'conf-high', confidence: 0.99 }));
  assert.equal(low.outcome, high.outcome, 'confidence не меняет исход');
  assert.equal(high.outcome, 'hide_informational');
  // И criticality сигнала тоже не публикует.
  const critical = await decide(
    draft({ ...base, id: 'conf-crit', confidence: 0.99 }),
    [signal({ criticality: 'critical' })],
  );
  assert.equal(critical.outcome, 'hide_informational');
});

test('карта критика не содержит confidence и criticality исходного агента', async () => {
  const d = draft({ confidence: 0.99 });
  const decision = await decide(d, [signal({ criticality: 'critical' })]);
  const serialized = JSON.stringify(decision.assessment);
  assert.ok(!/confidence/i.test(serialized), 'confidence не должен попадать в карту оценки');
  assert.ok(!/criticality/i.test(serialized), 'criticality не должен попадать в карту оценки');
});

// --- Уровень 2: LLM-проверка спорных ----------------------------------------

// Спорное замечание: последствие medium (один критерий среднего веса),
// доказательства не надёжны — жёсткие правила его не решают.
function contestedDraft(extra = {}) {
  return draft({
    category: 'condition',
    source_fragment: 'Приёмка выполненных работ производится комиссией заказчика.',
    basis: 'Порядок приёмки задан заказчиком в одностороннем порядке.',
    suggested_action: 'replace',
    ...extra,
  });
}

test('спорное замечание уходит в LLM-критика, и только оно', async (t) => {
  const llm = installFakeLlm(t, [
    {
      decisions: [
        {
          id: 'c1',
          evidence_strength: 'medium',
          business_consequence: 'high',
          actionability: 'actionable',
          novelty: 'novel',
          scope_impact: 'none',
          cost_impact: 'medium',
          schedule_impact: 'none',
          contract_impact: 'high',
          responsibility_impact: 'none',
          outcome: 'publish_working',
          reasons_against: ['порядок приёмки типовой для заказчика'],
          reason: 'Одностороннее право приёмки смещает риск оплаты на ГП.',
        },
      ],
    },
  ]);

  const contested = contestedDraft({ id: 'c1' });
  const editorial = draft({
    id: 'c2',
    category: 'decision',
    source_fragment: 'В пункте 4.3 нарушена сквозная нумерация подпунктов.',
    basis: 'Опечатка в нумерации.',
    suggested_action: 'comment',
  });

  const { decisions, summary } = await runCritic(
    [{ d: contested }, { d: editorial }],
    { llmEnabled: true },
  );

  assert.equal(llm.callCount, 1, 'один пакет — один вызов');
  assert.equal(summary.contested, 1, 'к модели уходит только спорное');
  assert.equal(summary.hard_filtered, 1, 'редактура решена правилом, без модели');
  // Редактура в промт не попала.
  assert.ok(!llm.calls[0].user.includes('c2'), 'решённое правилом в промт не уходит');
  assert.ok(llm.calls[0].user.includes('c1'));
  // Уверенность агента модели не показывается.
  assert.ok(!/confidence/i.test(llm.calls[0].user), 'confidence агента не уходит критику');

  const decision = decisions.get('c1');
  assert.equal(decision.outcome, 'publish_working');
  assert.equal(decision.source, 'llm');
  assert.deepEqual(decision.assessment.reasons_against ?? decision.reasons_against, ['порядок приёмки типовой для заказчика']);
});

test('промт критика требует искать основания НЕ показывать', () => {
  const { SYSTEM_PROMPT } = precision.llm;
  assert.ok(/ОСНОВАНИЯ НЕ ПОКАЗЫВАТЬ/.test(SYSTEM_PROMPT));
  assert.ok(/сомнение трактуется В ПОЛЬЗУ СКРЫТИЯ/i.test(SYSTEM_PROMPT));
  assert.ok(/не является доводом\s+за публикацию/i.test(SYSTEM_PROMPT.replace(/\n/g, ' ')));
  for (const outcome of precision.OUTCOMES) {
    assert.ok(SYSTEM_PROMPT.includes(outcome), `в промте должен быть исход ${outcome}`);
  }
  for (const dim of ['evidence_strength', 'business_consequence', 'actionability', 'novelty',
    'scope_impact', 'cost_impact', 'schedule_impact', 'contract_impact', 'responsibility_impact']) {
    assert.ok(SYSTEM_PROMPT.includes(dim), `в промте должно быть измерение ${dim}`);
  }
});

test('LLM не может опубликовать замечание с последствием low/none', async (t) => {
  installFakeLlm(t, [
    {
      decisions: [{
        id: 'c1',
        evidence_strength: 'strong',
        business_consequence: 'low',
        actionability: 'actionable',
        novelty: 'novel',
        scope_impact: 'low',
        cost_impact: 'none',
        schedule_impact: 'none',
        contract_impact: 'none',
        responsibility_impact: 'none',
        outcome: 'publish_critical',
        reasons_against: [],
        reason: 'Модель настаивает на публикации.',
      }],
    },
  ]);
  const { decisions } = await runCritic([{ d: contestedDraft({ id: 'c1' }) }], { llmEnabled: true });
  const decision = decisions.get('c1');
  assert.equal(decision.outcome, 'hide_informational', 'low не публикуется, что бы ни сказала модель');
  assert.ok(/low\/none/.test(decision.reason));
});

test('LLM не может отменить детерминированно установленный повтор', async (t) => {
  installFakeLlm(t, [
    {
      decisions: [{
        id: 'dup-b',
        evidence_strength: 'strong',
        business_consequence: 'high',
        actionability: 'actionable',
        novelty: 'novel',
        scope_impact: 'none',
        cost_impact: 'high',
        schedule_impact: 'none',
        contract_impact: 'none',
        responsibility_impact: 'none',
        outcome: 'publish_working',
        reasons_against: [],
        reason: 'Модель считает замечание новым.',
      }],
    },
  ]);
  // Оба спорные (нет обоснования → доказательства слабые), второй — повтор
  // первого по смыслу. Повтор ловится жёстким фильтром ДО модели.
  const a = contestedDraft({ id: 'dup-a' });
  const b = contestedDraft({ id: 'dup-b' });
  const { decisions } = await runCritic([{ d: a }, { d: b }], { llmEnabled: true });
  assert.equal(decisions.get('dup-b').outcome, 'reject_invalid');
  assert.equal(decisions.get('dup-b').rule, 'duplicate');
});

// --- Fail-closed при сбое критика -------------------------------------------

test('полный сбой LLM-критика: спорные medium/low НЕ публикуются автоматически', async (t) => {
  installFakeLlm(t, [new Error('bridge down')]);

  const d = contestedDraft({ id: 'fail-1' });
  const { decisions, summary } = await runCritic([{ d }], { llmEnabled: true });

  const decision = decisions.get('fail-1');
  assert.equal(decision.outcome, null, 'нерешённое замечание не получает исхода');
  assert.equal(decision.source, 'unresolved');
  assert.equal(precision.isPublished(decision.outcome), false);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.llm_failed_batches, 1);
  assert.ok(summary.llm_error, 'причина сбоя сохраняется в отчёте');
  assert.ok(decision.reasons_against.length, 'видно, чего замечанию не хватило');
});

test('сбой критика: замечание с надёжными доказательствами и крупным риском эскалируется', async (t) => {
  installFakeLlm(t, [new Error('bridge down')]);

  // Спорное только из-за частичного повтора места; доказательства strong
  // (две независимые стадии), последствие high.
  const d = draft({
    id: 'esc-1',
    category: 'condition+risk',
    source_fragment: 'Гарантийный срок на выполненные работы составляет 60 месяцев.',
    basis: 'Гарантия вдвое выше стандарта компании — прямая договорная ответственность ГП.',
    suggested_action: 'replace',
  });
  const { decisions, summary } = await runCritic(
    [{ d, signals: [signal({ id: 'a' }), signal({ id: 'b' })] }],
    { llmEnabled: true },
  );
  const decision = decisions.get('esc-1');
  if (decision.source === 'hard_filter') {
    // Правило уровня 1 решило само — эскалация не понадобилась, это тоже верно.
    assert.ok(precision.isPublished(decision.outcome));
    return;
  }
  assert.equal(decision.source, 'escalation');
  assert.equal(decision.outcome, 'publish_working');
  assert.equal(summary.escalated, 1);
  assert.ok(/недоступен/i.test(decision.reason), 'в причине видно, что критик не отработал');
});

test('критик выключен (PRECISION_CRITIC=0): спорные не публикуются, правила работают', async () => {
  const contested = contestedDraft({ id: 'off-1' });
  const editorial = draft({
    id: 'off-2',
    category: 'decision',
    source_fragment: 'В пункте 4.3 нарушена сквозная нумерация подпунктов.',
    basis: 'Опечатка в нумерации.',
    suggested_action: 'comment',
  });
  const { decisions, summary } = await runCritic(
    [{ d: contested }, { d: editorial }],
    { llmEnabled: false },
  );
  assert.equal(summary.llm_batches, 0, 'без критика модель не вызывается');
  assert.equal(decisions.get('off-1').outcome, null);
  assert.equal(decisions.get('off-2').outcome, 'hide_informational');
});

test('предел числа спорных не маскируется: остаток виден в отчёте', async (t) => {
  installFakeLlm(t, [{ decisions: [] }]);
  const items = [1, 2, 3].map((i) => ({
    d: contestedDraft({
      id: `lim-${i}`,
      paragraph_index: 10 + i,
      // Разные места и формулировки: иначе замечания были бы повторами друг
      // друга и отсеялись бы жёстким фильтром, не дойдя до лимита.
      tz_clause: `7.${i} Порядок приёмки`,
      source_fragment: `Приёмка этапа ${i} производится комиссией заказчика.`,
      basis: `Порядок приёмки этапа ${i} задан заказчиком в одностороннем порядке.`,
    }),
  }));
  const { summary } = await runCritic(items, { llmEnabled: true, maxItems: 1, batchSize: 5 });
  assert.equal(summary.contested, 3);
  assert.equal(summary.over_limit, 2, 'сколько замечаний не поместилось в лимит — видно');
});

// --- Свод с моделью материальности ------------------------------------------

test('исход критика становится вердиктом строки issue_reviews', () => {
  const d = draft({ suggested_action: 'replace' });
  const review = critic.evaluateDraft(d, [signal()]);

  const published = critic.mergePrecisionDecision(review, {
    outcome: 'publish_working',
    source: 'hard_filter',
    rule: 'scope_expansion',
    reason: 'Расширение объёма.',
    reasons_against: [],
    assessment: buildAssessment(d, review, { novelty: 'novel' }),
  }, d);
  assert.equal(published.verdict, 'publish');
  assert.equal(published.show_to_engineer, true);
  assert.equal(published.critic_outcome, 'publish_working');
  assert.ok(published.publication_reason);

  const hidden = critic.mergePrecisionDecision(review, {
    outcome: 'hide_informational',
    source: 'hard_filter',
    rule: 'no_consequence',
    reason: 'Нет последствия.',
    reasons_against: ['нет влияния'],
    assessment: buildAssessment(d, review, { novelty: 'novel' }),
  }, d);
  assert.equal(hidden.verdict, 'suppress');
  assert.equal(hidden.show_to_engineer, false);
  assert.equal(hidden.suppression_reason, 'Нет последствия.');

  const unresolved = critic.mergePrecisionDecision(review, {
    outcome: null,
    source: 'unresolved',
    rule: 'critic_unavailable',
    reason: 'Критик недоступен.',
    reasons_against: ['не проверено'],
    assessment: buildAssessment(d, review, { novelty: 'novel' }),
  }, d);
  assert.equal(unresolved.verdict, 'verify', 'нерешённое — на полку «На проверку», не в публикацию');
  assert.equal(unresolved.show_to_engineer, false);
  assert.equal(unresolved.critic_outcome, null);
});

// --- Карта оценки ------------------------------------------------------------

test('карта оценки заполняет все 9 измерений значениями из словарей', () => {
  const d = draft();
  const review = critic.evaluateDraft(d, [signal()]);
  const a = buildAssessment(d, review, { novelty: 'novel' });
  const { assessment } = precision;
  assert.ok(assessment.EVIDENCE_STRENGTH.includes(a.evidence_strength));
  assert.ok(assessment.BUSINESS_CONSEQUENCE.includes(a.business_consequence));
  assert.ok(assessment.ACTIONABILITY.includes(a.actionability));
  assert.ok(assessment.NOVELTY.includes(a.novelty));
  for (const key of assessment.IMPACT_KEYS) {
    assert.ok(assessment.IMPACT_LEVELS.includes(a[key]), `${key}=${a[key]}`);
  }
});

test('жёсткие фильтры дают ровно одну названную причину', () => {
  const d = draft({
    category: 'decision',
    source_fragment: 'Опечатка в нумерации таблиц приложения.',
    basis: 'Оформительская неточность.',
    suggested_action: 'comment',
  });
  const review = critic.evaluateDraft(d, [signal()]);
  const a = buildAssessment(d, review, { novelty: 'novel' });
  const hard = applyHardFilters(a, d);
  assert.ok(hard, 'правило обязано сработать');
  assert.equal(typeof hard.rule, 'string');
  assert.equal(typeof hard.reason, 'string');
  assert.ok(precision.OUTCOMES.includes(hard.outcome));
});
