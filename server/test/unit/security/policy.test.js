'use strict';

// Правила доступа и матрица ролей.
//
// Ключевой тест здесь — ПОКРЫТИЕ: каждый зарегистрированный маршрут приложения
// обязан иметь правило. Новый маршрут без строки в security/policy.js работать
// не будет (default deny), и узнать об этом нужно здесь, а не в бою.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePolicy, normalizePath, isPublicPath, RULES } = require('../../../security/policy');
const { ROLES, PERMISSIONS, ROLE_PERMISSIONS, permissionsFor, can, permissionMatrix } = require('../../../security/roles');

// Собирает все маршруты приложения: [{method, path}] с подставленными
// значениями параметров.
function registeredRoutes() {
  const { createApp } = require('../../../app');
  const app = createApp({ logger: false });
  const routes = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on) routes.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + '/api');
      }
    }
  };
  walk(app._router.stack, '');
  return routes;
}

const sample = (path) => path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, 'sample-id');

test('у каждого маршрута приложения есть правило доступа', () => {
  const routes = registeredRoutes();
  assert.ok(routes.length > 50, `ожидалось много маршрутов, найдено ${routes.length}`);

  const uncovered = [];
  for (const route of routes) {
    if (isPublicPath(route.path)) continue;
    const policy = resolvePolicy(route.method, sample(route.path));
    if (!policy) uncovered.push(`${route.method} ${route.path}`);
  }
  assert.deepEqual(uncovered, [], 'маршруты без правила доступа (добавьте строку в security/policy.js)');
});

test('каждое правило ссылается на существующее право и известный источник тенанта', () => {
  const tenantKinds = new Set(['tender', 'document', 'issue', 'characteristic', 'job', 'principal', 'system']);
  for (const rule of RULES) {
    assert.ok(PERMISSIONS.includes(rule.permission), `${rule.template}: неизвестное право ${rule.permission}`);
    assert.ok(tenantKinds.has(rule.tenantVia), `${rule.template}: неизвестный tenantVia ${rule.tenantVia}`);
    assert.ok(rule.action && rule.category, `${rule.template}: не заполнено действие/категория`);
  }
});

test('действия в правилах уникальны в пределах метода (журнал аудита читаем)', () => {
  const seen = new Map();
  for (const rule of RULES) {
    const key = `${rule.method} ${rule.action}`;
    assert.ok(!seen.has(key), `дубль действия ${key} (${rule.template} и ${seen.get(key)})`);
    seen.set(key, rule.template);
  }
});

test('неизвестный путь и неизвестный метод правила не находят', () => {
  assert.equal(resolvePolicy('GET', '/api/whatever'), null);
  assert.equal(resolvePolicy('DELETE', '/api/tenders/x/stages/1/run'), null);
  assert.equal(resolvePolicy('POST', '/api/tenders/x'), null);
});

test('более специфичный маршрут выигрывает у общего', () => {
  assert.equal(resolvePolicy('GET', '/api/jobs/queue/stats').action, 'queue.stats');
  assert.equal(resolvePolicy('GET', '/api/jobs/job-1').action, 'jobs.get');
  assert.equal(resolvePolicy('GET', '/api/tenders/t1/vor/summary').action, 'vor.summary');
  assert.equal(resolvePolicy('GET', '/api/tenders/t1/vor').action, 'vor.list');
});

test('параметры пути разбираются и декодируются', () => {
  const p = resolvePolicy('POST', '/api/tenders/t-1/stages/3/segments/7/retry');
  assert.equal(p.params.tenderId, 't-1');
  assert.equal(p.params.stage, '3');
  assert.equal(p.params.idx, '7');
  assert.equal(resolvePolicy('GET', '/api/documents/a%2Fb/download').params.documentId, 'a/b');
});

test('нормализация пути: query и хвостовой слэш не мешают', () => {
  assert.equal(normalizePath('/api/tenders?search=x'), '/tenders');
  assert.equal(normalizePath('/api/tenders/'), '/tenders');
  assert.equal(resolvePolicy('GET', '/api/tenders/t1/qa?limit=5').action, 'qa.list');
});

test('HEAD трактуется как GET', () => {
  assert.equal(resolvePolicy('HEAD', '/api/tenders').action, 'tender.list');
});

test('публичный маршрут ровно один — /health', () => {
  assert.equal(isPublicPath('/api/health'), true);
  assert.equal(isPublicPath('/api/tenders'), false);
  assert.equal(isPublicPath('/api/auth/me'), false);
});

// --- матрица ролей -----------------------------------------------------------

test('роли: viewer только читает, engineer решает, admin может всё', () => {
  assert.deepEqual(ROLES, ['viewer', 'engineer', 'lead', 'manager', 'admin']);

  assert.deepEqual([...permissionsFor(['viewer'])].sort(), ['document.read', 'tender.read']);
  assert.equal(can(['engineer'], 'decision.write'), true);
  assert.equal(can(['engineer'], 'tender.delete'), false, 'удаление тендера — не к инженеру');
  assert.equal(can(['engineer'], 'audit.read'), false);
  assert.equal(can(['lead'], 'tender.delete'), true);
  assert.equal(can(['lead'], 'audit.read'), true);
  assert.equal(can(['manager'], 'export.perform'), true);
  assert.equal(can(['manager'], 'decision.write'), false);
  assert.equal(can(['manager'], 'analysis.run'), false);
  for (const p of PERMISSIONS) assert.equal(can(['admin'], p), true, `admin должен иметь ${p}`);
});

test('права объединяются по всем ролям субъекта', () => {
  assert.equal(can(['viewer', 'manager'], 'export.perform'), true);
  assert.equal(can(['viewer', 'engineer'], 'analysis.run'), true);
});

test('неизвестная роль и неизвестное право не дают ничего', () => {
  assert.equal(can(['superuser'], 'tender.read'), false);
  assert.deepEqual([...permissionsFor(['nope', ''])], []);
  assert.equal(can(['admin'], 'tender.destroy_everything'), false);
});

test('ни у одной роли, кроме admin/lead/manager, нет доступа к журналу аудита', () => {
  const matrix = permissionMatrix();
  assert.deepEqual(matrix['audit.read'], ['lead', 'manager', 'admin']);
  assert.deepEqual(matrix['admin.system'], ['admin']);
});

test('таблицы ролей заморожены (случайная мутация невозможна)', () => {
  assert.throws(() => {
    ROLE_PERMISSIONS.viewer.push('tender.delete');
  });
});
