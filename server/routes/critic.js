'use strict';

const express = require('express');
const ctrl = require('../controllers/criticController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Слой critic (оценка значимости draft_issues для генподрядчика, новая архитектура).
router.post('/tenders/:id/critic/build', asyncHandler(ctrl.build));
router.get('/tenders/:id/issue-reviews', asyncHandler(ctrl.list));

module.exports = router;
