'use strict';

const express = require('express');
const ctrl = require('../controllers/conditionsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/conditions', asyncHandler(ctrl.list));
router.post('/tenders/:id/conditions', asyncHandler(ctrl.create));
router.patch('/tenders/:id/conditions/:itemId', asyncHandler(ctrl.update));
router.delete('/tenders/:id/conditions/:itemId', asyncHandler(ctrl.remove));

module.exports = router;
