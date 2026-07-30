'use strict';

const express = require('express');
const ctrl = require('../controllers/pipelineController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Оркестратор конвейера анализа (draft_issues → critic → clustering → self-analysis).
router.post('/tenders/:id/pipeline/run', asyncHandler(ctrl.run));
router.get('/tenders/:id/pipeline/status', asyncHandler(ctrl.status));
// Карта затронутого (dry-run селективного пересчёта): без LLM, без записи.
router.get('/tenders/:id/pipeline/impact', asyncHandler(ctrl.impact));

module.exports = router;
