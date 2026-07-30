'use strict';

// Манифест тендерного пакета — DB-слой поверх чистого ядра manifestModel.js.
// Чтение — buildManifest по всем документам тендера; запись — PATCH манифест-
// полей одного документа с валидацией ссылки замены и авто-разметкой
// заменённого документа (actuality_status='superseded').

const db = require('../../db/connection');
const { badRequest, notFound } = require('../../utils/errors');
const audit = require('../audit/auditService');
const {
  buildManifest,
  annotateDocuments,
  normalizeManifestPatch,
  validateSupersedes,
} = require('./manifestModel');

// Колонки документа для манифеста и выбора входа анализа (без extracted_text —
// текст в манифесте не нужен и тяжёл).
const DOC_COLUMNS = `id, tender_id, doc_type, name, mime_type, version, uploaded_at, comment,
  processing_status, revision_label, actuality_status, doc_date, conflict_priority,
  applicability, supersedes_document_id`;

async function listTenderDocuments(tenderId, tx) {
  const e = tx || db;
  return e.queryAll(
    `SELECT ${DOC_COLUMNS} FROM documents WHERE tender_id = ? ORDER BY uploaded_at DESC`,
    tenderId,
  );
}

async function getManifest(tenderId) {
  const docs = await listTenderDocuments(tenderId);
  return buildManifest(docs);
}

// PATCH манифест-полей документа. Правила:
//  - неизвестное поле / кривое значение → 400 (ничего не пишется);
//  - supersedes_document_id — только документ ЭТОГО тендера, без самозамены и
//    циклов;
//  - установка ссылки замены МАТЕРИАЛИЗУЕТ статус цели: заменённый документ
//    получает actuality_status='superseded' явно (эффективный статус и так был
//    бы superseded по обратной ссылке, но явная запись видна в БД и истории).
async function updateDocumentManifest(documentId, patch, { actor = null, requestId = null } = {}) {
  const doc = await db.queryOne('SELECT * FROM documents WHERE id = ?', documentId);
  if (!doc) throw notFound('Документ не найден');

  const { value, errors } = normalizeManifestPatch(patch);
  if (errors.length) throw badRequest(errors.join('; '));
  if (!Object.keys(value).length) throw badRequest('Пустой PATCH: не передано ни одного поля манифеста');

  const allDocs = await listTenderDocuments(doc.tender_id);
  if ('supersedes_document_id' in value && value.supersedes_document_id) {
    const err = validateSupersedes(
      allDocs.map((d) => (d.id === documentId ? { ...d, supersedes_document_id: null } : d)),
      documentId,
      value.supersedes_document_id,
    );
    if (err) throw badRequest(err);
  }

  await db.transaction(async (tx) => {
    const keys = Object.keys(value);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await tx.queryRun(
      `UPDATE documents SET ${sets} WHERE id = ?`,
      ...keys.map((k) => value[k]),
      documentId,
    );
    if (value.supersedes_document_id) {
      await tx.queryRun(
        `UPDATE documents SET actuality_status = 'superseded'
          WHERE id = ? AND tender_id = ? AND COALESCE(actuality_status, 'actual') <> 'superseded'`,
        value.supersedes_document_id, doc.tender_id,
      );
    }
  });

  await audit.record({
    requestId,
    tenantId: actor && actor.tenantId,
    actorSub: actor && actor.subject,
    action: 'document.manifest_update',
    category: 'write',
    outcome: 'allowed',
    tenderId: doc.tender_id,
    resourceType: 'document',
    resourceId: documentId,
    meta: { patch: value },
  }).catch(() => {});

  const fresh = await listTenderDocuments(doc.tender_id);
  const updated = annotateDocuments(fresh).find((d) => d.id === documentId) || null;
  return { document: updated, manifest: buildManifest(fresh) };
}

module.exports = {
  DOC_COLUMNS,
  listTenderDocuments,
  getManifest,
  updateDocumentManifest,
};
