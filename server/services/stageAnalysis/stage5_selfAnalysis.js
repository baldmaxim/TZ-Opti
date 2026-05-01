'use strict';

const { findInParagraphs } = require('./shared/fragmentMatcher');
const {
  HIDDEN_WORK_TRIGGERS,
  AMBIGUOUS_TRIGGERS,
  SCHEDULE_IMPACT_TRIGGERS,
} = require('./shared/phrases');

/**
 * Стадия 5: самоанализ ТЗ — скрытые работы / двусмыслия / срок.
 * context = { tenderId, paragraphs, sourceDocumentId }
 *
 * Прим.: ранее эта стадия была под номером 4. После добавления Стадии 3
 * «Существенные условия» сдвинута на 5.
 */
function runStage5(context) {
  const { paragraphs, sourceDocumentId } = context;
  const issues = [];

  for (const trigger of HIDDEN_WORK_TRIGGERS) {
    const hits = findInParagraphs(paragraphs, trigger.phrase);
    for (const hit of hits) {
      issues.push(makeIssue({
        sourceDocumentId,
        hit,
        problem_type: 'скрытые_работы',
        risk_category: 'объём_и_обязательства',
        criticality: 'high',
        price_impact: 'высокое',
        schedule_impact: 'возможно',
        basis: `Найден маркер «${hit.fragment}». ${trigger.hint}`,
        suggested_action: trigger.suggested_action,
        suggested_redaction: trigger.suggested_redaction,
        review_comment: trigger.hint,
        confidence: 0.75,
      }));
    }
  }

  for (const trigger of AMBIGUOUS_TRIGGERS) {
    const hits = findInParagraphs(paragraphs, trigger.phrase);
    for (const hit of hits) {
      issues.push(makeIssue({
        sourceDocumentId,
        hit,
        problem_type: 'двусмысленная_формулировка',
        risk_category: 'юридические_формулировки',
        criticality: 'medium',
        price_impact: 'возможно',
        schedule_impact: 'возможно',
        basis: `Найден маркер «${hit.fragment}». ${trigger.hint}`,
        suggested_action: 'clarify',
        suggested_redaction: 'Заменить на точную формулировку с указанием порядка, сроков и критериев.',
        review_comment: trigger.hint,
        confidence: 0.65,
      }));
    }
  }

  for (const trigger of SCHEDULE_IMPACT_TRIGGERS) {
    const hits = findInParagraphs(paragraphs, trigger.phrase);
    for (const hit of hits) {
      issues.push(makeIssue({
        sourceDocumentId,
        hit,
        problem_type: 'влияние_на_срок',
        risk_category: 'график',
        criticality: 'high',
        price_impact: 'возможно',
        schedule_impact: 'высокое',
        basis: `Найден маркер «${hit.fragment}». ${trigger.hint}`,
        suggested_action: 'comment',
        suggested_redaction: 'Зафиксировать как график-риск, заложить резерв в КП и согласовать SLA.',
        review_comment: trigger.hint,
        confidence: 0.7,
      }));
    }
  }

  // Дедупликация: один и тот же offset не должен порождать дубли
  const seen = new Set();
  return issues.filter((i) => {
    const key = `${i.paragraph_index}:${i.char_start}:${i.problem_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeIssue(p) {
  return {
    source_document_id: p.sourceDocumentId || null,
    source_clause: p.hit ? `п. ${p.hit.paragraph_index + 1}` : null,
    source_fragment: p.hit ? p.hit.fragment : null,
    paragraph_index: p.hit ? p.hit.paragraph_index : null,
    char_start: p.hit ? p.hit.char_start : null,
    char_end: p.hit ? p.hit.char_end : null,
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

module.exports = { runStage5 };
