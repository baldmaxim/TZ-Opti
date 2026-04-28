'use strict';

const express = require('express');
const ctrl = require('../controllers/risksController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/risks',                       asyncHandler(ctrl.list));
router.get('/tenders/:id/risks/matches',               asyncHandler(ctrl.matches));
router.post('/tenders/:id/risks/reset',                asyncHandler(ctrl.reset));
router.post('/tenders/:id/risks/custom',               asyncHandler(ctrl.createCustom));
router.delete('/tenders/:id/risks/custom/:customId',   asyncHandler(ctrl.removeCustom));
// PATCH принимает любой ключ (стандартный R01.. или custom:<id>) — должен быть последним.
router.patch('/tenders/:id/risks/:key',                asyncHandler(ctrl.patchState));

module.exports = router;
