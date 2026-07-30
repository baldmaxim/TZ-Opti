'use strict';

const express = require('express');
const ctrl = require('../controllers/qaController');
const { acceptSingle, qaScreening } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Файл принимается в карантин (acceptSingle) и попадает в папку тендера
// только после проверок формата, сигнатуры и антивируса (qaScreening).
router.post('/tenders/:id/qa/import', acceptSingle('file'), asyncHandler(qaScreening), asyncHandler(ctrl.import));
// Раунды импорта: предпросмотр diff → применение выбранных листов / отмена.
router.post('/tenders/:id/qa/imports/preview', acceptSingle('file'), asyncHandler(qaScreening), asyncHandler(ctrl.previewImport));
router.get('/tenders/:id/qa/imports', asyncHandler(ctrl.listImports));
router.post('/tenders/:id/qa/imports/:importId/apply', asyncHandler(ctrl.applyImport));
router.post('/tenders/:id/qa/imports/:importId/discard', asyncHandler(ctrl.discardImport));
router.post('/tenders/:id/qa/auto-link', asyncHandler(ctrl.autoLink));
router.get('/tenders/:id/qa', asyncHandler(ctrl.listQa));
router.get('/tenders/:id/qa/export', asyncHandler(ctrl.exportXlsx));
router.patch('/tenders/:id/qa/:entryId', asyncHandler(ctrl.patchQaEntry));
router.get('/tenders/:id/characteristics', asyncHandler(ctrl.listCharacteristics));
router.post('/tenders/:id/characteristics', asyncHandler(ctrl.createCharacteristic));
router.post('/tenders/:id/characteristics/seed', asyncHandler(ctrl.seedCharacteristics));
router.patch('/characteristics/:charId', asyncHandler(ctrl.patchCharacteristic));
router.delete('/characteristics/:charId', asyncHandler(ctrl.deleteCharacteristic));

module.exports = router;
