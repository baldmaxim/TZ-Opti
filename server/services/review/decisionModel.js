'use strict';

// Единый источник логики «решение → вид» для всех поверхностей review:
//   docx-экспорт   (reviewDocx/index.js)
//   HTML-preview   (reviewHtmlService.js)
//   md-рендер      (mdReview/renderer.js)
// Меняем правило здесь — меняется одинаково везде (preview ↔ таблица ↔ docx).

const DECISION_KINDS = ['accept', 'reject', 'edit', 'delete', 'remove_from_scope'];

// docx — какие операции класть в Word:
//   'comment' — Word-комментарий (если есть текст);
//   'del'     — w:del (удаление в режиме рецензирования);
//   'del+ins' — w:del старого + w:ins нового;
//   'none'    — ничего (reject не экспортируется).
// mark — способ показа в preview/md: 'note' | 'replace' | 'strike' | 'rejected'.
// tag  — доп. комментарий-метка (различает «вынесено из объёма» от простого удаления).
const VISUALS = {
  accept: { docx: 'comment', mark: 'note', label: 'Примечание' },
  edit: { docx: 'del+ins', mark: 'replace', label: 'Изменить' },
  delete: { docx: 'del', mark: 'strike', label: 'Удалить' },
  remove_from_scope: { docx: 'del', mark: 'strike', label: 'Вынести из объёма', tag: 'Вынесено из объёма' },
  reject: { docx: 'none', mark: 'rejected', label: 'Отклонить' },
};

function decisionVisual(kind) {
  return VISUALS[kind] || VISUALS.accept;
}

// Единая цепочка разрешения текста замены (для edit). Совпадает в docx/preview/md.
// Принимает строку issue (может нести alias decision_redaction) и объект решения.
function resolveRedaction(issue = {}, decision = {}) {
  return (
    (decision.edited_redaction || '').trim() ||
    (issue.decision_redaction || '').trim() ||
    (issue.edited_redaction || '').trim() ||
    (issue.suggested_redaction || '').trim() ||
    ''
  );
}

module.exports = { DECISION_KINDS, decisionVisual, resolveRedaction };
