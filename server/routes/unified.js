'use strict';

const express = require('express');
const ctrl = require('../controllers/unifiedController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Единый анализатор ТЗ (новая архитектура, поверх signals).
router.post('/tenders/:id/unified/build', asyncHandler(ctrl.build));
router.get('/tenders/:id/draft-issues', asyncHandler(ctrl.list));

module.exports = router;
