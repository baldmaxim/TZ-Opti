'use strict';

// Единый источник правды по безопасности: env → замороженный объект конфигурации.
//
// Два правила, из которых следует всё остальное:
//   1. ЧИСТОТА. Модуль читает окружение только через аргумент (env = process.env),
//      ничего не кэширует глобально и не ходит в сеть/БД — его можно целиком
//      прогнать в офлайн-тесте с любым набором переменных.
//   2. FAIL-CLOSED В PRODUCTION. Всё, что «удобно в разработке» (dev-bypass,
//      открытый CORS, выключенный антивирус, нестрогий TLS к БД), в production
//      не просто игнорируется — процесс отказывается стартовать
//      (assertProductionSecurity). Тихой деградации до небезопасного режима нет.

const { isTestProcess } = require('../utils/runtimeMode');

class SecurityConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecurityConfigError';
    this.code = code;
  }
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');
const bool = (v, dflt = false) => {
  const s = trim(v).toLowerCase();
  if (!s) return dflt;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};
const num = (v, dflt) => {
  // Пустая переменная — это «не задано», а не 0: Number('') === 0 молча
  // обнулил бы лимиты (и превратил бы rate limit в «всё запрещено»).
  const raw = trim(v);
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
};
const list = (v) =>
  trim(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Режим процесса. Тестовый процесс НИКОГДА не считается production, даже если
// NODE_ENV=production выставлен снаружи: сигнал `node --test` неотключаем
// (см. utils/runtimeMode.js) — иначе тесты роняли бы production-проверки.
function resolveMode(env = process.env) {
  if (isTestProcess(env)) return 'test';
  const raw = trim(env.NODE_ENV).toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'staging') return 'production'; // staging защищаем как production
  return 'development';
}

const DEFAULT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
// Симметричные алгоритмы разрешены ТОЛЬКО в режиме secret (общий секрет) и
// только если явно перечислены — иначе это классическая alg-confusion атака.
const SYMMETRIC_ALGORITHMS = ['HS256', 'HS384', 'HS512'];
const KNOWN_ALGORITHMS = [...DEFAULT_ALGORITHMS, ...SYMMETRIC_ALGORITHMS];

// Соответствие «роль провайдера → роль TZ-Opti»: AUTH_ROLE_MAP="tz-lead:lead,tz-eng:engineer".
function parseRoleMap(raw) {
  const map = new Map();
  for (const pair of list(raw)) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const from = pair.slice(0, idx).trim();
    const to = pair.slice(idx + 1).trim().toLowerCase();
    if (from && to) map.set(from, to);
  }
  return map;
}

function buildAuthConfig(env, mode) {
  const issuer = trim(env.AUTH_OIDC_ISSUER);
  const jwksUri = trim(env.AUTH_JWKS_URI);
  const publicKey = trim(env.AUTH_JWT_PUBLIC_KEY);
  const publicKeyFile = trim(env.AUTH_JWT_PUBLIC_KEY_FILE);
  const hsSecret = trim(env.AUTH_JWT_HS_SECRET);

  // Режим определяется тем, ЧТО задано, а не отдельной переменной-переключателем:
  // меньше шансов «включить oidc», забыв задать issuer.
  let mode_ = trim(env.AUTH_MODE).toLowerCase();
  if (!mode_) {
    if (jwksUri) mode_ = 'jwks';
    else if (issuer) mode_ = 'oidc';
    else if (publicKey || publicKeyFile) mode_ = 'public_key';
    else if (hsSecret) mode_ = 'secret';
    else mode_ = 'disabled';
  }

  const configuredAlgs = list(env.AUTH_JWT_ALGORITHMS).map((a) => a.toUpperCase());
  const algorithms = configuredAlgs.length
    ? configuredAlgs
    : mode_ === 'secret'
      ? ['HS256']
      : DEFAULT_ALGORITHMS;

  const devBypassRequested = bool(env.AUTH_DEV_BYPASS, false);

  return {
    mode: mode_,
    issuer,
    jwksUri,
    publicKey,
    publicKeyFile,
    hsSecret,
    audience: list(env.AUTH_JWT_AUDIENCE),
    algorithms,
    clockSkewSec: num(env.AUTH_CLOCK_SKEW_SEC, 60),
    jwksCacheSec: num(env.AUTH_JWKS_CACHE_SEC, 600),
    jwksMinRefetchSec: num(env.AUTH_JWKS_MIN_REFETCH_SEC, 30),
    jwksTimeoutMs: num(env.AUTH_JWKS_TIMEOUT_MS, 5000),
    claims: {
      tenant: trim(env.AUTH_CLAIM_TENANT) || 'tenant_id',
      roles: list(env.AUTH_CLAIM_ROLES).length
        ? list(env.AUTH_CLAIM_ROLES)
        : ['roles', 'realm_access.roles', 'resource_access.tz-opti.roles', 'groups'],
      email: trim(env.AUTH_CLAIM_EMAIL) || 'email',
      name: trim(env.AUTH_CLAIM_NAME) || 'name',
    },
    roleMap: parseRoleMap(env.AUTH_ROLE_MAP),
    defaultRoles: list(env.AUTH_DEFAULT_ROLES).map((r) => r.toLowerCase()),
    // Dev-bypass: работает ТОЛЬКО вне production. В production сам факт
    // AUTH_DEV_BYPASS=1 — ошибка старта (см. assertProductionSecurity).
    devBypass: {
      requested: devBypassRequested,
      enabled: devBypassRequested && mode !== 'production',
      subject: trim(env.AUTH_DEV_SUBJECT) || 'dev-user',
      tenantId: trim(env.AUTH_DEV_TENANT) || trim(env.SECURITY_DEFAULT_TENANT) || 'default',
      roles: list(env.AUTH_DEV_ROLES).map((r) => r.toLowerCase()),
      email: trim(env.AUTH_DEV_EMAIL) || 'dev@localhost',
    },
  };
}

function buildConfig(env = process.env) {
  const mode = resolveMode(env);
  const auth = buildAuthConfig(env, mode);
  const avMode = (trim(env.AV_SCAN_MODE) || 'disabled').toLowerCase();

  return Object.freeze({
    mode,
    isProduction: mode === 'production',
    isDevelopment: mode === 'development',
    isTest: mode === 'test',
    auth: Object.freeze(auth),
    defaultTenantId: trim(env.SECURITY_DEFAULT_TENANT) || 'default',
    // Пустой allowlist в production = ошибка старта; в dev — фолбэк на Vite.
    cors: Object.freeze({
      allowedOrigins: list(env.CORS_ALLOWED_ORIGINS),
      allowCredentials: bool(env.CORS_ALLOW_CREDENTIALS, false),
      maxAgeSec: num(env.CORS_MAX_AGE_SEC, 600),
      devFallbackOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    }),
    rateLimit: Object.freeze({
      enabled: bool(env.RATE_LIMIT_ENABLED, true),
      windowSec: num(env.RATE_LIMIT_WINDOW_SEC, 60),
      max: num(env.RATE_LIMIT_MAX, 300),
      authFailMax: num(env.RATE_LIMIT_AUTH_FAIL_MAX, 20),
      uploadMax: num(env.RATE_LIMIT_UPLOAD_MAX, 20),
      analysisMax: num(env.RATE_LIMIT_ANALYSIS_MAX, 30),
      exportMax: num(env.RATE_LIMIT_EXPORT_MAX, 60),
      trustProxyHops: num(env.RATE_LIMIT_TRUST_PROXY_HOPS, 0),
    }),
    headers: Object.freeze({
      hstsMaxAgeSec: num(env.SECURITY_HSTS_MAX_AGE_SEC, 15552000),
      hstsEnabled: bool(env.SECURITY_HSTS_ENABLED, true),
    }),
    audit: Object.freeze({
      enabled: bool(env.AUDIT_ENABLED, true),
      logReads: bool(env.AUDIT_LOG_READS, true),
      retentionDays: num(env.AUDIT_RETENTION_DAYS, 365),
    }),
    uploads: Object.freeze({
      maxMb: num(env.MAX_UPLOAD_MB, 50),
      allowedExtensions: list(env.UPLOAD_ALLOWED_EXTENSIONS).map((e) => e.toLowerCase()),
      av: Object.freeze({
        mode: avMode, // 'clamd' | 'command' | 'http' | 'disabled'
        host: trim(env.AV_CLAMD_HOST) || '127.0.0.1',
        port: num(env.AV_CLAMD_PORT, 3310),
        command: trim(env.AV_COMMAND), // путь к сканеру как есть (пробелы допустимы)
        commandArgs: list(env.AV_COMMAND_ARGS), // доп. аргументы через запятую
        url: trim(env.AV_HTTP_URL),
        timeoutMs: num(env.AV_TIMEOUT_MS, 30000),
        maxMb: num(env.AV_MAX_MB, num(env.MAX_UPLOAD_MB, 50)),
      }),
    }),
    db: Object.freeze({
      // Строгая проверка TLS: в production включена всегда и выключить её
      // переменной нельзя (см. db/connectionTarget.js).
      caCertFile: trim(env.PGSSLROOTCERT) || trim(env.DATABASE_CA_CERT_FILE),
      caCert: trim(env.DATABASE_CA_CERT),
      allowInsecureTls: bool(env.DATABASE_ALLOW_INSECURE_TLS, false),
    }),
    errors: Object.freeze({
      // В production наружу уходит только сообщение доменных (4xx) ошибок;
      // 5xx схлопываются в generic + request_id.
      exposeInternals: bool(env.ERRORS_EXPOSE_INTERNALS, mode !== 'production'),
    }),
  });
}

// Проверки, которые обязаны падать на СТАРТЕ процесса, а не на первом запросе.
// Возвращает список проблем (пустой = всё в порядке). Отдельно от бросающей
// обёртки — чтобы тест мог посмотреть на весь список сразу.
function productionSecurityProblems(config) {
  const problems = [];
  if (!config.isProduction) return problems;

  const { auth } = config;
  if (auth.mode === 'disabled') {
    problems.push('AUTH: не настроен ни один источник проверки токена (AUTH_OIDC_ISSUER / AUTH_JWKS_URI / AUTH_JWT_PUBLIC_KEY / AUTH_JWT_HS_SECRET).');
  }
  if (auth.devBypass.requested) {
    problems.push('AUTH_DEV_BYPASS=1 в production запрещён: обход аутентификации допустим только в development.');
  }
  if (auth.mode === 'oidc' && !auth.issuer) {
    problems.push('AUTH_MODE=oidc, но AUTH_OIDC_ISSUER не задан.');
  }
  if (auth.mode === 'jwks' && !auth.jwksUri) {
    problems.push('AUTH_MODE=jwks, но AUTH_JWKS_URI не задан.');
  }
  if (auth.mode === 'public_key' && !auth.publicKey && !auth.publicKeyFile) {
    problems.push('AUTH_MODE=public_key, но ключ не задан (AUTH_JWT_PUBLIC_KEY / AUTH_JWT_PUBLIC_KEY_FILE).');
  }
  if (auth.mode === 'secret' && auth.hsSecret.length < 32) {
    problems.push('AUTH_JWT_HS_SECRET короче 32 символов — недостаточная энтропия для HMAC.');
  }
  if (auth.mode !== 'secret' && auth.algorithms.some((a) => SYMMETRIC_ALGORITHMS.includes(a))) {
    problems.push('AUTH_JWT_ALGORITHMS содержит симметричный алгоритм (HS*) при асимметричном режиме — риск alg-confusion.');
  }
  const unknown = auth.algorithms.filter((a) => !KNOWN_ALGORITHMS.includes(a));
  if (unknown.length) {
    problems.push(`AUTH_JWT_ALGORITHMS: неизвестные алгоритмы ${unknown.join(', ')}.`);
  }
  if (!auth.audience.length) {
    problems.push('AUTH_JWT_AUDIENCE не задан: токен, выписанный для другого сервиса того же провайдера, был бы принят.');
  }
  if (!config.cors.allowedOrigins.length) {
    problems.push('CORS_ALLOWED_ORIGINS пуст: в production список разрешённых источников обязателен.');
  }
  if (config.cors.allowedOrigins.includes('*')) {
    problems.push('CORS_ALLOWED_ORIGINS содержит "*": подстановка запрещена в production.');
  }
  if (config.uploads.av.mode === 'disabled') {
    problems.push('AV_SCAN_MODE=disabled: антивирусная проверка загрузок обязательна в production.');
  }
  if (config.uploads.av.mode === 'command' && !config.uploads.av.command) {
    problems.push('AV_SCAN_MODE=command, но AV_COMMAND не задан.');
  }
  if (config.uploads.av.mode === 'http' && !config.uploads.av.url) {
    problems.push('AV_SCAN_MODE=http, но AV_HTTP_URL не задан.');
  }
  if (!['clamd', 'command', 'http'].includes(config.uploads.av.mode)) {
    problems.push(`AV_SCAN_MODE=${config.uploads.av.mode}: допустимы clamd | command | http.`);
  }
  if (config.db.allowInsecureTls) {
    problems.push('DATABASE_ALLOW_INSECURE_TLS=1 в production запрещён: проверка сертификата Postgres обязательна.');
  }
  if (config.errors.exposeInternals) {
    problems.push('ERRORS_EXPOSE_INTERNALS=1 в production запрещён: внутренние детали ошибок наружу не отдаются.');
  }
  if (!config.rateLimit.enabled) {
    problems.push('RATE_LIMIT_ENABLED=0 в production запрещён.');
  }
  if (!config.audit.enabled) {
    problems.push('AUDIT_ENABLED=0 в production запрещён: журнал действий обязателен.');
  }
  return problems;
}

function assertProductionSecurity(config = buildConfig()) {
  const problems = productionSecurityProblems(config);
  if (!problems.length) return config;
  throw new SecurityConfigError(
    'INSECURE_PRODUCTION_CONFIG',
    `Небезопасная конфигурация production (${problems.length}):\n  - ${problems.join('\n  - ')}\nСм. docs/security.md и .env.example.`,
  );
}

// Конфигурация процесса. Ленивая и сбрасываемая: тесты меняют process.env и
// вызывают reset(), production читает один раз на старте.
let cached = null;
function getSecurityConfig(env) {
  if (env) return buildConfig(env);
  if (!cached) cached = buildConfig(process.env);
  return cached;
}
function resetSecurityConfig() {
  cached = null;
}

module.exports = {
  buildConfig,
  getSecurityConfig,
  resetSecurityConfig,
  assertProductionSecurity,
  productionSecurityProblems,
  resolveMode,
  SecurityConfigError,
  DEFAULT_ALGORITHMS,
  SYMMETRIC_ALGORITHMS,
  KNOWN_ALGORITHMS,
};
