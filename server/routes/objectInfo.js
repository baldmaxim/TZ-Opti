'use strict';

const express = require('express');
const ctrl = require('../controllers/objectInfoController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/object-info', asyncHandler(ctrl.get));
router.put('/tenders/:id/object-info', asyncHandler(ctrl.upsert));

module.exports = router;
