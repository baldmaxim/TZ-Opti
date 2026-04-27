'use strict';

const express = require('express');
const ctrl = require('../controllers/risksController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/risks/global', asyncHandler(ctrl.listGlobal));
router.get('/tenders/:id/risks', asyncHandler(ctrl.list));
router.post('/tenders/:id/risks', asyncHandler(ctrl.create));
router.patch('/tenders/:id/risks/:itemId', asyncHandler(ctrl.update));
router.delete('/tenders/:id/risks/:itemId', asyncHandler(ctrl.remove));

module.exports = router;
