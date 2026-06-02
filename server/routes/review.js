'use strict';

const express = require('express');
const ctrl = require('../controllers/reviewController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/review/preview', asyncHandler(ctrl.preview));
router.get('/tenders/:id/review/consolidated', asyncHandler(ctrl.consolidated));

module.exports = router;
