'use strict';

const express = require('express');
const ctrl = require('../controllers/jobsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Сводка очереди — до /jobs/:jobId, иначе 'queue' попадёт в параметр.
router.get('/jobs/queue/stats', asyncHandler(ctrl.stats));
router.get('/tenders/:id/jobs', asyncHandler(ctrl.listForTender));
router.post('/tenders/:id/jobs', asyncHandler(ctrl.enqueue));
router.get('/jobs/:jobId', asyncHandler(ctrl.get));
router.post('/jobs/:jobId/cancel', asyncHandler(ctrl.cancel));

module.exports = router;
