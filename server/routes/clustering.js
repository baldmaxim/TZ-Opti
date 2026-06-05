'use strict';

const express = require('express');
const ctrl = require('../controllers/clusteringController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Слой clustering (объединение похожих замечаний по одному месту ТЗ, новая архитектура).
router.post('/tenders/:id/clustering/build', asyncHandler(ctrl.build));
router.get('/tenders/:id/issue-clusters', asyncHandler(ctrl.list));

module.exports = router;
