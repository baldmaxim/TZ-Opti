'use strict';

// Оснастка тестов безопасности: НАСТОЯЩИЕ подписанные токены (ключ рождается в
// самом тесте) и приложение, собранное как в бою.
//
// Подменяется только то, что требует внешних систем: pg-соединение (чтобы тесты
// оставались офлайн) и запись журнала аудита (чтобы её можно было проверить).
// Проверка подписи, разбор клеймов, матрица прав, изоляция тенантов и порядок
// middleware — настоящие.

const crypto = require('crypto');

const { buildConfig } = require('../../security/config');
const { createAuthenticator } = require('../../security/authenticator');
const { createTenantResolver } = require('../../security/tenantAccess');

// --- ключи и токены ----------------------------------------------------------

function generateRsa() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}
function generateEc(namedCurve = 'prime256v1') {
  return crypto.generateKeyPairSync('ec', { namedCurve });
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const encodePart = (obj) => b64url(JSON.stringify(obj));

// Подписывает JWT указанным алгоритмом. Умеет намеренно «кривые» варианты
// (alg=none, чужой ключ) — на них и держатся негативные тесты.
function signToken({ header = {}, payload = {}, alg = 'RS256', key, secret }) {
  const head = encodePart({ alg, typ: 'JWT', ...header });
  const body = encodePart(payload);
  const signingInput = `${head}.${body}`;
  const data = Buffer.from(signingInput, 'ascii');

  let signature = Buffer.alloc(0);
  if (alg === 'none') {
    signature = Buffer.alloc(0);
  } else if (alg.startsWith('HS')) {
    const hash = `sha${alg.slice(2)}`;
    signature = crypto.createHmac(hash, secret).update(data).digest();
  } else if (alg.startsWith('RS')) {
    signature = crypto.sign(`sha${alg.slice(2)}`, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  } else if (alg.startsWith('PS')) {
    signature = crypto.sign(`sha${alg.slice(2)}`, data, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else if (alg.startsWith('ES')) {
    const hash = alg === 'ES512' ? 'sha512' : `sha${alg.slice(2)}`;
    signature = crypto.sign(hash, data, { key, dsaEncoding: 'ieee-p1363' });
  } else {
    throw new Error(`не умею подписывать ${alg}`);
  }
  return `${signingInput}.${b64url(signature)}`;
}

const ISSUER = 'https://idp.example.com/realms/tz';
const AUDIENCE = 'tz-opti-api';

// Полезная нагрузка «нормального» токена; любое поле переопределяется.
function claims({ sub = 'user-1', tenant = 'tenant-a', roles = ['engineer'], now = Date.now(), ttlSec = 300, ...rest } = {}) {
  const iat = Math.floor(now / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub,
    iat,
    exp: iat + ttlSec,
    tenant_id: tenant,
    realm_access: { roles },
    email: `${sub}@example.com`,
    ...rest,
  };
}

// --- конфигурация ------------------------------------------------------------

// Окружение «как в production, но с локальным ключом»: режим public_key,
// issuer/audience проверяются, dev-bypass выключен.
function securityEnv(publicKeyPem, overrides = {}) {
  return {
    NODE_ENV: 'test',
    AUTH_MODE: 'public_key',
    AUTH_JWT_PUBLIC_KEY: publicKeyPem,
    AUTH_OIDC_ISSUER: ISSUER,
    AUTH_JWT_AUDIENCE: AUDIENCE,
    AUTH_CLAIM_TENANT: 'tenant_id',
    AUTH_CLAIM_ROLES: 'realm_access.roles',
    CORS_ALLOWED_ORIGINS: 'https://portal.example.com',
    AUDIT_ENABLED: '1',
    ...overrides,
  };
}

// --- поддельные хранилища ----------------------------------------------------

// Резолвер тенантов поверх настоящего createTenantResolver: подменяется только
// db.queryOne, сами SQL-запросы и логика сверки остаются боевыми.
function fakeTenantDb(fixtures = {}) {
  const { tenders = {}, documents = {}, issues = {}, characteristics = {}, jobs = {} } = fixtures;
  const tenantOf = (tenderId) => tenders[tenderId];
  return {
    async queryOne(sql, id) {
      if (/FROM tenders t\b/.test(sql)) {
        const tenant = tenantOf(id);
        return tenant ? { tender_id: id, tenant_id: tenant } : undefined;
      }
      const child = (table, map) => {
        if (!new RegExp(`FROM ${table}\\b`).test(sql)) return null;
        const tenderId = map[id];
        if (!tenderId) return undefined;
        return { tender_id: tenderId, tenant_id: tenantOf(tenderId) };
      };
      for (const [table, map] of [
        ['documents', documents],
        ['issues', issues],
        ['characteristics', characteristics],
        ['analysis_jobs', jobs],
      ]) {
        const row = child(table, map);
        if (row !== null) return row;
      }
      return undefined;
    },
  };
}

// Журнал аудита в памяти: тест смотрит, ЧТО и с каким исходом записано.
function fakeAudit() {
  const entries = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
      return 'audit-id';
    },
    async list() {
      return { items: entries, total: entries.length, limit: 100, offset: 0 };
    },
    find: (action) => entries.filter((e) => e.action === action),
    last: () => entries[entries.length - 1],
  };
}

// Подмена pg-соединения (singleton): контроллеры обращаются к db через
// свойство объекта, поэтому патч виден и им. Восстанавливается после теста.
function stubDb(t, handler) {
  const db = require('../../db/connection');
  const saved = { queryOne: db.queryOne, queryAll: db.queryAll, queryRun: db.queryRun, transaction: db.transaction };
  const calls = [];
  const dispatch = (kind) => async (sql, ...params) => {
    calls.push({ kind, sql, params });
    const result = await handler({ kind, sql, params });
    if (result !== undefined) return result;
    if (kind === 'queryAll') return [];
    if (kind === 'queryRun') return { changes: 1, rows: [] };
    return undefined;
  };
  db.queryOne = dispatch('queryOne');
  db.queryAll = dispatch('queryAll');
  db.queryRun = dispatch('queryRun');
  db.transaction = async (fn) => fn({ queryOne: db.queryOne, queryAll: db.queryAll, queryRun: db.queryRun });
  t.after(() => Object.assign(db, saved));
  return calls;
}

// --- приложение --------------------------------------------------------------

// Поднимает приложение на эфемерном порту и гарантированно гасит его.
async function withApp(t, { env = {}, publicKeyPem, tenantFixtures = {}, audit = fakeAudit() } = {}) {
  const { createApp } = require('../../app');
  const config = buildConfig(securityEnv(publicKeyPem, env));
  const authenticator = createAuthenticator(config);
  const tenantResolver = createTenantResolver({ db: fakeTenantDb(tenantFixtures), defaultTenantId: config.defaultTenantId });
  const app = createApp({ logger: false, security: { config, authenticator, tenantResolver, audit } });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const opts = { method, headers: { ...headers } };
    if (token) opts.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, opts);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON — тест посмотрит на текст */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  return { base, call, app, config, audit };
}

module.exports = {
  generateRsa,
  generateEc,
  signToken,
  claims,
  securityEnv,
  fakeTenantDb,
  fakeAudit,
  stubDb,
  withApp,
  ISSUER,
  AUDIENCE,
};
