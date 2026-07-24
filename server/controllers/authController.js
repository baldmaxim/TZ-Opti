'use strict';

// Кто я и что мне можно. Клиенту это нужно, чтобы не показывать кнопки,
// которых всё равно не разрешит сервер (роль решается на сервере, UI лишь
// отражает решение).

exports.me = async (req, res) => {
  const p = req.principal;
  res.json({
    subject: p.subject,
    tenant_id: p.tenantId,
    email: p.email,
    name: p.name,
    roles: p.roles,
    permissions: p.permissions,
    auth_method: p.authMethod,
    expires_at: p.expiresAt,
  });
};
