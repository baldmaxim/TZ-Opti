'use strict';

const express = require('express');
const ctrl = require('../controllers/authController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/auth/me', asyncHandler(ctrl.me));

module.exports = router;
