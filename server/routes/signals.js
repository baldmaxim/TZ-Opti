'use strict';

const express = require('express');
const ctrl = require('../controllers/signalsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Слой signals (debug-чтение новой архитектуры анализа).
router.get('/tenders/:id/signals', asyncHandler(ctrl.list));

module.exports = router;
