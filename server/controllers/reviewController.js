'use strict';

const { renderReviewHtml } = require('../services/reviewHtmlService');

exports.preview = async (req, res) => {
  const html = await renderReviewHtml(req.params.id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};
