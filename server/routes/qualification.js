'use strict';

const express = require('express');
const ctrl = require('../controllers/qualificationController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// SHADOW-квалификация замечаний (gate качества, параллельный слой):
// чтение оценок, решение инженера, повторный запуск gate, статистика прогона.
router.get('/tenders/:id/qualification', asyncHandler(ctrl.list));
router.get('/tenders/:id/qualification/stats', asyncHandler(ctrl.stats));
router.post('/tenders/:id/qualification/rerun', asyncHandler(ctrl.rerun));
router.get('/tenders/:id/qualification/clusters/:clusterId', asyncHandler(ctrl.get));
router.post('/tenders/:id/qualification/clusters/:clusterId/override', asyncHandler(ctrl.override));

module.exports = router;
