'use strict';

const db = require('../../db/connection');
const { normalize, findInParagraphs } = require('./shared/fragmentMatcher');
const {
  defaultsFor,
  renderConditions,
  tenderTypeToContractKind,
} = require('../conditionsRenderer');

/**
 * Стадия 3: ТЗ vs существенные условия компании.
 * context = { tenderId, paragraphs, sourceDocumentId }
 *
 * Проверяет, отражены ли в тексте ТЗ ключевые формулировки из таблицы
 * company_conditions (с учётом per-tender override и параметров тендера).
 *
 * Логика (rule-based MVP):
 *   • для каждого условия из шаблона берём `name` (например «Гарантийный срок»);
 *   • выделяем «опорные» слова длиной ≥4 символа;
 *   • если ни одно опорное слово не встречается в тексте ТЗ → flag «не отражено в ТЗ»;
 *   • если встречается → не флагуем (считаем что условие учтено, юзер сверит вручную).
 *
 * Когда подключим LLM на этой стадии (Этап B) — заменим эту простую логику
 * на семантическое сравнение полного текста условия с фрагментами ТЗ.
 */
async function runStage3(context) {
  const { tenderId, paragraphs, sourceDocumentId } = context;

  const tender = await db.queryOne('SELECT * FROM tenders WHERE id = ?', tenderId);
  if (!tender) return [];

  // 1. Определяем тип контракта (gen/shell) и параметры для рендера.
  const kind = tenderTypeToContractKind(tender.contract_type) || 'gen';
  const paramsRow = await db.queryOne(
    'SELECT * FROM tender_setup_params WHERE tender_id = ?',
    tenderId,
  );
  const params = { ...defaultsFor(kind), ...(paramsRow || {}) };

  // 2. Рендерим стандартные условия с подставленными параметрами.
  const rendered = renderConditions(kind, params); // [{ idx, name, text, ... }]

  // 3. Подгружаем per-tender override-ы.
  const overrides = await db.queryAll(
    `SELECT condition_idx, condition, text_override, comment, criticality
     FROM company_conditions WHERE tender_id = ?`,
    tenderId,
  );
  const overrideByIdx = new Map();
  for (const o of overrides) overrideByIdx.set(o.condition_idx, o);

  if (!rendered.length) return [];

  const issues = [];

  for (const cond of rendered) {
    const ov = overrideByIdx.get(cond.idx);
    const effectiveText = (ov?.text_override || cond.text || '').trim();
    const condName = (cond.name || '').trim();
    if (!condName && !effectiveText) continue;

    // Из имени условия выделяем опорные слова (≥4 символов, без знаков).
    const keywords = extractAnchorWords(condName);
    if (!keywords.length) continue;

    // Ищем хоть одно вхождение любого опорного слова в ТЗ.
    let firstHit = null;
    for (const kw of keywords) {
      const hits = findInParagraphs(paragraphs, kw);
      if (hits.length) { firstHit = hits[0]; break; }
    }

    if (!firstHit) {
      // Условие не отражено в ТЗ.
      issues.push({
        source_document_id: sourceDocumentId || null,
        source_clause: null,
        source_fragment: condName, // для review.md/.docx будет искаться по этому тексту
        paragraph_index: null,
        char_start: null,
        char_end: null,
        problem_type: 'условие_не_отражено',
        risk_category: 'существенные_условия',
        criticality: ov?.criticality || 'medium',
        price_impact: 'возможно',
        schedule_impact: 'возможно',
        basis: `Существенное условие компании «${condName}» не упоминается в тексте ТЗ. Стандарт компании: ${truncate(effectiveText, 200)}`,
        suggested_action: 'clarify',
        suggested_redaction: effectiveText,
        review_comment: ov?.comment || 'Сверьте ТЗ со стандартным условием компании. При отсутствии — добавить пункт в КП или вынести в допущения.',
        confidence: 0.55,
      });
    }
    // Если упоминание есть — не флагуем (MVP). LLM-агент будет различать «упомянуто корректно» vs «упомянуто но противоречит».
  }

  return issues;
}

// Опорные слова: ≥4 букв, без коротких служебных. Из «Гарантийный срок» → ['гарантийный', 'срок'].
// Слова <4 символов могут давать ложные совпадения.
const STOP_WORDS = new Set([
  'для', 'или', 'при', 'без', 'над', 'под', 'про', 'через', 'между',
]);

function extractAnchorWords(s) {
  const norm = normalize(s).replace(/[^a-zа-я0-9 ]/gi, ' ');
  return norm.split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { runStage3 };
