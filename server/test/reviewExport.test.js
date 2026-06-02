'use strict';

// Регресс-набор экспорта в Word: проверяем, что решения корректно ложатся в .docx
// на разных структурах (абзац, список, таблица, мультиформат, повтор текста) и что
// структурный отчёт (applied/fallback/failed/skipped) честно отражает результат.
// Запуск: npm test  (node --test test/)

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const xpath = require('xpath');

const { exportReviewedDocx } = require('../services/reviewDocx');
const { DocxPackage, W_NS } = require('../services/reviewDocx/docxPackage');
const { extractParagraphs } = require('../services/reviewDocx/quoteLocator');
const { para, list, multiRunPara, table, buildDocxBuffer } = require('./fixtures/docxCases');

const select = xpath.useNamespaces({ w: W_NS });
const tmpFiles = [];

function tmpDocx(bodyParts) {
  const buf = buildDocxBuffer(bodyParts);
  const p = path.join(os.tmpdir(), `tzopti-${crypto.randomUUID()}.docx`);
  fs.writeFileSync(p, buf);
  tmpFiles.push(p);
  return p;
}
after(() => {
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch (_e) { /* ignore */ }
  }
});

function paragraphsOf(filePath) {
  return extractParagraphs(DocxPackage.fromFile(filePath).getDocumentXml());
}
function indexOfFragment(filePath, needle) {
  const n = needle.toLowerCase();
  return paragraphsOf(filePath).findIndex((p) => (p.text || '').toLowerCase().includes(n));
}

function issue(fields) {
  return { id: fields.id || crypto.randomUUID(), analysis_stage: fields.stage ?? 1, ...fields };
}
function decision(issueObj, kind, extra = {}) {
  return {
    issue: issueObj,
    decision_kind: kind,
    final_comment: extra.final_comment || null,
    edited_redaction: extra.edited_redaction || null,
  };
}
function runExport(fp, decisions) {
  return exportReviewedDocx(fp, decisions, { author: 'Tester', date: new Date('2020-01-01T00:00:00Z') });
}

function delTexts(buffer) {
  const doc = new DocxPackage(buffer).getDocumentXml();
  return select('//w:del', doc).map((d) => select('.//w:delText', d).map((t) => t.textContent).join(''));
}
function insTexts(buffer) {
  const doc = new DocxPackage(buffer).getDocumentXml();
  return select('//w:ins', doc).map((i) => select('.//w:t', i).map((t) => t.textContent).join(''));
}
function commentTexts(buffer) {
  const cdoc = new DocxPackage(buffer).getCommentsXml();
  return select('//w:comment', cdoc).map((c) => c.textContent);
}
function delsInParagraph(buffer, pIdx) {
  const doc = new DocxPackage(buffer).getDocumentXml();
  const paras = select('//w:p', doc);
  return paras[pIdx] ? select('.//w:del', paras[pIdx]).length : 0;
}

test('обычный абзац: delete → w:del с текстом фрагмента, status=applied', () => {
  const fp = tmpDocx([para('Подрядчик выполняет все необходимые работы по объекту.')]);
  const frag = 'все необходимые работы';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete')]);

  assert.equal(report.summary.applied, 1);
  assert.equal(report.items[0].status, 'applied');
  const dels = delTexts(buffer);
  assert.equal(dels.length, 1);
  assert.ok(dels[0].toLowerCase().includes(frag));
});

test('список: delete элемента списка → w:del в нужном абзаце', () => {
  const fp = tmpDocx([
    para('Состав работ:'),
    list(['Монтаж опалубки', 'Устройство гидроизоляции по всему контуру', 'Армирование каркаса']),
  ]);
  const frag = 'Устройство гидроизоляции по всему контуру';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete')]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(delTexts(buffer).length, 1);
  assert.ok(delTexts(buffer)[0].toLowerCase().includes('гидроизоляции'));
});

test('таблица: edit ячейки → w:del старого + w:ins нового', () => {
  const fp = tmpDocx([para('Характеристики материалов:'), table([['Бетон', 'B25'], ['Арматура', 'A400']])]);
  const frag = 'B25';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'edit', { edited_redaction: 'B30' }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(report.items[0].visual, 'del+ins');
  assert.ok(delTexts(buffer).some((t) => t.includes('B25')));
  assert.ok(insTexts(buffer).some((t) => t.includes('B30')));
});

test('мультиформатный абзац: delete фрагмента через жирный run', () => {
  const fp = tmpDocx([
    multiRunPara([
      { text: 'Поставка ' },
      { text: 'бетона', bold: true },
      { text: ' осуществляется генподрядчиком.' },
    ]),
  ]);
  const frag = 'бетона осуществляется';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete')]);

  assert.equal(report.items[0].status, 'applied');
  const dels = delTexts(buffer);
  assert.equal(dels.length, 1);
  assert.ok(dels[0].toLowerCase().includes(frag));
});

test('повторяющийся текст: без paragraph_index → первое вхождение; с index → нужное', () => {
  const repeated = 'Работы выполняются в полном объёме';
  const fp = tmpDocx([para(`${repeated} по разделу 1.`), para(`${repeated} по разделу 2.`)]);

  // (a) без paragraph_index — помечается первое вхождение (известное ограничение).
  {
    const { buffer, report } = runExport(fp, [
      decision(issue({ source_fragment: repeated, paragraph_index: null }), 'delete'),
    ]);
    assert.equal(report.items[0].status, 'applied');
    assert.ok(delsInParagraph(buffer, 0) > 0, 'первый абзац помечен');
    assert.equal(delsInParagraph(buffer, 1), 0, 'второй абзац не тронут');
  }

  // (b) с paragraph_index=1 — paragraph_index разводит одинаковые вхождения.
  {
    const { buffer, report } = runExport(fp, [
      decision(issue({ source_fragment: repeated, paragraph_index: 1 }), 'delete'),
    ]);
    assert.equal(report.items[0].status, 'applied');
    assert.equal(delsInParagraph(buffer, 0), 0, 'первый абзац не тронут');
    assert.ok(delsInParagraph(buffer, 1) > 0, 'помечен второй абзац');
  }
});

test('remove_from_scope → w:del + комментарий-тег «Вынесено из объёма»', () => {
  const fp = tmpDocx([para('Подрядчик обеспечивает круглосуточную охрану объекта за свой счёт.')]);
  const frag = 'круглосуточную охрану объекта';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [decision(issue({ source_fragment: frag, paragraph_index: idx }), 'remove_from_scope')]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(delTexts(buffer).length, 1);
  assert.ok(commentTexts(buffer).some((c) => c.includes('Вынесено из объёма')));
});

test('accept с текстом → Word-комментарий, без track change', () => {
  const fp = tmpDocx([para('Срок выполнения работ — 12 месяцев.')]);
  const frag = '12 месяцев';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'accept', { final_comment: 'Уточнить дату начала.' }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(report.items[0].visual, 'comment');
  assert.ok(commentTexts(buffer).some((c) => c.includes('Уточнить дату начала')));
  assert.equal(delTexts(buffer).length, 0);
});

test('фрагмент не найден → status=failed с причиной', () => {
  const fp = tmpDocx([para('Обычный текст без нужной фразы.')]);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: 'этой фразы тут точно нет', paragraph_index: null }), 'delete'),
  ]);

  assert.equal(report.summary.failed, 1);
  assert.equal(report.items[0].status, 'failed');
  assert.match(report.items[0].reason, /не найден/i);
  assert.equal(delTexts(buffer).length, 0);
});

test('пустой source_fragment → status=skipped', () => {
  const fp = tmpDocx([para('Любой текст.')]);
  const { report } = runExport(fp, [decision(issue({ source_fragment: '', paragraph_index: null }), 'delete')]);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.items[0].status, 'skipped');
});
