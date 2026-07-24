'use strict';

const express = require('express');
const ctrl = require('../controllers/auditController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/audit', asyncHandler(ctrl.list));

module.exports = router;
