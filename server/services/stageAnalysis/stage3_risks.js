'use strict';

const { findInParagraphs } = require('./shared/fragmentMatcher');
const { listForTender } = require('../risksService');

/**
 * Стадия 3: ТЗ vs типовые риски.
 * context = { tenderId, paragraphs, sourceDocumentId }
 *
 * Использует стандартную библиотеку рисков (server/db/standardRisks.js)
 * + per-tender оверлей tender_risk_state (Да/Нет/auto).
 * Применяет только риски с effective === true.
 */
async function runStage3(context) {
  const { tenderId, paragraphs, sourceDocumentId } = context;
  const allRisks = await listForTender(tenderId);
  const risks = allRisks.filter((r) => r.effective);
  if (!risks.length) return [];

  const issues = [];
  for (const risk of risks) {
    const seen = new Set();
    for (const trigger of risk.triggers || []) {
      if (!trigger) continue;
      const hits = findInParagraphs(paragraphs, trigger);
      for (const hit of hits) {
        const key = `${hit.paragraph_index}:${hit.char_start}:${risk.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          source_document_id: sourceDocumentId || null,
          source_clause: `п. ${hit.paragraph_index + 1}`,
          source_fragment: hit.full_paragraph,
          paragraph_index: hit.paragraph_index,
          char_start: hit.char_start,
          char_end: hit.char_end,
          problem_type: 'типовой_риск',
          risk_category: risk.category || 'общие_риски',
          criticality: risk.criticality || 'medium',
          price_impact: 'возможно',
          schedule_impact: 'возможно',
          basis: `Совпадение с типовым риском «${risk.risk_text}» (триггер: «${hit.fragment}»).`,
          suggested_action: 'comment',
          suggested_redaction: risk.recommendation || 'Зафиксировать как риск, оценить влияние.',
          review_comment: risk.recommendation || 'Типовой риск, требует фиксации.',
          confidence: 0.7,
        });
      }
    }
  }

  return issues;
}

module.exports = { runStage3 };
