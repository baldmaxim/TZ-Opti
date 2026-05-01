'use strict';

const { findInParagraphs, normalize } = require('./shared/fragmentMatcher');

/**
 * Стадия 1: ТЗ + Чек-лист + ВОР.
 *
 * Контракт: (context) → Issue[]
 * context = { tenderId, paragraphs, vorText, checklist, sourceDocumentId }
 *
 * Чек-лист — стандартный список работ. Поле in_calc хранит ответ инженера:
 *   1 — учтено в КП
 *   0 — не учтено
 *   NULL — не отвечал
 *
 * Принцип: замечание имеет смысл только если работа описана в ТЗ.
 * Если работы нет в ТЗ — её невозможно ни «удалить», ни «изменить» в ТЗ,
 * поэтому такие случаи НЕ выносим как замечания.
 *
 * Что флагуем:
 *   • работа упоминается в ТЗ, но помечена «не учтено» в КП → высокий риск
 *     («работа описана, но не оплачена — выполнят без оплаты»)
 *   • работа упоминается в ТЗ, статус в чек-листе не определён → средний риск
 *     («непонятно, входит в расчёт или нет — определитесь»)
 *
 * Что НЕ флагуем (отброшено по требованию пользователя):
 *   • работа отсутствует в ТЗ — независимо от статуса «учтено / не учтено / в ВОР»
 */
function runStage1(context) {
  const { paragraphs, vorText: _vorText, checklist, sourceDocumentId } = context;
  const issues = [];
  const tzNorm = normalize(paragraphs.map((p) => p.text).join('\n'));

  for (const item of checklist) {
    const work = (item.work_name || '').trim();
    if (!work) continue;

    // Без присутствия в ТЗ — нечего флагать.
    const inTzActual = tzNorm.includes(normalize(work));
    if (!inTzActual) continue;

    const accounted = item.in_calc; // 1 / 0 / null
    if (accounted === 1) continue;  // в ТЗ есть и в КП учтено — всё ок

    const hits = findInParagraphs(paragraphs, work);
    const hit = hits[0] || null;

    if (accounted === 0) {
      issues.push(buildIssue({
        sourceDocumentId,
        paragraph: hit,
        fragment: hit ? hit.fragment : work,
        problem_type: 'не_учтено_но_есть_в_ТЗ',
        risk_category: 'покрытие_расчёта',
        criticality: 'high',
        price_impact: 'высокое',
        schedule_impact: 'возможно',
        basis: `Работа «${work}» упоминается в ТЗ, но в чек-листе помечена как НЕ учтённая в КП.`,
        suggested_action: 'clarify',
        suggested_redaction: `Учесть в КП или вынести в допущения: «${work}».`,
        review_comment: 'Риск выполнения без оплаты. Требуется добавить позицию в КП либо явно исключить из объёма.',
        confidence: 0.8,
      }));
      continue;
    }

    // accounted === null: статус не указан, но работа в ТЗ есть.
    issues.push(buildIssue({
      sourceDocumentId,
      paragraph: hit,
      fragment: hit ? hit.fragment : work,
      problem_type: 'статус_не_определён',
      risk_category: 'покрытие_расчёта',
      criticality: 'medium',
      price_impact: 'возможно',
      schedule_impact: 'нет',
      basis: `Работа «${work}» упоминается в ТЗ, но в чек-листе по ней не указан статус «учтено / не учтено».`,
      suggested_action: 'clarify',
      suggested_redaction: `Принять решение по позиции «${work}» в чек-листе.`,
      review_comment: 'Не определён статус в чек-листе. Уточните, входит ли работа в КП.',
      confidence: 0.55,
    }));
  }

  return issues;
}

function buildIssue(p) {
  return {
    source_document_id: p.sourceDocumentId || null,
    source_clause: p.paragraph ? `п. ${p.paragraph.paragraph_index + 1}` : null,
    source_fragment: p.fragment,
    paragraph_index: p.paragraph ? p.paragraph.paragraph_index : null,
    char_start: p.paragraph ? p.paragraph.char_start : null,
    char_end: p.paragraph ? p.paragraph.char_end : null,
    problem_type: p.problem_type,
    risk_category: p.risk_category,
    criticality: p.criticality,
    price_impact: p.price_impact,
    schedule_impact: p.schedule_impact,
    basis: p.basis,
    suggested_action: p.suggested_action,
    suggested_redaction: p.suggested_redaction,
    review_comment: p.review_comment,
    confidence: p.confidence,
  };
}

module.exports = { runStage1 };
