'use strict';

const express = require('express');
const ctrl = require('../controllers/documentsController');
const { documentUpload } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/documents', asyncHandler(ctrl.listForTender));
router.post('/tenders/:id/documents', documentUpload.single('file'), asyncHandler(ctrl.upload));
router.get('/documents/:id/download', asyncHandler(ctrl.download));
router.get('/documents/:id/text', asyncHandler(ctrl.getExtracted));
router.delete('/documents/:id', asyncHandler(ctrl.remove));

module.exports = router;
