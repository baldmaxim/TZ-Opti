'use strict';

const express = require('express');
const ctrl = require('../controllers/exportController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/export/docx', asyncHandler(ctrl.docx));
router.get('/tenders/:id/export/issues.csv', asyncHandler(ctrl.csv));
router.get('/tenders/:id/export/issues.json', asyncHandler(ctrl.json));
router.get('/tenders/:id/export/summary.md', asyncHandler(ctrl.summary));

module.exports = router;
