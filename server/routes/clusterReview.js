'use strict';

const express = require('express');
const ctrl = require('../controllers/clusterReviewController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Cluster-review (этап 6): issue_clusters — основной объект финальной рецензии и экспорта.
router.post('/tenders/:id/review/clusters/build', asyncHandler(ctrl.build));
router.get('/tenders/:id/review/clusters', asyncHandler(ctrl.list));
// Перенос решений между прогонами (явное сопоставление + подтверждение).
router.get('/tenders/:id/review/carryovers', asyncHandler(ctrl.carryovers));
router.post('/tenders/:id/review/carryovers/confirm', asyncHandler(ctrl.confirmCarryovers));
router.get('/tenders/:id/review/clusters/:clusterId', asyncHandler(ctrl.get));
router.post('/tenders/:id/review/clusters/:clusterId/decision', asyncHandler(ctrl.decide));

module.exports = router;
