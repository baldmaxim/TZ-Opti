'use strict';

const express = require('express');
const ctrl = require('../controllers/vorController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/vor', asyncHandler(ctrl.list));
router.get('/tenders/:id/vor/summary', asyncHandler(ctrl.summary));
router.get('/tenders/:id/vor/matching', asyncHandler(ctrl.matching));
// Карта сопоставления «требование ТЗ ↔ позиции ВОР» + решение инженера по связи.
router.get('/tenders/:id/vor/requirements', asyncHandler(ctrl.requirements));
router.patch('/tenders/:id/vor/requirements/:matchKey', asyncHandler(ctrl.confirmRequirement));
router.get('/tenders/:id/vor/preview', asyncHandler(ctrl.preview));
router.post('/tenders/:id/vor/reimport', asyncHandler(ctrl.reimport));

module.exports = router;
