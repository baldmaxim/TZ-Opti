'use strict';

// УРОВЕНЬ 1 precision-критика: ДЕТЕРМИНИРОВАННЫЕ жёсткие фильтры.
// Чистый модуль (без БД, LLM и сети) — вся логика тестируется офлайн.
//
// Идея двухуровневой проверки. Большинство замечаний решаются БЕЗ модели:
// редактура, повтор, отсутствие последствия, пробел покрытия ВОР, расширение
// объёма — это факты, а не суждения. Правило здесь ОДНОЗНАЧНО и воспроизводимо,
// поэтому его не надо каждый раз перепроверять у LLM (и платить за это).
// К модели уходит только то, что жёсткие правила решить НЕ смогли (`contested`).
//
// Порядок проверок важен: сначала «замечание невалидно» (нечего показывать,
// повтор), затем «валидно, но показывать не нужно», и только потом «показываем».
// Правило, сработавшее раньше, останавливает разбор — так у каждого решения есть
// РОВНО ОДНА названная причина, а не список совпавших эвристик.
//
// Исходы (спека критика):
//   publish_critical   — показать в первую очередь;
//   publish_working    — показать в рабочем списке;
//   hide_informational — замечание верное, но инженеру в списке не нужно;
//   reject_invalid     — замечание невалидно (не на что указать / повтор).
// `null` = спорное: решает УРОВЕНЬ 2 (LLM-критик).

const {
  evidenceRank,
  consequenceRank,
} = require('./assessment');

const OUTCOMES = Object.freeze([
  'publish_critical',
  'publish_working',
  'hide_informational',
  'reject_invalid',
]);

const PUBLISHED = Object.freeze(['publish_critical', 'publish_working']);
const isPublished = (outcome) => PUBLISHED.includes(outcome);

// Типы проблем, где пробел покрытия — МАШИННЫЙ факт (сверка ТЗ ↔ ВОР ↔ чек-лист
// детерминирована, см. vor/vorMatchIndex.js), а не суждение агента. Такие
// замечания не отдаём на переоценку модели: она не видела ведомость.
const COVERAGE_PROBLEM_TYPES = new Set([
  'не_учтено_в_кп',
  'не_учтено_в_вор',
  'не_в_обоих',
  'qa_исключено_из_кп',
]);

// Критерии компании, означающие рост объёма/обязанностей ГП (criticService.CRITERIA).
const SCOPE_CRITERIA = new Set(['expands_scope', 'new_obligation']);

// Правила. Каждое: key, outcome (или null = спорное), reason(ru), test(assessment, draft).
// null-outcome правил здесь нет — «спорное» это отсутствие сработавшего правила.
const RULES = [
  // --- Невалидные замечания ------------------------------------------------
  // Исключение: находка «условие отсутствует» (signals.condition_gap) безъякорна
  // ПО ОПРЕДЕЛЕНИЮ — она указывает на пробел, а не на формулировку; её судьбу
  // решают правила ниже (condition_gap / последствие), а не отсутствие цитаты.
  {
    key: 'no_anchor',
    outcome: 'reject_invalid',
    reason: 'Не на что указать: в замечании нет ни цитаты ТЗ, ни пункта, ни абзаца.',
    test: (a) => !a.signals.has_quote && !a.signals.has_place && !a.signals.condition_gap,
  },
  {
    key: 'duplicate',
    outcome: 'reject_invalid',
    reason: 'Повтор: это же требование ТЗ уже вынесено другим замечанием.',
    test: (a) => a.novelty === 'duplicate',
  },
  {
    key: 'no_evidence',
    outcome: 'reject_invalid',
    reason: 'Нет доказательств: ни привязки к тексту ТЗ, ни обоснования — проверить утверждение нечем.',
    test: (a) => a.evidence_strength === 'none',
  },

  // --- Валидные, но показывать не нужно ------------------------------------
  // Порог «≤ medium», а не «нет материального веса»: критерии компании
  // срабатывают в том числе на ЗАГОЛОВОК раздела («… › Объём работ» даёт вес
  // всему, что в разделе), поэтому опечатка внутри денежного раздела иначе
  // переставала быть опечаткой. Редактура с КРУПНЫМ последствием (например,
  // перепутанный номер в пункте про оплату) правилом не решается — уходит критику.
  {
    key: 'editorial',
    outcome: 'hide_informational',
    reason: 'Редактура: замечание про оформление текста, коммерческие и договорные условия не меняются.',
    test: (a) => a.signals.editorial && consequenceRank(a.business_consequence) <= consequenceRank('medium'),
  },
  {
    key: 'standard_requirement',
    outcome: 'hide_informational',
    reason: 'Стандартное требование (нормативы / обычная практика) — ГП исполняет его и так.',
    test: (a) => a.signals.standard_requirement && consequenceRank(a.business_consequence) <= consequenceRank('medium'),
  },
  {
    key: 'no_consequence',
    outcome: 'hide_informational',
    reason: 'Нет последствия: замечание не влияет ни на объём, ни на стоимость, ни на срок, ни на договор, ни на ответственность ГП.',
    test: (a) => a.business_consequence === 'none',
  },
  {
    key: 'weak_assumption',
    outcome: 'hide_informational',
    reason: 'Слабое предположение: вывод сделан догадкой, доказательств в ТЗ нет, а возможные потери ограничены.',
    test: (a) =>
      evidenceRank(a.evidence_strength) <= evidenceRank('weak')
      && a.signals.assumption_language
      && consequenceRank(a.business_consequence) <= consequenceRank('medium'),
  },
  {
    key: 'not_actionable',
    outcome: 'hide_informational',
    reason: 'Нечего делать: замечание не ведёт ни к правке ТЗ, ни к выносу из объёма, ни к вопросу заказчику.',
    test: (a) =>
      a.actionability === 'none'
      && consequenceRank(a.business_consequence) <= consequenceRank('medium'),
  },
  {
    key: 'low_consequence',
    outcome: 'hide_informational',
    reason: 'Последствие незначительное — в основной список такие замечания не попадают.',
    test: (a) => a.business_consequence === 'low',
  },

  // --- Показываем ----------------------------------------------------------
  // Пробел покрытия ВОР/КП — машинный факт: работа в ТЗ есть, в ведомости или
  // расчёте её нет. Публикуем, не спрашивая модель.
  {
    key: 'coverage_conflict',
    outcome: null, // считается ниже: critical или working по последствию
    reason: 'Пробел покрытия: работа требуется ТЗ, но не отражена в ВОР/расчёте — прямой недоучёт.',
    test: (a, draft) =>
      COVERAGE_PROBLEM_TYPES.has(draft.problem_type)
      && a.signals.anchored
      && a.signals.has_basis
      && evidenceRank(a.evidence_strength) >= evidenceRank('medium')
      && consequenceRank(a.business_consequence) >= consequenceRank('medium'),
    outcomeFor: (a) =>
      a.business_consequence === 'critical' ? 'publish_critical' : 'publish_working',
  },
  // Расширение объёма / новая обязанность ГП: формулировка ТЗ прямо возлагает
  // работы за счёт подрядчика. Тоже факт формулировки, а не оценка.
  {
    key: 'scope_expansion',
    outcome: null,
    reason: 'Расширение объёма: формулировка ТЗ возлагает на ГП работы или обязанности сверх расчёта.',
    test: (a) =>
      (a.signals.criteria || []).some((k) => SCOPE_CRITERIA.has(k))
      && a.signals.anchored
      && a.signals.has_basis
      && evidenceRank(a.evidence_strength) >= evidenceRank('medium')
      && consequenceRank(a.business_consequence) >= consequenceRank('high'),
    outcomeFor: (a) =>
      a.business_consequence === 'critical' ? 'publish_critical' : 'publish_working',
  },
  // Отсутствующее существенное условие: пробел найден агрегацией по ВСЕМ частям
  // ТЗ против реестра условий компании (детерминированный шаг), обоснование
  // обязательно. Тяжёлые темы (critical/high последствие) публикуются без
  // модели; medium остаётся спорным — решит LLM-критик (или полка «На
  // проверку», если критик выключен, — fail-closed).
  {
    key: 'condition_gap',
    outcome: null,
    reason: 'Существенное условие отсутствует в ТЗ и пакете — правильная реакция (запрос/допущение/договор), а не правка текста.',
    test: (a) =>
      a.signals.condition_gap
      && a.signals.has_basis
      && consequenceRank(a.business_consequence) >= consequenceRank('high'),
    outcomeFor: (a) =>
      (a.business_consequence === 'critical' ? 'publish_critical' : 'publish_working'),
  },
  {
    key: 'strong_critical',
    outcome: 'publish_critical',
    reason: 'Критическое последствие для ГП при надёжных доказательствах.',
    test: (a) =>
      a.evidence_strength === 'strong'
      && a.business_consequence === 'critical'
      && a.actionability !== 'none',
  },
  {
    key: 'strong_high',
    outcome: 'publish_working',
    reason: 'Существенное последствие для ГП при надёжных доказательствах.',
    test: (a) =>
      a.evidence_strength === 'strong'
      && a.business_consequence === 'high'
      && a.actionability !== 'none',
  },
];

// Применяет жёсткие фильтры. Возвращает решение либо null (спорное → LLM).
//   { outcome, rule, reason }
function applyHardFilters(assessment, draft = {}) {
  for (const rule of RULES) {
    if (!rule.test(assessment, draft)) continue;
    const outcome = rule.outcome || rule.outcomeFor(assessment, draft);
    return { outcome, rule: rule.key, reason: rule.reason };
  }
  return null; // спорное: решает LLM-критик
}

// Почему замечание СПОРНОЕ — короткий список того, чего не хватило для
// однозначного решения. Уходит в промт критика как подсказка, что проверять.
function contestedGaps(assessment) {
  const gaps = [];
  if (evidenceRank(assessment.evidence_strength) < evidenceRank('strong')) {
    gaps.push('доказательства не надёжны (нет второй независимой стадии либо слабая привязка)');
  }
  if (assessment.business_consequence === 'medium') {
    gaps.push('последствие среднее — само по себе публикацию не оправдывает');
  }
  if (assessment.actionability === 'conditional') {
    gaps.push('действие зависит от ответа заказчика');
  }
  if (assessment.novelty === 'partial_duplicate') {
    gaps.push('похожее замечание по этому месту ТЗ уже есть');
  }
  if (assessment.signals.assumption_language) {
    gaps.push('формулировка похожа на предположение');
  }
  if (!gaps.length) gaps.push('однозначного правила не нашлось');
  return gaps;
}

module.exports = {
  OUTCOMES,
  PUBLISHED,
  isPublished,
  COVERAGE_PROBLEM_TYPES,
  SCOPE_CRITERIA,
  RULES,
  applyHardFilters,
  contestedGaps,
};
