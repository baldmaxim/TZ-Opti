'use strict';

// Авторизация: право на действие (роль) + принадлежность ресурса тенанту.
//
// Порядок проверок неслучаен:
//   1. правило маршрута       — нет правила ⇒ 403 (default deny);
//   2. право роли             — 403 INSUFFICIENT_ROLE (ресурс не читается вовсе);
//   3. тенант ресурса из БД   — 403 CROSS_TENANT_DENIED.
// Сначала роль, потом тенант: пользователю без права видеть тендеры незачем
// узнавать даже факт существования конкретного тендера.

const { forbidden } = require('../utils/errors');
const { resolvePolicy, isPublicPath } = require('../security/policy');
const { can } = require('../security/roles');
const { assertSameTenant } = require('../security/tenantAccess');

function authorize({ tenantResolver }) {
  return async function authorizeMiddleware(req, res, next) {
    if (req.method === 'OPTIONS' || isPublicPath(req.path)) return next();

    const principal = req.principal;
    if (!principal) {
      // Сюда можно попасть только при ошибке монтирования middleware —
      // fail-closed, а не «пропустим, наверное, публичный».
      return next(forbidden('NO_PRINCIPAL', 'authorize вызван без principal'));
    }

    const policy = resolvePolicy(req.method, req.path);
    if (!policy) {
      return next(forbidden('POLICY_UNMATCHED', `нет правила доступа для ${req.method} ${req.path}`, 'Действие не разрешено'));
    }
    req.security = { ...(req.security || {}), policy };

    if (!can(principal.roles, policy.permission)) {
      return next(
        forbidden(
          'INSUFFICIENT_ROLE',
          `нужно право ${policy.permission}, роли: ${principal.roles.join(',')}`,
          'Недостаточно прав',
        ),
      );
    }

    if (policy.tenantVia === 'system' || policy.tenantVia === 'principal') {
      req.tenantId = principal.tenantId;
      req.security.resource = { type: policy.resourceType, id: null, tenantId: principal.tenantId, tenderId: null };
      return next();
    }

    const resource = await tenantResolver.resolve(policy.tenantVia, policy.params);
    if (!resource) return next(forbidden('TENANT_SCOPE_UNKNOWN', `неизвестный tenantVia=${policy.tenantVia}`));

    assertSameTenant(principal, resource); // бросает 404 (нет) либо 403 (чужой тенант)

    req.tenantId = resource.tenantId;
    req.tenderId = resource.tenderId;
    req.security.resource = {
      type: policy.resourceType,
      id: resource.resourceId || null,
      tenantId: resource.tenantId,
      tenderId: resource.tenderId,
    };
    return next();
  };
}

module.exports = { authorize };
