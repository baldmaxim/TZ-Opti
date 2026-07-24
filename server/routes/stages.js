'use strict';

const express = require('express');
const ctrl = require('../controllers/stagesController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/stages', asyncHandler(ctrl.getState));
router.post('/tenders/:id/stages/:n/run', asyncHandler(ctrl.run));
router.post('/tenders/:id/stages/:n/finish', asyncHandler(ctrl.finish));
router.post('/tenders/:id/stages/:n/reset', asyncHandler(ctrl.reset));
router.get('/tenders/:id/stages/:n/issues', asyncHandler(ctrl.listIssues));
// Части ТЗ (иерархическая сегментация): статус каждой + точечный перезапуск.
router.get('/tenders/:id/stages/:n/segments', asyncHandler(ctrl.listSegments));
router.post('/tenders/:id/stages/:n/segments/:idx/retry', asyncHandler(ctrl.retrySegment));

module.exports = router;
