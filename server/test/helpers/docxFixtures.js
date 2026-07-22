'use strict';

// DOCX-фикстуры для тестов экспорта: строители body-частей (переэкспорт из
// test/fixtures/docxCases.js) + запись готового .docx во временный файл с
// автоуборкой. Единая точка входа, чтобы тесты не собирали zip руками.

const cases = require('../fixtures/docxCases');
const { makeTmpDir, writeTmpFile } = require('./tmpDir');

// Собирает .docx из частей body и кладёт во временный каталог.
// t — контекст node:test (опц.): к нему привязывается уборка.
function writeTmpDocx(bodyParts, { t, name = 'fixture.docx' } = {}) {
  const dir = makeTmpDir(t);
  return writeTmpFile(dir, name, cases.buildDocxBuffer(bodyParts));
}

// Готовый одноабзацный документ — самый частый случай в smoke-проверках.
function simpleDocx(text, opts = {}) {
  return writeTmpDocx([cases.para(text)], opts);
}

// Решение в форме, которую ждёт exportReviewedDocx (issue + вид решения).
function decision({ id = 'i1', fragment, kind = 'accept', comment = null, redaction = null, target = null, extra = {} }) {
  return {
    issue: {
      id,
      analysis_stage: 1,
      source_fragment: fragment,
      suggested_redaction: redaction,
      problem_type: null,
      criticality: 'medium',
      ...extra,
    },
    decision_kind: kind,
    final_comment: comment,
    edited_redaction: redaction,
    target_text: target,
  };
}

module.exports = { ...cases, writeTmpDocx, simpleDocx, decision };
