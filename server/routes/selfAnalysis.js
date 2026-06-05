'use strict';

const express = require('express');
const ctrl = require('../controllers/selfAnalysisController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Слой self-analysis (QC/полнота над итогом: кластеры + ТЗ; новая архитектура).
router.post('/tenders/:id/self-analysis/build', asyncHandler(ctrl.build));
router.get('/tenders/:id/self-analysis', asyncHandler(ctrl.list));

module.exports = router;
