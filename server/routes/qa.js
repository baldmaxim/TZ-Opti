'use strict';

const express = require('express');
const ctrl = require('../controllers/qaController');
const { qaUpload } = require('../middleware/upload');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post('/tenders/:id/qa/import', qaUpload.single('file'), asyncHandler(ctrl.import));
router.get('/tenders/:id/qa', asyncHandler(ctrl.listQa));
router.get('/tenders/:id/characteristics', asyncHandler(ctrl.listCharacteristics));
router.patch('/characteristics/:charId', asyncHandler(ctrl.patchCharacteristic));

module.exports = router;
