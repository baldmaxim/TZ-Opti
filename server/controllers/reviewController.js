'use strict';

const { renderReviewHtml } = require('../services/reviewHtmlService');
const { consolidate } = require('../services/review/consolidation');

// HTML-preview: cluster-primary, fallback на issue-level (?source=issues — принудительно).
exports.preview = async (req, res) => {
  const html = await renderReviewHtml(req.params.id, { source: req.query.source });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

// Legacy-слой сборки итога по issues (группы находок + конфликты + вердикты).
// С этапа 7 экран «Итог» идёт от кластеров; этот эндпоинт — fallback/back-compat.
exports.consolidated = async (req, res) => {
  const result = await consolidate(req.params.id);
  res.json(result);
};
