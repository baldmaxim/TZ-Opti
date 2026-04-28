'use strict';

const express = require('express');
const ctrl = require('../controllers/setupLocksController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/setup/locks', asyncHandler(ctrl.list));
router.post('/tenders/:id/setup/:section/lock', asyncHandler(ctrl.lock));
router.post('/tenders/:id/setup/:section/unlock', asyncHandler(ctrl.unlock));

module.exports = router;
