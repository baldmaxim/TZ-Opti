'use strict';

const express = require('express');
const ctrl = require('../controllers/vorController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/vor', asyncHandler(ctrl.list));
router.get('/tenders/:id/vor/summary', asyncHandler(ctrl.summary));
router.get('/tenders/:id/vor/matching', asyncHandler(ctrl.matching));
router.get('/tenders/:id/vor/preview', asyncHandler(ctrl.preview));
router.post('/tenders/:id/vor/reimport', asyncHandler(ctrl.reimport));

module.exports = router;
