'use strict';

// Построитель .docx-фикстур для регресс-набора экспорта: обычный абзац, список,
// таблица, мультиформатный абзац, повторяющийся текст. Делает минимальный, но
// валидный пакет (его открывает DocxPackage и обходит quoteLocator по `.//w:p`).

const PizZip = require('pizzip');

function escapeXml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Обычный абзац (опц. как элемент списка — через numId).
function para(text, { numId } = {}) {
  const pPr = numId
    ? `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

// Список — несколько абзацев с numPr (одного уровня).
function list(items) {
  return items.map((t) => para(t, { numId: 1 })).join('');
}

// Мультиформатный абзац: parts = [{ text, bold }] → несколько w:r, фраза дробится
// по run'ам (часть может быть жирной).
function multiRunPara(parts) {
  const runs = parts
    .map((p) => {
      const rPr = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r>`;
    })
    .join('');
  return `<w:p>${runs}</w:p>`;
}

// Таблица: rows = [[cellText, ...], ...]. Каждая ячейка содержит один абзац.
function table(rows) {
  const trs = rows
    .map((cells) => {
      const tcs = cells
        .map((c) => `<w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>${para(c)}</w:tc>`)
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${trs}</w:tbl>`;
}

// Собирает .docx-буфер из готового body-XML (массив фрагментов w:p/w:tbl).
function buildDocxBuffer(bodyParts) {
  const body = (Array.isArray(bodyParts) ? bodyParts : [bodyParts]).join('\n');
  const zip = new PizZip();

  zip.file('[Content_Types].xml',
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels',
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels',
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

  zip.file('word/document.xml',
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${body}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1700" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { para, list, multiRunPara, table, buildDocxBuffer, escapeXml };
