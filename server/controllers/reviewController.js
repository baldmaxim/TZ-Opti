'use strict';

const { renderReviewHtml } = require('../services/reviewHtmlService');
const { consolidate } = require('../services/review/consolidation');

exports.preview = async (req, res) => {
  const html = await renderReviewHtml(req.params.id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

// Слой сборки: единый итог по тендеру (группы находок + конфликты + вердикты).
exports.consolidated = async (req, res) => {
  const result = await consolidate(req.params.id);
  res.json(result);
};
