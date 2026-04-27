'use strict';

const { v4: uuid } = require('uuid');

const newId = () => uuid();
const nowIso = () => new Date().toISOString();

module.exports = { newId, nowIso };
