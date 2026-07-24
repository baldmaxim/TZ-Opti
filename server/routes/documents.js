'use strict';

const express = require('express');
const ctrl = require('../controllers/documentsController');
const { acceptSingle, documentScreening } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/documents', asyncHandler(ctrl.listForTender));
// Файл принимается в карантин (acceptSingle) и попадает в папку тендера
// только после проверок формата, сигнатуры и антивируса (documentScreening).
router.post('/tenders/:id/documents', acceptSingle('file'), asyncHandler(documentScreening), asyncHandler(ctrl.upload));
router.get('/documents/:id/download', asyncHandler(ctrl.download));
router.get('/documents/:id/text', asyncHandler(ctrl.getExtracted));
router.delete('/documents/:id', asyncHandler(ctrl.remove));

module.exports = router;
