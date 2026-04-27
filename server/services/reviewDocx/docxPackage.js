'use strict';

const fs = require('fs');
const PizZip = require('pizzip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

class DocxPackage {
  constructor(buffer) {
    this.zip = new PizZip(buffer);
    this._docXml = null;
    this._docDoc = null;
    this._commentsDoc = null;
    this._relsDoc = null;
    this._ctDoc = null;
    this._dirty = new Set();
  }

  static fromFile(filePath) {
    const buf = fs.readFileSync(filePath);
    return new DocxPackage(buf);
  }

  hasFile(name) {
    return !!this.zip.file(name);
  }

  readXml(name) {
    const file = this.zip.file(name);
    if (!file) return null;
    const xml = file.asText();
    return new DOMParser({ errorHandler: () => {} }).parseFromString(xml, 'text/xml');
  }

  writeXml(name, doc) {
    const xml = new XMLSerializer().serializeToString(doc);
    const safe = xml.startsWith('<?xml') ? xml : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
    this.zip.file(name, safe);
    this._dirty.add(name);
  }

  getDocumentXml() {
    if (!this._docDoc) this._docDoc = this.readXml('word/document.xml');
    return this._docDoc;
  }
  saveDocumentXml() {
    if (this._docDoc) this.writeXml('word/document.xml', this._docDoc);
  }

  getCommentsXml() {
    if (this._commentsDoc) return this._commentsDoc;
    if (this.hasFile('word/comments.xml')) {
      this._commentsDoc = this.readXml('word/comments.xml');
    } else {
      this._commentsDoc = new DOMParser().parseFromString(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<w:comments xmlns:w="${W_NS}"></w:comments>`,
        'text/xml'
      );
    }
    return this._commentsDoc;
  }
  saveCommentsXml() {
    if (this._commentsDoc) this.writeXml('word/comments.xml', this._commentsDoc);
  }

  getRelsXml() {
    if (!this._relsDoc) this._relsDoc = this.readXml('word/_rels/document.xml.rels');
    return this._relsDoc;
  }
  saveRelsXml() {
    if (this._relsDoc) this.writeXml('word/_rels/document.xml.rels', this._relsDoc);
  }

  getContentTypesXml() {
    if (!this._ctDoc) this._ctDoc = this.readXml('[Content_Types].xml');
    return this._ctDoc;
  }
  saveContentTypesXml() {
    if (this._ctDoc) this.writeXml('[Content_Types].xml', this._ctDoc);
  }

  toBuffer() {
    return this.zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

module.exports = {
  DocxPackage,
  W_NS,
  REL_NS,
  CT_NS,
};
