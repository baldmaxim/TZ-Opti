'use strict';

const express = require('express');
const ctrl = require('../controllers/adminController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Физическое удаление истории анализа — только здесь и только с правом
// admin.system (см. security/policy.js). GET — план, POST — удаление с confirm.
router.get('/admin/tenders/:id/analysis-history/purge', asyncHandler(ctrl.planPurge));
router.post('/admin/tenders/:id/analysis-history/purge', asyncHandler(ctrl.purge));

module.exports = router;
