'use strict';

const express = require('express');
const ctrl = require('../controllers/documentsController');
const { acceptSingle, documentScreening } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/tenders/:id/documents', asyncHandler(ctrl.listForTender));
// Манифест тендерного пакета: чтение — сводка по тендеру, запись — манифест-поля
// одного документа (редакция / статус / дата / приоритет / применимость / замена).
router.get('/tenders/:id/manifest', asyncHandler(ctrl.getManifest));
router.patch('/documents/:id/manifest', asyncHandler(ctrl.updateManifest));
// Файл принимается в карантин (acceptSingle) и попадает в папку тендера
// только после проверок формата, сигнатуры и антивируса (documentScreening).
router.post('/tenders/:id/documents', acceptSingle('file'), asyncHandler(documentScreening), asyncHandler(ctrl.upload));
router.get('/documents/:id/download', asyncHandler(ctrl.download));
router.get('/documents/:id/text', asyncHandler(ctrl.getExtracted));
router.delete('/documents/:id', asyncHandler(ctrl.remove));

module.exports = router;
