'use strict';

// Утверждения токена → principal (кто совершает действие). Чистый модуль:
// на вход — payload и конфигурация клеймов, на выход — нормализованный субъект.
//
// Провайдеро-независимость держится на двух вещах:
//   • имена клеймов настраиваются (AUTH_CLAIM_*), поддерживается вложенный путь
//     (`realm_access.roles` у Keycloak, `https://…/tenant` у Auth0);
//   • роли провайдера отображаются в роли TZ-Opti через AUTH_ROLE_MAP;
//     всё, что не отобразилось в известную роль, отбрасывается (не «на всякий
//     случай пропустим» — неизвестная роль прав не даёт).

const { isRole, permissionsFor } = require('./roles');

class PrincipalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrincipalError';
    this.code = code;
  }
}

// Клейм по пути 'a.b.c'. Точка в имени клейма (Auth0 отдаёт URL-подобные
// клеймы вида 'https://tz-opti/tenant') сначала пробуется как ЦЕЛОЕ имя.
function getClaim(payload, path) {
  if (!payload || !path) return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, path)) return payload[path];
  let cur = payload;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Клейм ролей бывает массивом, строкой через пробел/запятую или объектом
// { roles: [...] } — приводим к плоскому списку строк.
function claimToStrings(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(claimToStrings);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (typeof value === 'object') return claimToStrings(value.roles || value.groups || []);
  return [];
}

function mapRoles(rawRoles, roleMap, defaultRoles = []) {
  const out = new Set();
  for (const raw of rawRoles) {
    const value = String(raw).trim();
    if (!value) continue;
    const mapped = roleMap && roleMap.get ? roleMap.get(value) : undefined;
    const candidate = (mapped || value).toLowerCase();
    if (isRole(candidate)) out.add(candidate);
  }
  if (!out.size) {
    for (const r of defaultRoles) if (isRole(r)) out.add(String(r).toLowerCase());
  }
  return [...out];
}

function extractTenant(payload, claimPath) {
  const value = getClaim(payload, claimPath);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0].trim();
  if (Array.isArray(value) && value.length > 1) {
    // Мультитенантный токен без выбранного тенанта — отказ, а не «возьмём первый».
    throw new PrincipalError('TENANT_AMBIGUOUS', 'в токене несколько тенантов, ни один не выбран');
  }
  return '';
}

// authConfig — security/config.js → config.auth.
function buildPrincipal(payload, authConfig) {
  const claims = authConfig.claims;
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!subject) throw new PrincipalError('SUB_MISSING', 'в токене нет subject');

  const tenantId = extractTenant(payload, claims.tenant);
  if (!tenantId) {
    throw new PrincipalError('TENANT_CLAIM_MISSING', `в токене нет клейма тенанта (${claims.tenant})`);
  }

  const rawRoles = claims.roles.flatMap((path) => claimToStrings(getClaim(payload, path)));
  // Стандартный OAuth-scope тоже может нести роли: "scope": "tz:engineer".
  const scopes = claimToStrings(payload.scope || payload.scp);
  const roles = mapRoles([...rawRoles, ...scopes], authConfig.roleMap, authConfig.defaultRoles);
  if (!roles.length) {
    throw new PrincipalError('NO_ROLES', 'у субъекта нет ни одной известной роли TZ-Opti');
  }

  return Object.freeze({
    subject,
    tenantId,
    roles: Object.freeze(roles),
    permissions: Object.freeze([...permissionsFor(roles)]),
    email: typeof getClaim(payload, claims.email) === 'string' ? getClaim(payload, claims.email) : null,
    name: typeof getClaim(payload, claims.name) === 'string' ? getClaim(payload, claims.name) : null,
    issuer: typeof payload.iss === 'string' ? payload.iss : null,
    tokenId: typeof payload.jti === 'string' ? payload.jti : null,
    expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
    authMethod: 'token',
  });
}

// Principal для dev-bypass. Собирается из явных переменных окружения и никогда
// не создаётся в production (см. middleware/authenticate.js и security/config.js).
function devPrincipal(devConfig) {
  const roles = (devConfig.roles && devConfig.roles.length ? devConfig.roles : ['admin']).filter(isRole);
  return Object.freeze({
    subject: devConfig.subject,
    tenantId: devConfig.tenantId,
    roles: Object.freeze(roles.length ? roles : ['admin']),
    permissions: Object.freeze([...permissionsFor(roles.length ? roles : ['admin'])]),
    email: devConfig.email,
    name: 'Dev bypass',
    issuer: null,
    tokenId: null,
    expiresAt: null,
    authMethod: 'dev-bypass',
  });
}

module.exports = { buildPrincipal, devPrincipal, getClaim, claimToStrings, mapRoles, PrincipalError };
