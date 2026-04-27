'use strict';

const express = require('express');
const ctrl = require('../controllers/tendersController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders', asyncHandler(ctrl.list));
router.post('/tenders', asyncHandler(ctrl.create));
router.get('/tenders/:id', asyncHandler(ctrl.getOne));
router.patch('/tenders/:id', asyncHandler(ctrl.update));
router.delete('/tenders/:id', asyncHandler(ctrl.remove));

module.exports = router;
