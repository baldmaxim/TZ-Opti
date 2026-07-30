'use strict';

const express = require('express');
const ctrl = require('../controllers/agreedVersionsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// Согласованные версии ТЗ: решения рецензии → материализованный .md, активная
// версия — вход следующего раунда анализа и база экспорта конкретной версии.
router.post('/tenders/:id/agreed-versions', asyncHandler(ctrl.create));
router.get('/tenders/:id/agreed-versions', asyncHandler(ctrl.list));
router.get('/tenders/:id/agreed-versions/:versionId', asyncHandler(ctrl.get));
router.post('/tenders/:id/agreed-versions/:versionId/activate', asyncHandler(ctrl.activate));
router.post('/tenders/:id/agreed-versions/:versionId/archive', asyncHandler(ctrl.archive));

module.exports = router;
