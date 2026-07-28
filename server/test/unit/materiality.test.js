'use strict';

// Юнит-тесты МОДЕЛИ МАТЕРИАЛЬНОСТИ замечания — без БД, без сети, без LLM.
//
// Что защищаем (правила модели, services/review/materiality.js):
//   1. publish  — есть конкретный существенный риск И достаточные доказательства;
//   2. verify   — риск может быть существенным, но доказательств недостаточно;
//   3. suppress — редактура, дубль, стандартное требование, отсутствие влияния
//                 либо неподтверждённое предположение;
//   4. criticality и confidence НЕ подменяют impact и evidence;
//   5. low-impact не публикуется даже при высокой уверенности;
//   6. high-impact со слабым evidence уходит в verify;
//   7. старые данные переносятся безопасно (fromLegacyPriority).
//
// Ядро матрицы проверяется ПОЛНОСТЬЮ: все 5 уровней влияния × 3 уровня
// доказательности (15 клеток) — и на чистой функции, и через слой critic.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../../services/review/materiality');
const { evaluateDraft, impactFromWeight } = require('../../services/critic/criticService');

// --- Матрица impact × evidence ----------------------------------------------

// Ожидаемая матрица, выписанная НЕЗАВИСИМО от реализации: тест обязан падать,
// если кто-то поменяет клетку в VERDICT_MATRIX.
const EXPECTED = {
  critical: { strong: 'publish', medium: 'publish', weak: 'verify' },
  high: { strong: 'publish', medium: 'publish', weak: 'verify' },
  medium: { strong: 'publish', medium: 'verify', weak: 'verify' },
  low: { strong: 'suppress', medium: 'suppress', weak: 'suppress' },
  none: { strong: 'suppress', medium: 'suppress', weak: 'suppress' },
};

test('матрица impact × evidence: все 15 клеток дают ожидаемый вердикт', () => {
  let checked = 0;
  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      const r = m.resolveVerdict({
        impactLevel: impact,
        evidenceLevel: evidence,
        dimensions: ['price', 'contract'],
      });
      assert.equal(
        r.verdict,
        EXPECTED[impact][evidence],
        `impact=${impact} × evidence=${evidence} → ожидался ${EXPECTED[impact][evidence]}, получен ${r.verdict}`,
      );
      assert.equal(r.impact_level, impact);
      assert.equal(r.evidence_level, evidence);
      checked += 1;
    }
  }
  assert.equal(checked, 15, 'матрица покрыта целиком: 5 уровней влияния × 3 доказательности');
});

test('матрица: причина заполнена по вердикту (publish → publication_reason, suppress → suppression_reason)', () => {
  for (const impact of m.IMPACT_LEVELS) {
    for (const evidence of m.EVIDENCE_LEVELS) {
      const r = m.resolveVerdict({ impactLevel: impact, evidenceLevel: evidence, dimensions: ['price'] });
      assert.ok(r.verdict_reason, `${impact}/${evidence}: объяснение вердикта обязательно`);
      if (r.verdict === 'publish') {
        assert.ok(r.publication_reason, `${impact}/${evidence}: publish обязан объяснить, почему публикуется`);
        assert.equal(r.suppression_reason, null);
      } else if (r.verdict === 'suppress') {
        assert.ok(r.suppression_reason, `${impact}/${evidence}: suppress обязан объяснить, почему скрыто`);
        assert.equal(r.publication_reason, null);
      } else {
        assert.equal(r.publication_reason, null, 'verify не публикуется');
        assert.equal(r.suppression_reason, null, 'verify не скрыто — оно на проверке');
      }
    }
  }
});

test('правило 5: low-impact не публикуется даже при strong evidence', () => {
  const r = m.resolveVerdict({ impactLevel: 'low', evidenceLevel: 'strong', dimensions: ['price'] });
  assert.equal(r.verdict, 'suppress');
  assert.ok(/нет материального влияния/.test(r.suppression_reason));
});

test('правило 6: high-impact со weak evidence уходит в verify, а не публикуется и не скрывается', () => {
  const r = m.resolveVerdict({ impactLevel: 'high', evidenceLevel: 'weak', dimensions: ['contract'] });
  assert.equal(r.verdict, 'verify');
  assert.equal(r.publication_reason, null);
  assert.equal(r.suppression_reason, null);
  assert.ok(/доказательств для публикации недостаточно/.test(r.verdict_reason));
});

test('правило 3: жёсткий флаг (редактура/дубль/стандартное требование) перебивает матрицу', () => {
  for (const flag of m.SUPPRESSION_FLAGS) {
    const r = m.resolveVerdict({
      impactLevel: 'critical',
      evidenceLevel: 'strong',
      dimensions: ['price', 'contract'],
      suppressionFlags: [flag],
    });
    assert.equal(r.verdict, 'suppress', `флаг ${flag} обязан скрывать замечание`);
    assert.ok(r.suppression_reason, `флаг ${flag}: причина обязательна`);
    assert.deepEqual(r.suppression_flags, [flag]);
  }
});

test('спорное (contested): флаг агента против материальных критериев → verify, не suppress', () => {
  const r = m.resolveVerdict({
    impactLevel: 'high',
    evidenceLevel: 'strong',
    dimensions: ['contract'],
    suppressionFlags: ['duplicate'],
    contested: true,
  });
  assert.equal(r.verdict, 'verify', 'мнение модели не скрывает материальный риск');
  assert.equal(r.suppression_reason, null);
  assert.ok(/критерии компании/.test(r.verdict_reason));
});

// --- Fail-closed нормализация -----------------------------------------------

test('неизвестные значения нормализуются fail-closed (не публикуем по ошибке)', () => {
  assert.equal(m.normalizeImpactLevel('чёрт знает что'), 'none');
  assert.equal(m.normalizeEvidenceLevel('чёрт знает что'), 'weak');
  assert.equal(m.normalizeVerdict('чёрт знает что'), 'verify', 'неизвестный вердикт → verify (не теряем и не публикуем)');
  assert.equal(m.normalizeRequiredAction('чёрт знает что'), 'none');
  assert.deepEqual(m.normalizeDimensions(['чёрт знает что']), []);
  // Мусорный вход не может дать publish.
  const r = m.resolveVerdict({ impactLevel: 'ага', evidenceLevel: 'ну да' });
  assert.equal(r.verdict, 'suppress');
});

test('русские/свободные формулировки от модели приводятся к словарю', () => {
  assert.equal(m.normalizeImpactLevel('Высокое'), 'high');
  assert.equal(m.normalizeImpactLevel('критично'), 'critical');
  assert.equal(m.normalizeEvidenceLevel('слабое'), 'weak');
  assert.equal(m.normalizeEvidenceLevel('надёжно подтверждено'), 'strong');
  assert.deepEqual(m.normalizeDimensions(['стоимость', 'сроки', 'оплата']), ['price', 'schedule', 'payment']);
  assert.deepEqual(m.normalizeDimensions('price, contract'), ['price', 'contract']);
  assert.deepEqual(m.normalizeSuppressionFlags(['это редактура']), ['editorial']);
  assert.deepEqual(m.normalizeSuppressionFlags(['material']), [], 'material — не флаг подавления');
});

test('измерения нормализуются в канонический порядок без дублей', () => {
  const dims = m.mergeDimensions(['contract', 'price'], ['price', 'scope'], []);
  assert.deepEqual(dims, ['price', 'contract', 'scope']);
});

// --- Доказательность по структурным фактам ----------------------------------

test('evidence: без привязки к тексту ТЗ или без обоснования — не выше weak', () => {
  assert.equal(m.structuralEvidence({ anchored: false, hasBasis: true, corroboration: 5 }), 'weak');
  assert.equal(m.structuralEvidence({ anchored: true, hasBasis: false, corroboration: 5 }), 'weak');
  assert.equal(m.structuralEvidence({ anchored: true, hasBasis: true, corroboration: 1 }), 'medium');
  assert.equal(m.structuralEvidence({ anchored: true, hasBasis: true, corroboration: 2 }), 'strong');
});

test('evidence: заявленное агентом может ПОНИЗИТЬ структурную оценку, но не поднять', () => {
  const base = { anchored: true, hasBasis: true, corroboration: 1 }; // структурно medium
  assert.equal(m.resolveEvidence({ ...base, declared: 'strong' }), 'medium', 'поднять нельзя');
  assert.equal(m.resolveEvidence({ ...base, declared: 'weak' }), 'weak', 'понизить можно');
  assert.equal(m.resolveEvidence({ ...base, declared: null }), 'medium');
  assert.equal(
    m.resolveEvidence({ anchored: false, hasBasis: false, declared: 'strong' }),
    'weak',
    'модель не вправе объявить strong там, где нет ни цитаты, ни обоснования',
  );
});

// --- Требуемое действие ------------------------------------------------------

test('required_action: suppress → none, verify → ask_customer', () => {
  assert.equal(m.resolveRequiredAction({ verdict: 'suppress', suggestedAction: 'delete' }), 'none');
  assert.equal(m.resolveRequiredAction({ verdict: 'verify', suggestedAction: 'delete' }), 'ask_customer');
});

test('required_action для publish: по семейству действия и измерениям влияния', () => {
  const publish = (suggestedAction, dimensions = []) =>
    m.resolveRequiredAction({ verdict: 'publish', suggestedAction, dimensions });
  assert.equal(publish('delete'), 'exclude_scope');
  assert.equal(publish('remove_from_scope'), 'exclude_scope');
  assert.equal(publish('replace'), 'amend_tz');
  assert.equal(publish('limit_scope'), 'amend_tz');
  assert.equal(publish('edit'), 'amend_tz', 'легаси edit → замена формулировки');
  assert.equal(publish('assumption'), 'add_assumption');
  assert.equal(publish('clarify'), 'ask_customer');
  assert.equal(publish('comment', ['price']), 'recalculate');
  assert.equal(publish('comment', ['scope']), 'recalculate');
  assert.equal(publish('comment', ['contract']), 'amend_tz');
  assert.equal(publish('comment', ['payment']), 'amend_tz');
  assert.equal(publish('comment', []), 'ask_customer');
  // Любое значение — из словаря (ничего не выдумывается).
  for (const a of ['delete', 'replace', 'clarify', 'comment', 'assumption', null]) {
    assert.ok(m.REQUIRED_ACTIONS.includes(publish(a)), `${a} → значение вне словаря`);
  }
});

// --- Агрегация (сигналы группы / элементы кластера) -------------------------

test('агрегация: вердикт кластера — сильнейший, влияние/доказательность — максимум', () => {
  assert.equal(m.strongestVerdict(['suppress', 'verify', 'publish']), 'publish');
  assert.equal(m.strongestVerdict(['suppress', 'verify']), 'verify');
  assert.equal(m.strongestVerdict(['suppress']), 'suppress');
  assert.equal(m.strongestVerdict([]), 'suppress');
  assert.equal(m.maxImpact(['low', 'critical', 'medium']), 'critical');
  assert.equal(m.maxEvidence(['weak', 'medium']), 'medium');
});

// --- Правило 7: безопасный перенос старых данных ----------------------------

test('перенос старых строк: важное остаётся видимым, прочее — на проверку/в скрытые', () => {
  const critical = m.fromLegacyPriority({ displayPriority: 'critical', shownToEngineer: true });
  assert.equal(critical.verdict, 'publish', 'что инженер видел как важное — остаётся видимым');
  assert.equal(critical.impact_level, 'critical');

  const high = m.fromLegacyPriority({ displayPriority: 'high', shownToEngineer: true });
  assert.equal(high.verdict, 'publish');

  const medium = m.fromLegacyPriority({ displayPriority: 'medium', shownToEngineer: true });
  assert.equal(medium.verdict, 'verify', 'прежнее medium нельзя признать доказанным — на проверку');

  const low = m.fromLegacyPriority({ displayPriority: 'low', shownToEngineer: false });
  assert.equal(low.verdict, 'suppress');
  assert.ok(low.suppression_reason);

  // Скрытое прежней моделью не всплывает наверх, даже если приоритет был высоким.
  const hidden = m.fromLegacyPriority({ displayPriority: 'critical', shownToEngineer: false });
  assert.equal(hidden.verdict, 'suppress');

  // Пометка «перенесено» есть у всех — видно, что уровень не рассчитан заново.
  for (const r of [critical, high, medium, low, hidden]) {
    assert.ok(
      String(r.verdict_reason).includes(m.LEGACY_REASON_PREFIX),
      'причина обязана показывать, что уровень перенесён из прежней модели',
    );
    assert.ok(m.REQUIRED_ACTIONS.includes(r.required_action));
  }
});

test('перенос: неизвестный/пустой прежний приоритет не публикуется', () => {
  for (const priority of [null, undefined, '', 'нечто']) {
    const r = m.fromLegacyPriority({ displayPriority: priority, shownToEngineer: true });
    assert.notEqual(r.verdict, 'publish', `приоритет ${String(priority)} не должен давать publish`);
  }
});

// --- Правило 4: criticality и confidence НЕ подменяют impact и evidence ------
// (проверяем на слое critic — именно он считает авторитетный вердикт)

function draft(extra = {}) {
  return {
    id: 'd1',
    tz_clause: null,
    source_fragment: 'Подрядчик выполняет работы за свой счёт.',
    problem_type: null,
    category: 'risk',
    basis: 'Возлагает на ГП неоплачиваемые работы.',
    review_comment: null,
    confidence: 0.7,
    suggested_action: 'replace',
    created_from_signal_ids: [],
    paragraph_index: 3,
    ...extra,
  };
}
function signal(extra = {}) {
  return {
    id: 's1', problem_type: null, risk_category: null, criticality: 'medium',
    evidence_level: null, impact_dimensions: [], materiality_flags: [], ...extra,
  };
}

test('правило 4: criticality сигнала не меняет impact/evidence/verdict', () => {
  const results = ['critical', 'high', 'medium', 'low'].map((crit) =>
    evaluateDraft(draft(), [signal({ criticality: crit })]));
  const first = results[0];
  for (const r of results) {
    assert.equal(r.impact_level, first.impact_level, 'impact не зависит от criticality');
    assert.equal(r.evidence_level, first.evidence_level, 'evidence не зависит от criticality');
    assert.equal(r.verdict, first.verdict, 'вердикт не зависит от criticality');
  }
  // Легаси-поле сортировки при этом РАЗНОЕ — значит criticality учитывается
  // только там, где и должна (score/display_priority), и никуда не протекла.
  assert.notEqual(results[0].score, results[3].score);
});

test('правило 4: confidence сборки не меняет impact/evidence/verdict', () => {
  const lo = evaluateDraft(draft({ confidence: 0.3 }), [signal()]);
  const hi = evaluateDraft(draft({ confidence: 0.99 }), [signal()]);
  assert.equal(lo.impact_level, hi.impact_level);
  assert.equal(lo.evidence_level, hi.evidence_level);
  assert.equal(lo.verdict, hi.verdict);
});

test('правило 5 в critic: редактура с confidence 0.99 и criticality=critical всё равно скрыта', () => {
  const r = evaluateDraft(
    draft({
      category: 'decision',
      source_fragment: 'В пункте 4.3 опечатка в нумерации подпунктов.',
      basis: 'Редакционная неточность.',
      confidence: 0.99,
    }),
    [signal({ criticality: 'critical' })],
  );
  assert.equal(r.impact_level, 'none');
  assert.equal(r.verdict, 'suppress');
  assert.equal(r.show_to_engineer, false);
  assert.ok(/редактура/.test(r.suppression_reason), `причина: ${r.suppression_reason}`);
});

test('правило 6 в critic: материальный риск без обоснования уходит в verify', () => {
  const r = evaluateDraft(
    draft({ basis: null, review_comment: null }),
    [signal({ risk_category: 'объём_и_обязательства' })],
  );
  assert.ok(['critical', 'high'].includes(r.impact_level), `impact=${r.impact_level}`);
  assert.equal(r.evidence_level, 'weak', 'без обоснования доказательность слабая');
  assert.equal(r.verdict, 'verify');
  assert.equal(r.show_to_engineer, false, 'на проверку — не в основной список');
  assert.equal(r.required_action, 'ask_customer');
});

test('правило 1 в critic: материальный риск с обоснованием и двумя источниками публикуется', () => {
  const r = evaluateDraft(
    draft({ category: 'coverage+risk' }),
    [signal({ id: 'a', risk_category: 'объём_и_обязательства' }), signal({ id: 'b', risk_category: 'покрытие_расчёта' })],
  );
  assert.equal(r.evidence_level, 'strong', 'две независимые стадии = strong');
  assert.equal(r.verdict, 'publish');
  assert.equal(r.show_to_engineer, true);
  assert.ok(r.publication_reason);
  assert.equal(r.required_action, 'amend_tz');
  assert.ok(r.impact_dimensions.length, 'измерения влияния заполнены');
});

test('critic: измерения материальности включают payment и scope (не только легаси-четвёрку)', () => {
  const payment = evaluateDraft(
    draft({
      category: 'condition',
      source_fragment: 'Оплата выполненных работ производится после подписания КС-2 и КС-3 заказчиком.',
      basis: 'Приёмка и оплата смещаются — кассовый разрыв у ГП.',
    }),
    [signal()],
  );
  assert.ok(payment.impact_dimensions.includes('payment'), `dims=${payment.impact_dimensions}`);

  const scope = evaluateDraft(
    draft({
      source_fragment: 'Подрядчик выполняет весь комплекс работ в полном объёме за свой счёт.',
      basis: 'Открытый объём — работы вне расчёта.',
    }),
    [signal()],
  );
  assert.ok(scope.impact_dimensions.includes('scope'), `dims=${scope.impact_dimensions}`);
});

test('critic: явный флаг агента скрывает нематериальное, но спорит с материальным', () => {
  // Нематериальное + флаг → скрыто с причиной агента.
  const suppressed = evaluateDraft(
    draft({ category: 'decision', source_fragment: 'Указан неверный номер приложения.', basis: 'Ссылка на приложение.' }),
    [signal({ materiality_flags: ['duplicate'] })],
  );
  assert.equal(suppressed.verdict, 'suppress');
  assert.ok(/дубль/.test(suppressed.suppression_reason));

  // Материальное + флаг → не скрываем, отправляем на проверку.
  const contested = evaluateDraft(
    draft({ category: 'coverage+risk' }),
    [
      signal({ id: 'a', risk_category: 'объём_и_обязательства', materiality_flags: ['standard_requirement'] }),
      signal({ id: 'b', risk_category: 'покрытие_расчёта', materiality_flags: ['standard_requirement'] }),
    ],
  );
  assert.equal(contested.verdict, 'verify', 'материальный риск не скрывается по мнению модели');
});

test('critic: уровень влияния считается по весам материальных критериев', () => {
  assert.equal(impactFromWeight(0), 'none');
  assert.equal(impactFromWeight(1), 'low');
  assert.equal(impactFromWeight(2), 'medium');
  assert.equal(impactFromWeight(3), 'high');
  assert.equal(impactFromWeight(6), 'critical');
  // Монотонность: больше веса — не ниже уровень.
  let prev = 0;
  for (let w = 0; w <= 12; w += 1) {
    const rank = m.impactRank(impactFromWeight(w));
    assert.ok(rank >= prev, `вес ${w}: уровень влияния не должен падать`);
    prev = rank;
  }
});

// --- Слой draft_issues: оценка АГЕНТОВ доезжает до замечания -----------------

const { assembleDrafts, flattenSignal } = require('../../services/unifiedAnalysis/unifiedIssueBuilder');

// Сырая строка analysis_signals (как её читает unifiedIssueBuilder).
function signalRow(id, payload = {}) {
  return {
    id,
    signal_type: payload.signal_type || 'risk',
    analysis_stage: payload.analysis_stage || 4,
    tz_clause: 'п. 5.1',
    source_fragment: 'Подрядчик выполняет работы за свой счёт.',
    weight: 0.8,
    signal_payload_json: JSON.stringify({
      problem_type: 'типовой_риск',
      criticality: 'high',
      basis: 'Работы вне расчёта.',
      suggested_action: 'replace',
      paragraph_index: 3,
      char_start: 0,
      char_end: 40,
      ...payload,
    }),
  };
}

test('draft_issue: оценка агента (impact/evidence/измерения) доезжает из сигнала в замечание', () => {
  const signals = [signalRow('s1', {
    impact_level: 'high',
    evidence_level: 'medium',
    impact_dimensions: ['scope', 'price'],
  })].map(flattenSignal);
  const [draft] = assembleDrafts(signals, 'tender-1', null);
  assert.equal(draft.impact_level, 'high');
  assert.equal(draft.evidence_level, 'medium');
  assert.deepEqual(draft.impact_dimensions, ['price', 'scope']);
  assert.equal(draft.verdict, 'publish');
  assert.ok(draft.publication_reason);
  assert.equal(draft.required_action, 'amend_tz');
});

test('draft_issue: агент не оценил влияние → impact пуст, вердикт verify (не «влияния нет»)', () => {
  const signals = [signalRow('s1')].map(flattenSignal);
  const [draft] = assembleDrafts(signals, 'tender-1', null);
  assert.equal(draft.impact_level, null, '«не оценил» не превращается в «влияния нет»');
  assert.equal(draft.verdict, 'verify');
  assert.equal(draft.publication_reason, null);
  assert.equal(draft.suppression_reason, null);
});

test('draft_issue: флаг «не материально» применяется, только если так сказали ВСЕ сигналы', () => {
  const flagged = [
    signalRow('s1', { impact_level: 'high', materiality_flags: ['editorial'] }),
    signalRow('s2', { signal_type: 'coverage', analysis_stage: 1, impact_level: 'high', materiality_flags: ['editorial'] }),
  ].map(flattenSignal);
  const [suppressed] = assembleDrafts(flagged, 'tender-1', null);
  assert.equal(suppressed.verdict, 'suppress');
  assert.ok(/редактура/.test(suppressed.suppression_reason));

  const mixed = [
    signalRow('s1', { impact_level: 'high', materiality_flags: ['editorial'] }),
    signalRow('s2', { signal_type: 'coverage', analysis_stage: 1, impact_level: 'high' }),
  ].map(flattenSignal);
  const [kept] = assembleDrafts(mixed, 'tender-1', null);
  assert.notEqual(kept.verdict, 'suppress', 'один материальный сигнал сохраняет замечание живым');
});

test('draft_issue: заявленный агентом strong не поднимает доказательность без обоснования', () => {
  const signals = [signalRow('s1', {
    impact_level: 'critical',
    evidence_level: 'strong',
    basis: null,
  })].map(flattenSignal);
  const [draft] = assembleDrafts(signals, 'tender-1', null);
  assert.equal(draft.evidence_level, 'weak');
  assert.equal(draft.verdict, 'verify', 'critical + weak → на проверку (правило 6)');
});

test('critic: все поля модели заполнены значениями из словарей', () => {
  const r = evaluateDraft(draft(), [signal()]);
  assert.ok(m.IMPACT_LEVELS.includes(r.impact_level));
  assert.ok(m.EVIDENCE_LEVELS.includes(r.evidence_level));
  assert.ok(m.VERDICTS.includes(r.verdict));
  assert.ok(m.REQUIRED_ACTIONS.includes(r.required_action));
  assert.ok(Array.isArray(r.impact_dimensions));
  for (const d of r.impact_dimensions) assert.ok(m.IMPACT_DIMENSIONS.includes(d));
});
