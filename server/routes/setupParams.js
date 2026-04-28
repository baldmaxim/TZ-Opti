'use strict';

const express = require('express');
const ctrl = require('../controllers/setupParamsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/setup/params',         asyncHandler(ctrl.getParams));
router.put('/tenders/:id/setup/params',         asyncHandler(ctrl.updateParams));
router.get('/tenders/:id/setup/params/schema',  asyncHandler(ctrl.getSchema));

module.exports = router;
