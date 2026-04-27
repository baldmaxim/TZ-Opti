'use strict';

const { renderReviewHtml } = require('../services/reviewHtmlService');

exports.preview = (req, res) => {
  const html = renderReviewHtml(req.params.id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};
