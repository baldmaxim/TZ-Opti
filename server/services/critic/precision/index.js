'use strict';

// PRECISION-КРИТИК — независимая проверка draft_issues перед публикацией.
// Двухуровневая:
//   УРОВЕНЬ 1 (hardFilters.js) — детерминированные правила. Решают большинство
//             случаев без модели: редактура, повтор, нет последствия, пробел
//             покрытия ВОР, расширение объёма.
//   УРОВЕНЬ 2 (llmCritic.js)   — отдельная LLM-проверка ТОЛЬКО спорных, с
//             установкой «искать основания НЕ показывать».
//
// Что здесь: свод уровней, кросс-набор новизны (повторы видны только на всём
// наборе) и ПРАВИЛА НА СЛУЧАЙ СБОЯ КРИТИКА.
//
// FAIL-CLOSED. При полном сбое LLM-критика спорные замечания НЕ публикуются
// автоматически. Единственное исключение — эскалация: спорное замечание с
// НАДЁЖНЫМИ доказательствами и критическим/существенным последствием
// публикуется, потому что цена пропуска такого замечания (незамеченные
// обязательства ГП) выше цены лишней строки в списке. Всё остальное спорное
// остаётся нерешённым (`outcome: null`) — в модели материальности это `verify`,
// то есть полка «На проверку»: не опубликовано, но и не потеряно.
//
// Высокая confidence исходного агента НИГДЕ не является основанием публикации:
// в карту оценки она не входит, критику не показывается, в правилах не участвует.

const assessmentApi = require('./assessment');
const hardFiltersApi = require('./hardFilters');
const llm = require('./llmCritic');

const { applyHardFilters, contestedGaps, isPublished, OUTCOMES } = hardFiltersApi;

const { evidenceRank, consequenceRank, meaningKey, placeKey } = assessmentApi;

// Предел числа спорных замечаний, отправляемых модели за один прогон стадии.
// Превышение НЕ маскируется: остаток становится нерешённым и попадает в отчёт
// (`summary.precision.over_limit`) — «молча урезали» здесь недопустимо.
const DEFAULT_MAX_LLM_ITEMS = 60;

function resolveMaxItems() {
  const n = Number(process.env.PRECISION_CRITIC_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_LLM_ITEMS;
}

// LLM-уровень включён, если явно не выключен и ключ модели настроен.
// PRECISION_CRITIC=0 оставляет только детерминированные фильтры (спорные тогда
// не публикуются — то же fail-closed, что и при сбое).
function llmEnabled() {
  const flag = (process.env.PRECISION_CRITIC || '').trim();
  if (flag === '0' || flag.toLowerCase() === 'false' || flag.toLowerCase() === 'off') return false;
  return llm.isConfigured();
}

// --- Новизна (кросс-набор) ---------------------------------------------------
//
// Повтор виден только на ВСЁМ наборе: первое вхождение смысла — novel, второе и
// далее — duplicate. Совпадение места (пункт/абзац) при другом смысле —
// partial_duplicate: не отклоняем, помечаем (решает критик).
function markNovelty(items) {
  const seenMeaning = new Set();
  const seenPlace = new Set();
  const novelty = new Map();
  for (const item of items) {
    const draft = item.draft;
    const mk = meaningKey(draft);
    const pk = placeKey(draft);
    if (seenMeaning.has(mk)) {
      novelty.set(draft.id, 'duplicate');
    } else if (pk && seenPlace.has(pk)) {
      novelty.set(draft.id, 'partial_duplicate');
    } else {
      novelty.set(draft.id, 'novel');
    }
    seenMeaning.add(mk);
    if (pk) seenPlace.add(pk);
  }
  return novelty;
}

// --- Правила на случай нерешённого спорного замечания ------------------------

// Эскалация: спорное замечание публикуем БЕЗ критика только когда доказательства
// надёжны И последствие существенно. medium/low сюда не попадают никогда —
// именно это требует «не публиковать спорные medium/low при сбое критика».
function escalates(assessment) {
  return (
    evidenceRank(assessment.evidence_strength) >= evidenceRank('strong')
    && consequenceRank(assessment.business_consequence) >= consequenceRank('high')
    && assessment.actionability !== 'none'
  );
}

// --- Согласование решения LLM с детерминированными инвариантами --------------
//
// Модель может уточнить карту оценки, но не может нарушить инварианты:
//   • low/none последствие не публикуется НИКОГДА (даже если модель настаивает);
//   • заявленная моделью доказательность может ПОНИЗИТЬ структурную, но не поднять
//     (нет цитаты и обоснования — «strong» невозможно);
//   • повтор, найденный детерминированно, остаётся повтором.
// Так LLM работает как ФИЛЬТР (может только ужесточить), а не как второй источник
// оптимизма.
function reconcile(baseline, llmDecision) {
  const merged = {
    ...baseline,
    ...llmDecision.assessment,
    // Доказательность: минимум из структурной и заявленной моделью.
    evidence_strength:
      evidenceRank(llmDecision.assessment.evidence_strength) < evidenceRank(baseline.evidence_strength)
        ? llmDecision.assessment.evidence_strength
        : baseline.evidence_strength,
    // Повтор, установленный детерминированно, модель отменить не может.
    novelty: baseline.novelty === 'duplicate' ? 'duplicate' : llmDecision.assessment.novelty,
    signals: baseline.signals,
  };

  let outcome = llmDecision.outcome;
  const notes = [];

  if (!OUTCOMES.includes(outcome)) {
    return { assessment: merged, outcome: null, notes: ['критик не вернул исход по этому замечанию'] };
  }

  if (merged.novelty === 'duplicate' && isPublished(outcome)) {
    outcome = 'reject_invalid';
    notes.push('повтор установлен детерминированно — публикация отменена');
  }
  if (merged.evidence_strength === 'none' && isPublished(outcome)) {
    outcome = 'reject_invalid';
    notes.push('доказательств нет — публикация отменена');
  }
  if (isPublished(outcome) && consequenceRank(merged.business_consequence) <= consequenceRank('low')) {
    outcome = 'hide_informational';
    notes.push('последствие low/none — публикация запрещена правилом модели');
  }
  // publish_critical требует критического или существенного последствия.
  if (outcome === 'publish_critical' && consequenceRank(merged.business_consequence) < consequenceRank('high')) {
    outcome = 'publish_working';
    notes.push('последствие ниже существенного — понижено до рабочего списка');
  }

  return { assessment: merged, outcome, notes };
}

// --- Основной прогон ---------------------------------------------------------

// items: [{ draft, review }] — draft_issue + вердикт материальности
//        (criticService.evaluateDraft: веса критериев, число сигналов, признаки).
// Возвращает { decisions: Map<draftId, decision>, summary }.
// decision = {
//   outcome: 'publish_critical'|'publish_working'|'hide_informational'|'reject_invalid'|null,
//   source:  'hard_filter'|'llm'|'escalation'|'unresolved',
//   rule, reason, reasons_against[], assessment
// }
async function runPrecisionCritic(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const novelty = markNovelty(list);

  const decisions = new Map();
  const contested = [];

  // Уровень 1: детерминированные фильтры.
  for (const item of list) {
    const assessment = assessmentApi.buildAssessment(item.draft, item.review || {}, {
      novelty: novelty.get(item.draft.id),
    });
    const hard = applyHardFilters(assessment, item.draft);
    if (hard) {
      decisions.set(item.draft.id, {
        outcome: hard.outcome,
        source: 'hard_filter',
        rule: hard.rule,
        reason: hard.reason,
        reasons_against: isPublished(hard.outcome) ? [] : [hard.reason],
        assessment,
      });
      continue;
    }
    contested.push({ draft: item.draft, review: item.review || {}, assessment });
  }

  const summary = {
    total: list.length,
    hard_filtered: decisions.size,
    contested: contested.length,
    llm_checked: 0,
    llm_batches: 0,
    llm_failed_batches: 0,
    escalated: 0,
    unresolved: 0,
    over_limit: 0,
    llm_enabled: llmEnabled(),
    llm_error: null,
  };

  // Уровень 2: LLM-проверка спорных.
  const useLlm = options.llmEnabled != null ? Boolean(options.llmEnabled) : llmEnabled();
  const maxItems = options.maxItems != null ? Number(options.maxItems) : resolveMaxItems();
  const batchSize = options.batchSize != null ? Number(options.batchSize) : llm.resolveBatchSize();

  const toCheck = useLlm ? contested.slice(0, maxItems) : [];
  const overLimit = contested.slice(toCheck.length);
  summary.over_limit = useLlm ? overLimit.length : 0;
  summary.llm_enabled = useLlm;

  const llmResults = new Map();
  for (let i = 0; i < toCheck.length; i += batchSize) {
    const batch = toCheck.slice(i, i + batchSize);
    summary.llm_batches += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await llm.reviewBatch(batch, { model: options.model });
      for (const [id, decision] of res) llmResults.set(id, decision);
    } catch (err) {
      // Сбой пакета не роняет анализ и не публикует его замечания: они
      // останутся нерешёнными (либо уйдут в эскалацию по строгому правилу).
      summary.llm_failed_batches += 1;
      if (!summary.llm_error) summary.llm_error = err.message;
      // eslint-disable-next-line no-console
      console.warn(
        `[precisionCritic] пакет ${summary.llm_batches} (${batch.length} замечаний) не проверен: ${err.message}`,
      );
    }
  }

  // Свод спорных: решение критика → согласование с инвариантами; нет решения →
  // эскалация (только strong + high/critical) либо «нерешено».
  for (const item of contested) {
    const id = item.draft.id;
    const llmDecision = llmResults.get(id);
    if (llmDecision) {
      const { assessment, outcome, notes } = reconcile(item.assessment, llmDecision);
      if (outcome) {
        summary.llm_checked += 1;
        decisions.set(id, {
          outcome,
          source: 'llm',
          rule: 'llm_critic',
          reason: [llmDecision.reason, ...notes].filter(Boolean).join(' '),
          reasons_against: llmDecision.reasons_against,
          assessment,
        });
        continue;
      }
    }

    const gaps = contestedGaps(item.assessment);
    if (escalates(item.assessment)) {
      summary.escalated += 1;
      decisions.set(id, {
        outcome: 'publish_working',
        source: 'escalation',
        rule: 'escalated_without_critic',
        reason:
          'Критик точности недоступен, но доказательства надёжны и последствие существенно — '
          + 'замечание показано, чтобы не потерять дорогой риск. Проверьте вручную.',
        reasons_against: gaps,
        assessment: item.assessment,
      });
      continue;
    }

    summary.unresolved += 1;
    decisions.set(id, {
      outcome: null,
      source: 'unresolved',
      rule: 'critic_unavailable',
      reason: useLlm
        ? 'Спорное замечание не проверено критиком точности — автоматически не публикуется, требует проверки инженером.'
        : 'Критик точности отключён — спорное замечание автоматически не публикуется, требует проверки инженером.',
      reasons_against: gaps,
      assessment: item.assessment,
    });
  }

  summary.published = [...decisions.values()].filter((d) => isPublished(d.outcome)).length;
  summary.hidden = [...decisions.values()].filter((d) => d.outcome === 'hide_informational').length;
  summary.rejected = [...decisions.values()].filter((d) => d.outcome === 'reject_invalid').length;
  summary.by_outcome = [...decisions.values()].reduce((acc, d) => {
    const key = d.outcome || 'unresolved';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return { decisions, summary };
}

module.exports = {
  DEFAULT_MAX_LLM_ITEMS,
  OUTCOMES,
  isPublished,
  llmEnabled,
  resolveMaxItems,
  markNovelty,
  escalates,
  reconcile,
  runPrecisionCritic,
  // реэкспорт чистых слоёв — для тестов и debug-страниц
  assessment: assessmentApi,
  hardFilters: hardFiltersApi,
  llm,
};
