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

const { exportReviewedDocx } = require('../../services/reviewDocx');
const { DocxPackage, W_NS } = require('../../services/reviewDocx/docxPackage');
const { extractParagraphs } = require('../../services/reviewDocx/quoteLocator');
const { para, list, multiRunPara, table, buildDocxBuffer } = require('../fixtures/docxCases');

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
    target_text: extra.target_text || null,
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
// commentReference внутри <w:del> ⇒ Word считает примечание удалённым и не показывает.
function commentRefInsideDel(buffer) {
  const xml = new DocxPackage(buffer).getDocumentXml().toString();
  return (xml.match(/<w:del[\s\S]*?<\/w:del>/g) || []).some((d) => d.includes('commentReference'));
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

test('edit + примечание → w:del + w:ins И Word-комментарий на том же фрагменте', () => {
  const fp = tmpDocx([para('Гарантийный срок составляет 12 месяцев с даты подписания.')]);
  const frag = '12 месяцев';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'edit', {
      edited_redaction: '60 месяцев',
      final_comment: 'Привести к СНиП: гарантия не менее 5 лет.',
    }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(report.items[0].visual, 'del+ins');
  assert.ok(delTexts(buffer).some((t) => t.includes('12 месяцев')));
  assert.ok(insTexts(buffer).some((t) => t.includes('60 месяцев')));
  assert.ok(commentTexts(buffer).some((c) => c.includes('гарантия не менее 5 лет')));
  assert.equal(commentRefInsideDel(buffer), false); // примечание видно в Word (не внутри w:del)
});

test('delete + примечание → w:del И Word-комментарий с примечанием', () => {
  const fp = tmpDocx([para('Подрядчик обеспечивает временное электроснабжение площадки.')]);
  const frag = 'временное электроснабжение площадки';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete', {
      final_comment: 'Эта обязанность — на заказчике по договору.',
    }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(delTexts(buffer).length, 1);
  assert.ok(commentTexts(buffer).some((c) => c.includes('на заказчике по договору')));
  assert.equal(commentRefInsideDel(buffer), false); // примечание видно в Word (не внутри w:del)
});

test('delete части фрагмента (target_text) → w:del только по выбранному слову', () => {
  const fp = tmpDocx([para('Подрядчик выполняет все необходимые работы по объекту.')]);
  const frag = 'все необходимые работы';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete', { target_text: 'необходимые' }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  const dels = delTexts(buffer);
  assert.equal(dels.length, 1);
  assert.equal(dels[0], 'необходимые'); // удалено ровно слово, не весь фрагмент
});

test('edit части фрагмента (target_text) → w:del слова + w:ins нового, остальное цело', () => {
  const fp = tmpDocx([para('Гарантийный срок составляет 12 месяцев с даты.')]);
  const frag = 'составляет 12 месяцев';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'edit', {
      target_text: '12 месяцев', edited_redaction: '60 месяцев',
    }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(report.items[0].visual, 'del+ins');
  assert.deepEqual(delTexts(buffer), ['12 месяцев']);   // зачёркнуто только слово
  assert.ok(insTexts(buffer).some((t) => t.includes('60 месяцев')));
});

test('target_text не найден в фрагменте → фолбэк на весь фрагмент', () => {
  const fp = tmpDocx([para('Обычный текст пункта здесь.')]);
  const frag = 'текст пункта';
  const idx = indexOfFragment(fp, frag);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: idx }), 'delete', { target_text: 'отсутствует-такого-нет' }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(delTexts(buffer).length, 1);
  assert.ok(delTexts(buffer)[0].includes('текст пункта')); // удалён весь фрагмент
  assert.match(report.items[0].reason || '', /подчасть не найдена/i);
});

test('фрагмент не найден, есть абзац-якорь → fallback-комментарий (решение не теряется)', () => {
  const fp = tmpDocx([para('Обычный текст без нужной фразы.')]);
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: 'совсем посторонняя непересекающаяся строка', paragraph_index: null }), 'delete'),
  ]);

  assert.equal(report.summary.fallback, 1);
  assert.equal(report.items[0].status, 'fallback');
  assert.match(report.items[0].reason || '', /не найдено|комментарием/i);
  assert.equal(delTexts(buffer).length, 0);     // чужой текст не зачёркнут
  assert.ok(commentTexts(buffer).length >= 1);  // но решение видно комментарием
});

// ── Устойчивое сопоставление .md↔.docx (A/B/C/D) ─────────────────────────────

test('A: терпимость к пробелам — фрагмент с одинарными пробелами ложится в абзац с двойными', () => {
  const fp = tmpDocx([para('Текст  с   двойными    пробелами внутри.')]);
  const frag = 'Текст с двойными пробелами';
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: 0 }), 'delete'),
  ]);

  assert.equal(report.items[0].status, 'applied');
  const dels = delTexts(buffer);
  assert.equal(dels.length, 1);
  assert.ok(dels[0].toLowerCase().includes('двойными'));
});

test('A: терпимость к неразрывным пробелам — nbsp в .docx ↔ обычный пробел во фрагменте', () => {
  const fp = tmpDocx([para('Цена договора твёрдая.')]);
  const frag = 'Цена договора твёрдая';
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: 0 }), 'delete'),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.ok(delTexts(buffer)[0].toLowerCase().includes('договора'));
});

test('B: таблица по ячейкам — source_fragment строки (cells join " | ") метит ячейку-абзац', () => {
  const fp = tmpDocx([table([['Рампы', 'выполнить с антискользящим покрытием']])]);
  const frag = 'Рампы | выполнить с антискользящим покрытием';
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: null }), 'edit', { edited_redaction: 'по проекту' }),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.equal(report.items[0].visual, 'del+ins');
  assert.ok(delTexts(buffer).some((t) => t.includes('антискользящим')));
  assert.ok(insTexts(buffer).some((t) => t.includes('по проекту')));
});

test('C: нечёткий фолбэк (jaccard) — мелкие отличия → весь абзац в w:del, applied с jaccard', () => {
  const fp = tmpDocx([para('Подрядчик обеспечивает вывоз строительного мусора с площадки ежедневно.')]);
  // во фрагменте нет точного вхождения (лишние слова, пропущено «с»), но token-overlap высокий
  const frag = 'Подрядчик обеспечивает вывоз строительного мусора площадки ежедневно за свой счёт';
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: 0 }), 'delete'),
  ]);

  assert.equal(report.items[0].status, 'applied');
  assert.match(report.items[0].reason || '', /jaccard/i);
  assert.ok(delTexts(buffer)[0].includes('строительного мусора'));
});

test('D: edit без места в .docx → fallback-комментарий, w:ins пуст (чужой текст не тронут)', () => {
  const fp = tmpDocx([para('Совершенно другой текст про сроки и оплату.')]);
  const frag = 'Заземление металлоконструкций по контуру здания';
  const { buffer, report } = runExport(fp, [
    decision(issue({ source_fragment: frag, paragraph_index: null }), 'edit', { edited_redaction: 'по проекту КМ' }),
  ]);

  assert.equal(report.summary.fallback, 1);
  assert.equal(report.items[0].status, 'fallback');
  assert.equal(insTexts(buffer).length, 0);     // правка не подменила чужой текст
  assert.equal(delTexts(buffer).length, 0);
  assert.ok(commentTexts(buffer).length >= 1);
});

test('пустой source_fragment → status=skipped', () => {
  const fp = tmpDocx([para('Любой текст.')]);
  const { report } = runExport(fp, [decision(issue({ source_fragment: '', paragraph_index: null }), 'delete')]);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.items[0].status, 'skipped');
});
