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
 * Логика выявления расхождений:
 *   • работа упоминается в ТЗ, но помечена «не учтено» → высокий риск
 *     («может потребоваться выполнить без оплаты»)
 *   • работа упоминается в ВОР, но помечена «не учтено» → высокий риск
 *   • работа помечена «учтено», но не находится ни в ТЗ, ни в ВОР →
 *     средний риск («заложили в КП без подтверждения документами»)
 *   • работа не отмечена («не указано») и упоминается в ТЗ → подсказка
 *     («работа описана в ТЗ — определитесь, учитывать ли её в КП»)
 */
function runStage1(context) {
  const { paragraphs, vorText, checklist, sourceDocumentId } = context;
  const issues = [];
  const tzNorm = normalize(paragraphs.map((p) => p.text).join('\n'));
  const vorNorm = normalize(vorText || '');

  for (const item of checklist) {
    const work = (item.work_name || '').trim();
    if (!work) continue;
    const inTzActual = tzNorm.includes(normalize(work));
    const inVorActual = vorNorm.includes(normalize(work));
    const accounted = item.in_calc;       // 1 / 0 / null

    if (accounted === 1) {
      // учтено в КП
      if (!inTzActual && !inVorActual) {
        issues.push(buildIssue({
          sourceDocumentId,
          paragraph: null,
          fragment: work,
          problem_type: 'учтено_в_кп_без_подтверждения',
          risk_category: 'покрытие_расчёта',
          criticality: 'medium',
          price_impact: 'возможно',
          schedule_impact: 'нет',
          basis: `Работа «${work}» помечена «учтено в КП», но в текстах ТЗ и ВОР не найдена.`,
          suggested_action: 'clarify',
          suggested_redaction: `Запросить у Заказчика подтверждение по позиции «${work}» или скорректировать КП.`,
          review_comment: 'Работа учтена в расчёте, но не подтверждена документально. Возможна избыточная стоимость.',
          confidence: 0.65,
        }));
      }
      continue;
    }

    if (accounted === 0) {
      // не учтено в КП
      if (inTzActual) {
        const hits = findInParagraphs(paragraphs, work);
        const hit = hits[0] || null;
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
      } else if (inVorActual) {
        issues.push(buildIssue({
          sourceDocumentId,
          paragraph: null,
          fragment: work,
          problem_type: 'не_учтено_но_есть_в_ВОР',
          risk_category: 'покрытие_расчёта',
          criticality: 'high',
          price_impact: 'высокое',
          schedule_impact: 'возможно',
          basis: `Работа «${work}» отражена в ВОР, но в чек-листе помечена как НЕ учтённая в КП.`,
          suggested_action: 'clarify',
          suggested_redaction: `Учесть в КП объёмы по позиции «${work}» из ВОР.`,
          review_comment: 'Заказчик ожидает выполнение по ВОР, но в КП объём не заложен.',
          confidence: 0.75,
        }));
      }
      continue;
    }

    // accounted == null: статус не указан
    if (inTzActual) {
      const hits = findInParagraphs(paragraphs, work);
      const hit = hits[0] || null;
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
