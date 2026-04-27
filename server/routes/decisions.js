'use strict';

const express = require('express');
const ctrl = require('../controllers/decisionsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.patch('/issues/:id', asyncHandler(ctrl.patchIssue));
router.post('/issues/:id/decision', asyncHandler(ctrl.makeDecision));

module.exports = router;
