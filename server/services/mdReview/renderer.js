'use strict';

const db = require('../../db/connection');

/**
 * Рендер review.md — берёт оригинальный текст ТЗ (предпочтительно загруженную
 * .md-копию, иначе extracted_text из .docx) и применяет разметку правок:
 *   delete / remove_from_scope → ~~зачёркнуто~~
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
             d.decision, d.edited_redaction, d.final_comment
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
           d.decision, d.edited_redaction, d.final_comment
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

    let replacement;
    if (d.decision === 'delete' || d.decision === 'remove_from_scope') {
      replacement = `~~${fragment}~~`;
    } else if (d.decision === 'edit') {
      const newText = (d.edited_redaction || '').trim();
      replacement = newText
        ? `~~${fragment}~~ **{${newText}}**`
        : `~~${fragment}~~`;
    } else if (d.decision === 'accept') {
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
