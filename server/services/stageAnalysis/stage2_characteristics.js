'use strict';

const { findInParagraphs, normalize } = require('./shared/fragmentMatcher');

/**
 * Стадия 2: ТЗ vs Q&A форма (Таблица характеристик).
 * context = { tenderId, paragraphs, characteristics, sourceDocumentId }
 */
function runStage2(context) {
  const { paragraphs, characteristics, sourceDocumentId } = context;
  const issues = [];
  if (!characteristics || !characteristics.length) return issues;
  const tzNorm = normalize(paragraphs.map((p) => p.text).join('\n'));

  for (const ch of characteristics) {
    const name = (ch.name || '').trim();
    if (!name) continue;
    const value = (ch.value || '').trim();
    const mentioned = tzNorm.includes(normalize(name));

    if (!mentioned) {
      issues.push(buildIssue({
        sourceDocumentId,
        paragraph: null,
        fragment: name,
        problem_type: 'характеристика_не_отражена_в_ТЗ',
        risk_category: 'характеристики',
        criticality: 'medium',
        price_impact: 'возможно',
        schedule_impact: 'нет',
        basis: `Характеристика «${name}» = «${value}» (источник: ${ch.source || 'Q&A'}) не отражена в тексте ТЗ.`,
        suggested_action: 'comment',
        suggested_redaction: `Добавить в ТЗ уточняющий пункт: «${name}: ${value}»`,
        review_comment: 'Принятое решение по характеристике должно быть зафиксировано в ТЗ или вынесено в допущения КП.',
        confidence: 0.6,
      }));
      continue;
    }

    // Поиск контр-формулировок (например, value=«давальческий» — ищем «поставка генподрядчиком»)
    const counterMarkers = buildCounterMarkers(name, value);
    for (const marker of counterMarkers) {
      const hits = findInParagraphs(paragraphs, marker.phrase);
      for (const hit of hits) {
        issues.push(buildIssue({
          sourceDocumentId,
          paragraph: hit,
          fragment: hit.fragment,
          problem_type: 'противоречие_характеристике',
          risk_category: 'характеристики',
          criticality: 'high',
          price_impact: 'высокое',
          schedule_impact: 'возможно',
          basis: `В ТЗ найдена формулировка «${hit.fragment}», противоречащая принятой характеристике «${name}: ${value}».`,
          suggested_action: 'replace',
          suggested_redaction: marker.suggestion,
          review_comment: `Уточнить пункт ТЗ в соответствии с принятым решением: «${name}: ${value}».`,
          confidence: 0.7,
        }));
      }
    }
  }

  return issues;
}

function buildCounterMarkers(name, value) {
  const n = (name || '').toLowerCase();
  const v = (value || '').toLowerCase();
  const out = [];
  if (n.includes('бетон') && v.includes('давальч')) {
    out.push({ phrase: 'поставка бетона генподрядчиком', suggestion: 'поставка бетона осуществляется Заказчиком на давальческой основе' });
    out.push({ phrase: 'бетон поставляет генподрядчик', suggestion: 'бетон поставляется Заказчиком на давальческой основе' });
  }
  if (n.includes('арматур') && v.includes('давальч')) {
    out.push({ phrase: 'поставка арматуры генподрядчиком', suggestion: 'арматура поставляется Заказчиком на давальческой основе' });
  }
  if (n.includes('кран') && v.includes('заказчик')) {
    out.push({ phrase: 'башенный кран генподрядчика', suggestion: 'башенный кран предоставляется Заказчиком' });
  }
  if (n.includes('вывоз') && v.includes('заказчик')) {
    out.push({ phrase: 'вывоз грунта силами генподрядчика', suggestion: 'вывоз грунта осуществляется силами Заказчика' });
  }
  return out;
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

module.exports = { runStage2 };
