'use strict';

const express = require('express');
const ctrl = require('../controllers/reviewController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/review/preview', asyncHandler(ctrl.preview));

module.exports = router;
