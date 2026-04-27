'use strict';

/**
 * Stub для будущей поддержки настоящего Track Changes (`w:ins` / `w:del`).
 *
 * Контракт идентичен strikeWriter / commentWriter, чтобы заменить на полноценную
 * имплементацию без переписывания pipeline.
 *
 * В MVP не используется.
 */

function applyInsertion(_paragraph, _atOffset, _replacementText, _meta) {
  throw new Error('trackChangesWriter.applyInsertion: будет реализовано в следующей итерации');
}

function applyDeletion(_paragraph, _firstIdx, _lastIdx, _meta) {
  throw new Error('trackChangesWriter.applyDeletion: будет реализовано в следующей итерации');
}

module.exports = { applyInsertion, applyDeletion };
