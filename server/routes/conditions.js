'use strict';

const express = require('express');
const ctrl = require('../controllers/conditionsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/conditions',                           asyncHandler(ctrl.list));
// Матрица покрытия — ДО ':idx', чтобы «coverage» не разобрался как индекс.
router.get('/tenders/:id/conditions/coverage',                  asyncHandler(ctrl.coverage));
router.patch('/tenders/:id/conditions/coverage/:topicKey',      asyncHandler(ctrl.coverageOverride));
router.patch('/tenders/:id/conditions/:idx',                    asyncHandler(ctrl.patch));
router.delete('/tenders/:id/conditions/:idx/override',          asyncHandler(ctrl.removeOverride));
router.post('/tenders/:id/conditions/reset',                    asyncHandler(ctrl.reset));

module.exports = router;
