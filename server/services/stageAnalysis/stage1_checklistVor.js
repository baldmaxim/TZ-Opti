'use strict';

const { findInParagraphs, normalize } = require('./shared/fragmentMatcher');

/**
 * Стадия 1: ТЗ + Чек-лист + ВОР.
 * Контракт: (context) → Issue[]
 * context = { tenderId, paragraphs, vorText, checklist, sourceDocumentId }
 */
function runStage1(context) {
  const { paragraphs, vorText, checklist, sourceDocumentId } = context;
  const issues = [];
  const tzText = paragraphs.map((p) => p.text).join('\n');
  const tzNorm = normalize(tzText);
  const vorNorm = normalize(vorText || '');

  for (const item of checklist) {
    const work = (item.work_name || '').trim();
    if (!work) continue;
    const inTzActual = tzNorm.includes(normalize(work));
    const inVorActual = vorNorm.includes(normalize(work));

    // Работа есть в ТЗ, но не учтена в расчёте
    if (inTzActual && !item.in_calc) {
      const hits = findInParagraphs(paragraphs, work);
      const hit = hits[0];
      issues.push(buildIssue({
        sourceDocumentId,
        paragraph: hit,
        fragment: hit ? hit.fragment : work,
        problem_type: 'не_учтено_в_расчёте',
        risk_category: 'покрытие_расчёта',
        criticality: 'high',
        price_impact: 'высокое',
        schedule_impact: 'нет',
        basis: `Работа «${work}» упоминается в ТЗ (раздел «${item.section || '—'}»), но в чек-листе не отмечена как учтённая в расчёте.`,
        suggested_action: 'clarify',
        suggested_redaction: `Учесть в расчёте: ${work}`,
        review_comment: 'Работа описана в ТЗ, но отсутствует в составе расчёта. Требуется добавить в КП или вынести в допущения.',
        confidence: 0.75,
      }));
    }

    // Работа в ВОР, но не подтверждена в ТЗ
    if (inVorActual && !inTzActual) {
      issues.push(buildIssue({
        sourceDocumentId,
        paragraph: null,
        fragment: work,
        problem_type: 'есть_в_ВОР_нет_в_ТЗ',
        risk_category: 'расхождение',
        criticality: 'medium',
        price_impact: 'среднее',
        schedule_impact: 'нет',
        basis: `Работа «${work}» отражена в ВОР, но не найдена в тексте ТЗ.`,
        suggested_action: 'clarify',
        suggested_redaction: `Внести в раздел ТЗ: ${work}`,
        review_comment: 'ВОР содержит работу, не подтверждённую формулировкой в ТЗ. Требуется уточнить состав ТЗ.',
        confidence: 0.7,
      }));
    }

    // Работа в ТЗ, но в ВОР отсутствует
    if (inTzActual && vorText && !inVorActual) {
      const hits = findInParagraphs(paragraphs, work);
      const hit = hits[0];
      issues.push(buildIssue({
        sourceDocumentId,
        paragraph: hit,
        fragment: hit ? hit.fragment : work,
        problem_type: 'есть_в_ТЗ_нет_в_ВОР',
        risk_category: 'расхождение',
        criticality: 'high',
        price_impact: 'высокое',
        schedule_impact: 'возможно',
        basis: `Работа «${work}» описана в ТЗ, но в ВОР объём не выделен.`,
        suggested_action: 'clarify',
        suggested_redaction: `Запросить у Заказчика дополнение ВОР по позиции «${work}»`,
        review_comment: 'Несоответствие ТЗ и ВОР: объём работ требует уточнения, иначе риск выполнения без оплаты.',
        confidence: 0.7,
      }));
    }
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
