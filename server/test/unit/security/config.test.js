'use strict';

// Конфигурация безопасности: что считается «настроено», и что обязано ронять
// старт в production. Чистые функции, ни env процесса, ни сети.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConfig,
  productionSecurityProblems,
  assertProductionSecurity,
  resolveMode,
  SecurityConfigError,
} = require('../../../security/config');
const { buildPrincipal, devPrincipal, getClaim, mapRoles, PrincipalError } = require('../../../security/principal');

const PROD_OK = {
  NODE_ENV: 'production',
  AUTH_OIDC_ISSUER: 'https://idp.example.com/realms/tz',
  AUTH_JWT_AUDIENCE: 'tz-opti-api',
  CORS_ALLOWED_ORIGINS: 'https://portal.example.com',
  AV_SCAN_MODE: 'clamd',
};

// В тестовом процессе NODE_ENV=production не даёт режим production (сигнал
// node --test неотключаем), поэтому режим проверяем на «чужом» окружении.
test('режим процесса: staging защищается как production, тестовый процесс — никогда', () => {
  assert.equal(resolveMode({ NODE_ENV: 'production' }), 'production');
  assert.equal(resolveMode({ NODE_ENV: 'staging' }), 'production');
  assert.equal(resolveMode({ NODE_ENV: 'development' }), 'development');
  assert.equal(resolveMode({}), 'development');
  assert.equal(resolveMode({ NODE_ENV: 'production', NODE_TEST_CONTEXT: 'child-v8' }), 'test');
});

test('корректная production-конфигурация проходит проверку', () => {
  const config = buildConfig(PROD_OK);
  assert.deepEqual(productionSecurityProblems(config), []);
  assert.equal(assertProductionSecurity(config), config);
});

test('production без аутентификации не стартует', () => {
  const config = buildConfig({ ...PROD_OK, AUTH_OIDC_ISSUER: '' });
  const problems = productionSecurityProblems(config);
  assert.ok(problems.some((p) => /AUTH/.test(p)));
  assert.throws(() => assertProductionSecurity(config), (err) => err instanceof SecurityConfigError);
});

test('dev-bypass в production — ошибка старта, вне production — рабочий режим', () => {
  const prod = buildConfig({ ...PROD_OK, AUTH_DEV_BYPASS: '1' });
  assert.equal(prod.auth.devBypass.enabled, false);
  assert.ok(productionSecurityProblems(prod).some((p) => /AUTH_DEV_BYPASS/.test(p)));

  const dev = buildConfig({ NODE_ENV: 'development', AUTH_DEV_BYPASS: '1', AUTH_DEV_ROLES: 'engineer' });
  assert.equal(dev.auth.devBypass.enabled, true);
});

test('production требует allowlist CORS, антивирус, аудит и лимитер', () => {
  const cases = [
    [{ CORS_ALLOWED_ORIGINS: '' }, /CORS_ALLOWED_ORIGINS пуст/],
    [{ CORS_ALLOWED_ORIGINS: '*' }, /"\*"/],
    [{ AV_SCAN_MODE: 'disabled' }, /AV_SCAN_MODE=disabled/],
    [{ AV_SCAN_MODE: 'command' }, /AV_COMMAND/],
    [{ AV_SCAN_MODE: 'http' }, /AV_HTTP_URL/],
    [{ AUDIT_ENABLED: '0' }, /AUDIT_ENABLED=0/],
    [{ RATE_LIMIT_ENABLED: '0' }, /RATE_LIMIT_ENABLED=0/],
    [{ ERRORS_EXPOSE_INTERNALS: '1' }, /ERRORS_EXPOSE_INTERNALS=1/],
    [{ DATABASE_ALLOW_INSECURE_TLS: '1' }, /DATABASE_ALLOW_INSECURE_TLS/],
    [{ AUTH_JWT_AUDIENCE: '' }, /AUTH_JWT_AUDIENCE/],
  ];
  for (const [override, re] of cases) {
    const problems = productionSecurityProblems(buildConfig({ ...PROD_OK, ...override }));
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(override)} → ${problems.join(' | ')}`);
  }
});

test('симметричный алгоритм при асимметричном режиме — риск alg-confusion', () => {
  const problems = productionSecurityProblems(buildConfig({ ...PROD_OK, AUTH_JWT_ALGORITHMS: 'RS256,HS256' }));
  assert.ok(problems.some((p) => /alg-confusion/.test(p)));

  const secretMode = buildConfig({
    ...PROD_OK,
    AUTH_MODE: 'secret',
    AUTH_JWT_HS_SECRET: 'x'.repeat(40),
    AUTH_JWT_ALGORITHMS: 'HS256',
  });
  assert.deepEqual(productionSecurityProblems(secretMode), []);

  const shortSecret = buildConfig({ ...PROD_OK, AUTH_MODE: 'secret', AUTH_JWT_HS_SECRET: 'short', AUTH_JWT_ALGORITHMS: 'HS256' });
  assert.ok(productionSecurityProblems(shortSecret).some((p) => /32 символов/.test(p)));
});

test('режим определяется по заданным переменным, а не отдельным переключателем', () => {
  assert.equal(buildConfig({ AUTH_JWKS_URI: 'https://idp/keys' }).auth.mode, 'jwks');
  assert.equal(buildConfig({ AUTH_OIDC_ISSUER: 'https://idp' }).auth.mode, 'oidc');
  assert.equal(buildConfig({ AUTH_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----' }).auth.mode, 'public_key');
  assert.equal(buildConfig({ AUTH_JWT_HS_SECRET: 's' }).auth.mode, 'secret');
  assert.equal(buildConfig({}).auth.mode, 'disabled');
});

test('пустая переменная — это «не задано», а не ноль', () => {
  const config = buildConfig({ RATE_LIMIT_MAX: '', MAX_UPLOAD_MB: '  ', AUTH_CLOCK_SKEW_SEC: 'abc' });
  assert.equal(config.rateLimit.max, 300);
  assert.equal(config.uploads.maxMb, 50);
  assert.equal(config.auth.clockSkewSec, 60);
});

// --- principal ---------------------------------------------------------------

const authOf = (env) => buildConfig(env).auth;

test('principal собирается из клеймов провайдера (Keycloak-подобный токен)', () => {
  const auth = authOf({ AUTH_CLAIM_TENANT: 'tenant_id', AUTH_CLAIM_ROLES: 'realm_access.roles' });
  const p = buildPrincipal(
    { sub: 'u1', tenant_id: 'tenant-a', realm_access: { roles: ['engineer', 'offline_access'] }, email: 'e@x.kz', exp: 1 },
    auth,
  );
  assert.equal(p.subject, 'u1');
  assert.equal(p.tenantId, 'tenant-a');
  assert.deepEqual(p.roles, ['engineer'], 'служебные роли провайдера отбрасываются');
  assert.ok(p.permissions.includes('analysis.run'));
  assert.ok(Object.isFrozen(p));
});

test('principal: клеймы с URL-подобным именем (Auth0) и роли из scope', () => {
  const auth = authOf({ AUTH_CLAIM_TENANT: 'https://tz-opti/tenant', AUTH_CLAIM_ROLES: 'https://tz-opti/roles' });
  const p = buildPrincipal({ sub: 'u1', 'https://tz-opti/tenant': 'tenant-b', 'https://tz-opti/roles': 'lead' }, auth);
  assert.equal(p.tenantId, 'tenant-b');
  assert.deepEqual(p.roles, ['lead']);

  const scoped = buildPrincipal({ sub: 'u2', tenant_id: 't', scope: 'openid profile viewer' }, authOf({}));
  assert.deepEqual(scoped.roles, ['viewer']);
});

test('principal: отображение ролей провайдера через AUTH_ROLE_MAP', () => {
  const auth = authOf({ AUTH_ROLE_MAP: 'tz-opti-engineers:engineer,tz-opti-heads:lead' });
  const p = buildPrincipal({ sub: 'u1', tenant_id: 't', roles: ['tz-opti-heads'] }, auth);
  assert.deepEqual(p.roles, ['lead']);
  assert.deepEqual(mapRoles(['unknown-group'], auth.roleMap, []), [], 'неотображённая группа прав не даёт');
});

test('principal: без тенанта и без ролей — отказ', () => {
  assert.throws(() => buildPrincipal({ sub: 'u1', roles: ['engineer'] }, authOf({})), (e) => e.code === 'TENANT_CLAIM_MISSING');
  assert.throws(() => buildPrincipal({ sub: 'u1', tenant_id: 't' }, authOf({})), (e) => e.code === 'NO_ROLES');
  assert.throws(() => buildPrincipal({ tenant_id: 't', roles: ['admin'] }, authOf({})), (e) => e.code === 'SUB_MISSING');
  assert.throws(
    () => buildPrincipal({ sub: 'u', tenant_id: ['a', 'b'], roles: ['admin'] }, authOf({})),
    (e) => e instanceof PrincipalError && e.code === 'TENANT_AMBIGUOUS',
  );
});

test('principal: роли по умолчанию применяются, когда провайдер их не отдаёт', () => {
  const auth = authOf({ AUTH_DEFAULT_ROLES: 'viewer' });
  const p = buildPrincipal({ sub: 'u1', tenant_id: 't' }, auth);
  assert.deepEqual(p.roles, ['viewer']);
});

test('getClaim читает вложенный путь и точное имя', () => {
  assert.equal(getClaim({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  assert.equal(getClaim({ 'a.b': 7 }, 'a.b'), 7);
  assert.equal(getClaim({}, 'nope.deep'), undefined);
});

test('dev-principal получает роли из окружения', () => {
  const dev = devPrincipal({ subject: 'dev', tenantId: 'tenant-a', roles: ['engineer'], email: 'd@x' });
  assert.equal(dev.authMethod, 'dev-bypass');
  assert.deepEqual(dev.roles, ['engineer']);
});
