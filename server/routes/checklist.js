'use strict';

const express = require('express');
const ctrl = require('../controllers/checklistController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/checklist', asyncHandler(ctrl.list));
router.post('/tenders/:id/checklist', asyncHandler(ctrl.create));
router.patch('/tenders/:id/checklist/:itemId', asyncHandler(ctrl.update));
router.delete('/tenders/:id/checklist/:itemId', asyncHandler(ctrl.remove));

module.exports = router;
