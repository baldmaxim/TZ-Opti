'use strict';

const db = require('../../db/connection');
const { decisionVisual, resolveRedaction, resolveActionTarget } = require('../review/decisionModel');

// Помечает только выбранную подчасть внутри фрагмента (delete/edit на части):
// возвращает текст фрагмента, где `part` обёрнут wrapFn, остальное не тронуто.
// null — если подчасти нет в фрагменте (фолбэк на весь фрагмент у вызывающего).
function markPartInFragment(fragment, part, wrapFn) {
  const i = fragment.indexOf(part);
  if (i === -1) return null;
  return fragment.slice(0, i) + wrapFn(part) + fragment.slice(i + part.length);
}

/**
 * Рендер review.md — берёт оригинальный текст ТЗ (предпочтительно загруженную
 * .md-копию, иначе extracted_text из .docx) и применяет разметку правок
 * (единый «вид решения» — decisionModel, как в docx/preview):
 *   delete → ~~зачёркнуто~~
 *   remove_from_scope → ~~зачёркнуто~~ _(вынесено из объёма)_
 *   edit → ~~старое~~ **{новое}**
 *   accept (Примечание) → текст[^N] + сноска внизу
 *   reject → не меняется
 *
 * Поиск фрагмента — по точному совпадению source_fragment в тексте
 * (текстовый поиск, не по offset'ам, т.к. .md может отличаться от .docx).
 * Длинные фрагменты применяются первыми, чтобы не накладывались на короткие.
 */

async function getTzMdDocument(tenderId) {
  return db.queryOne(
    `SELECT * FROM documents
     WHERE tender_id = ? AND doc_type = 'tz' AND LOWER(name) LIKE '%.md'
     ORDER BY uploaded_at DESC LIMIT 1`,
    tenderId,
  );
}

async function getTzDocxDocument(tenderId) {
  return db.queryOne(
    `SELECT * FROM documents
     WHERE tender_id = ? AND doc_type = 'tz' AND LOWER(name) NOT LIKE '%.md'
     ORDER BY uploaded_at DESC LIMIT 1`,
    tenderId,
  );
}

async function loadDecisions(tenderId, stageFilter = null) {
  if (stageFilter) {
    return db.queryAll(
      `
      SELECT i.id AS issue_id, i.source_fragment, i.source_clause, i.analysis_stage,
             d.decision, d.edited_redaction, d.final_comment, d.target_text
      FROM issues i
      INNER JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.analysis_stage = ?
      ORDER BY i.paragraph_index ASC NULLS LAST, i.char_start ASC NULLS LAST
      `,
      tenderId,
      stageFilter,
    );
  }
  return db.queryAll(
    `
    SELECT i.id AS issue_id, i.source_fragment, i.source_clause, i.analysis_stage,
           d.decision, d.edited_redaction, d.final_comment, d.target_text
    FROM issues i
    INNER JOIN review_decisions d ON d.issue_id = i.id
    WHERE i.tender_id = ?
    ORDER BY i.analysis_stage ASC, i.paragraph_index ASC NULLS LAST, i.char_start ASC NULLS LAST
    `,
    tenderId,
  );
}

async function renderReviewMd(tenderId, { stage = null } = {}) {
  // 1. Источник: .md если есть, иначе extracted_text от .docx.
  let sourceText = null;
  let sourceLabel = null;
  let sourceFile = null;

  const mdDoc = await getTzMdDocument(tenderId);
  if (mdDoc && mdDoc.extracted_text) {
    sourceText = mdDoc.extracted_text;
    sourceLabel = 'Markdown-копия ТЗ';
    sourceFile = mdDoc.name;
  } else {
    const docxDoc = await getTzDocxDocument(tenderId);
    if (docxDoc && docxDoc.extracted_text) {
      sourceText = docxDoc.extracted_text;
      sourceLabel = 'извлечённый текст из ТЗ';
      sourceFile = docxDoc.name;
    }
  }

  if (!sourceText) {
    return '# Review\n\n⚠ В тендер не загружен ТЗ (.md или .docx).\n';
  }

  // 2. Решения (только те, по которым есть запись в review_decisions).
  const decisions = await loadDecisions(tenderId, stage);

  // 3. Применяем длинные фрагменты первыми — они не должны попадать в подстроки коротких.
  const sorted = [...decisions].sort(
    (a, b) => (b.source_fragment?.length || 0) - (a.source_fragment?.length || 0),
  );

  const footnotes = [];
  let result = sourceText;
  let appliedCount = 0;
  const skipped = [];

  for (const d of sorted) {
    if (!d.source_fragment) continue;
    if (d.decision === 'reject') continue;

    const fragment = d.source_fragment;
    const idx = result.indexOf(fragment);
    if (idx === -1) {
      skipped.push({ decision: d.decision, fragment });
      continue;
    }

    const v = decisionVisual(d.decision);
    // Подчасть фрагмента (delete/edit на выделенную часть). hasPart → метим только её.
    const part = (resolveActionTarget({ source_fragment: fragment }, d) || '').trim();
    const hasPart = part && part !== fragment.trim() && fragment.includes(part);
    let replacement;
    if (v.mark === 'strike') {
      // delete / remove_from_scope — зачёркивание; вынос помечаем тегом.
      const suffix = v.tag ? ` _(${v.tag.toLowerCase()})_` : '';
      const marked = hasPart ? markPartInFragment(fragment, part, (p) => `~~${p}~~`) : null;
      replacement = (marked || `~~${fragment}~~`) + suffix;
    } else if (v.mark === 'replace') {
      const newText = resolveRedaction({}, d);
      const wrap = (p) => (newText ? `~~${p}~~ **{${newText}}**` : `~~${p}~~`);
      const marked = hasPart ? markPartInFragment(fragment, part, wrap) : null;
      replacement = marked || wrap(fragment);
    } else if (v.mark === 'note') {
      const note = (d.final_comment || '').trim();
      if (!note) {
        // accept без комментария — пометки не нужно, просто пропускаем.
        continue;
      }
      const n = footnotes.length + 1;
      footnotes.push(`[^${n}]: ${note}`);
      replacement = `${fragment}[^${n}]`;
    } else {
      continue;
    }

    result = result.slice(0, idx) + replacement + result.slice(idx + fragment.length);
    appliedCount++;
  }

  // 4. Сборка финального .md с шапкой-метаданными и сносками.
  const headerLines = [
    `<!-- TZ-Opti review.md -->`,
    `<!-- Источник: ${sourceLabel}${sourceFile ? ` (${sourceFile})` : ''} -->`,
    stage
      ? `<!-- Стадия: ${stage} (только решения этой стадии) -->`
      : `<!-- Стадии: все -->`,
    `<!-- Сгенерировано: ${new Date().toISOString()} -->`,
    `<!-- Применено решений: ${appliedCount} из ${decisions.length} -->`,
  ];
  if (skipped.length) {
    headerLines.push(`<!-- Пропущено (фрагмент не найден в исходном тексте): ${skipped.length} -->`);
  }

  let output = headerLines.join('\n') + '\n\n' + result;
  if (footnotes.length) {
    output += '\n\n---\n\n' + footnotes.join('\n\n') + '\n';
  }

  return output;
}

module.exports = { renderReviewMd };
