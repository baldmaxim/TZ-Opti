'use strict';

const { findInParagraphs, normalize } = require('./shared/fragmentMatcher');

/**
 * Стадия 3: ТЗ vs типовые риски.
 * context = { tenderId, paragraphs, riskTemplates, sourceDocumentId }
 */
function runStage3(context) {
  const { paragraphs, riskTemplates, sourceDocumentId } = context;
  const issues = [];
  if (!riskTemplates || !riskTemplates.length) return issues;

  for (const risk of riskTemplates) {
    const text = (risk.risk_text || '').trim();
    if (!text) continue;
    // Ищем самые длинные содержательные слова из формулировки
    const keywords = extractKeywords(text);
    const seen = new Set();
    for (const kw of keywords) {
      const hits = findInParagraphs(paragraphs, kw);
      for (const hit of hits) {
        const dedupKey = `${hit.paragraph_index}:${hit.char_start}:${risk.id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
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
          basis: `В пункте ТЗ найдена формулировка, соответствующая типовому риску: «${text}».`,
          suggested_action: 'comment',
          suggested_redaction: risk.recommendation || 'Зафиксировать как риск в реестре, оценить влияние и заложить резерв.',
          review_comment: risk.recommendation || 'Типовой риск, требует фиксации.',
          confidence: 0.6,
        });
      }
    }
  }

  return issues;
}

function extractKeywords(text) {
  const tokens = normalize(text)
    .replace(/[^a-zа-я0-9 ]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 5);
  // Берём не более 3 самых длинных уникальных слов как «опорные»
  const uniq = Array.from(new Set(tokens));
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, 3);
}

module.exports = { runStage3 };
