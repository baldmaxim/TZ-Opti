'use strict';

// Smoke: ключевые модули сервера подключаются офлайн — без Postgres, без сети,
// без чтения production-.env и без открытия порта.
// Раньше это было невозможно: db/connection.js бросал на импорте, если не задан
// DATABASE_URL, поэтому любой юнит-тест тянул за собой production-окружение.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { blockNetwork } = require('../helpers/network');

// Модули, которые обязаны грузиться офлайн (контроллеры/сервисы/движок/app).
const MODULES = [
  '../../app',
  '../../db/connection',
  '../../db/migrate',
  '../../db/seed',
  '../../middleware/errorHandler',
  '../../controllers/exportController',
  '../../services/exportService',
  '../../services/reviewHtmlService',
  '../../services/reviewDocx',
  '../../services/review/clusterReviewService',
  '../../services/review/consolidation',
  '../../services/clustering/clusteringService',
  '../../services/critic/criticService',
  '../../services/selfAnalysis/selfAnalysisService',
  '../../services/pipeline/analysisPipeline',
  '../../services/stageAnalysis/stageAnalysisEngine',
  '../../services/stageAnalysis/llm/openaiClient',
  // Очередь фоновых задач: воркер и его обработчики обязаны подключаться без
  // БД — иначе отдельный процесс-воркер нельзя было бы даже загрузить в тесте.
  '../../services/jobs/jobModel',
  '../../services/jobs/jobQueue',
  '../../services/jobs/advisoryLock',
  '../../services/jobs/jobService',
  '../../services/jobs/worker',
  '../../services/jobs/handlers',
];

test('ключевые модули грузятся без DATABASE_URL, без сети и без listen', (t) => {
  const savedDb = process.env.DATABASE_URL;
  const savedTestDb = process.env.TEST_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  t.after(() => {
    if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
    if (savedTestDb !== undefined) process.env.TEST_DATABASE_URL = savedTestDb;
  });

  const net = blockNetwork(t);

  const realListen = http.Server.prototype.listen;
  const listens = [];
  http.Server.prototype.listen = function spyListen(...args) {
    listens.push(args);
    return realListen.apply(this, args);
  };
  t.after(() => {
    http.Server.prototype.listen = realListen;
  });

  for (const m of MODULES) {
    assert.doesNotThrow(() => require(m), `модуль ${m} не должен падать на импорте`);
  }

  assert.deepEqual(listens, [], 'импорт модулей не должен открывать порт');
  assert.deepEqual(net.attempts, [], 'импорт модулей не должен ходить в сеть');

  const db = require('../../db/connection');
  assert.equal(db.isPoolOpen(), false, 'импорт не должен поднимать pg-пул');
});

test('обращение к БД без цели подключения — fail-closed, а не тихий production', async (t) => {
  const savedDb = process.env.DATABASE_URL;
  const savedTestDb = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://prod:pw@prod.example.com:5432/postgres';
  delete process.env.TEST_DATABASE_URL;
  t.after(() => {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedTestDb !== undefined) process.env.TEST_DATABASE_URL = savedTestDb;
  });

  const net = blockNetwork(t);
  const db = require('../../db/connection');

  await assert.rejects(() => db.queryAll('SELECT 1'), (err) => {
    assert.equal(err.code, 'TEST_DATABASE_URL_MISSING');
    return true;
  });
  assert.deepEqual(net.attempts, [], 'к production-хосту не должно быть даже попытки соединения');
  assert.equal(db.isPoolOpen(), false);
});
