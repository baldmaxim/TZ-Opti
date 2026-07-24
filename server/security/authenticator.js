'use strict';

// Аутентификатор: строка Authorization → principal. Собирает вместе
// конфигурацию (security/config.js), источник ключей (keyStore.js), проверку
// подписи (jwt.js) и разбор утверждений (principal.js).
//
// Наружу отдаёт ОДНУ функцию authenticate(token) — благодаря этому в тестах и в
// dev-режиме её можно подменить целиком (createApp({ security: { authenticate } })),
// не трогая ни один маршрут.

const { getSecurityConfig } = require('./config');
const { createKeyStore } = require('./keyStore');
const { verifyJwt, JwtError } = require('./jwt');
const { buildPrincipal, devPrincipal, PrincipalError } = require('./principal');

class AuthFailure extends Error {
  constructor(code, reason, status = 401) {
    super(reason || code);
    this.name = 'AuthFailure';
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

function createAuthenticator(config = getSecurityConfig(), deps = {}) {
  const auth = config.auth;
  const keyStore =
    deps.keyStore ||
    createKeyStore(auth, {
      // http для discovery/JWKS допустим только вне production (локальный Keycloak).
      allowHttp: !config.isProduction,
      ...(deps.keyStoreOptions || {}),
    });

  async function authenticateToken(token, { now } = {}) {
    if (auth.mode === 'disabled') {
      throw new AuthFailure('AUTH_NOT_CONFIGURED', 'проверка токенов не настроена');
    }
    let payload;
    try {
      ({ payload } = await verifyJwt(token, {
        keyResolver: (header) => keyStore.resolveKeys(header),
        algorithms: auth.algorithms,
        issuer: auth.issuer,
        audience: auth.audience,
        clockSkewSec: auth.clockSkewSec,
        now,
      }));
    } catch (err) {
      if (err instanceof JwtError) throw new AuthFailure(err.code, err.message);
      // Сеть/JWKS недоступны — это не «плохой токен», а сбой сервиса.
      throw new AuthFailure('AUTH_BACKEND_UNAVAILABLE', err.message, 503);
    }
    try {
      return buildPrincipal(payload, auth);
    } catch (err) {
      if (err instanceof PrincipalError) {
        // Токен подлинный, но субъект не пригоден для работы в системе
        // (нет тенанта / нет ролей) — это 403, а не 401: повторная
        // аутентификация ничего не изменит.
        throw new AuthFailure(err.code, err.message, 403);
      }
      throw err;
    }
  }

  return {
    mode: auth.mode,
    authenticateToken,
    devBypassEnabled: auth.devBypass.enabled,
    devPrincipal: () => devPrincipal(auth.devBypass),
    keyStore,
  };
}

module.exports = { createAuthenticator, AuthFailure };
