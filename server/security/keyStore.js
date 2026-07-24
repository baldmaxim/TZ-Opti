'use strict';

// Источник ключей проверки подписи — единственное место, которое знает о
// конкретном провайдере (и то только через стандарты OIDC/JWKS).
//
// Поддерживаются четыре режима (security/config.js → auth.mode):
//   oidc       — OIDC discovery: <issuer>/.well-known/openid-configuration → jwks_uri;
//   jwks       — прямой URL JWKS (провайдер без discovery);
//   public_key — статический ключ: PEM, одиночный JWK или JWKS-документ;
//   secret     — общий секрет (HS*), для простых развёртываний без IdP.
//
// Кэш JWKS: ключи держатся jwksCacheSec; неизвестный kid вызывает досрочный
// перезапрос НЕ ЧАЩЕ jwksMinRefetchSec — иначе поток токенов с выдуманными kid
// превращается в усилитель запросов к провайдеру (DoS на IdP).

const crypto = require('crypto');
const fs = require('fs');

const { JwtError } = require('./jwt');

const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';

function normalizeIssuer(issuer) {
  return String(issuer || '').replace(/\/$/, '');
}

function assertHttps(url, what, { allowHttp }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new JwtError('CONFIG', `${what}: некорректный URL`);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && allowHttp) return parsed;
  throw new JwtError('CONFIG', `${what}: требуется https (http допустим только вне production)`);
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error', // редирект на чужой хост за ключами — недопустим
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new JwtError('JWKS_FETCH_FAILED', `${url} → HTTP ${res.status}`);
  return res.json();
}

// JWK → KeyObject. Отбрасываем всё, что не годится для проверки подписи:
// шифровальные ключи (use=enc), симметричные kty=oct (публичный JWKS с oct —
// либо ошибка провайдера, либо попытка навязать alg-confusion).
function jwkToKey(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.use && jwk.use !== 'sig') return null;
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return null;
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC' && jwk.kty !== 'OKP') return null;
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return null;
  }
}

function parseStaticKeyMaterial(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('{')) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new JwtError('CONFIG', 'AUTH_JWT_PUBLIC_KEY: не PEM и не JSON');
    }
    const jwks = Array.isArray(doc.keys) ? doc.keys : [doc];
    return jwks
      .map((jwk) => ({ kid: jwk.kid, alg: jwk.alg, key: jwkToKey(jwk) }))
      .filter((k) => k.key);
  }
  // PEM (SPKI/PKCS1) либо сертификат.
  try {
    return [{ kid: undefined, alg: undefined, key: crypto.createPublicKey(text) }];
  } catch (err) {
    throw new JwtError('CONFIG', `AUTH_JWT_PUBLIC_KEY: ключ не разобран (${err.message})`);
  }
}

// now() вынесен в опции — тесты проверяют TTL кэша без ожидания реального времени.
function createKeyStore(authConfig, { now = () => Date.now(), fetchImpl = fetchJson, allowHttp = false } = {}) {
  const mode = authConfig.mode;
  const cacheMs = Math.max(0, authConfig.jwksCacheSec) * 1000;
  const minRefetchMs = Math.max(0, authConfig.jwksMinRefetchSec) * 1000;
  const timeoutMs = authConfig.jwksTimeoutMs;

  let staticKeys = null; // [{kid, alg, key}]
  let jwksUri = authConfig.jwksUri || '';
  let jwksKeys = null; // Map<kid|'', KeyObject[]>
  let jwksFetchedAt = 0;
  let lastFetchAttempt = 0;
  let inflight = null;

  function loadStaticKeys() {
    if (staticKeys) return staticKeys;
    if (mode === 'secret') {
      if (!authConfig.hsSecret) throw new JwtError('CONFIG', 'AUTH_JWT_HS_SECRET не задан');
      staticKeys = [{ kid: undefined, alg: undefined, key: Buffer.from(authConfig.hsSecret, 'utf8') }];
      return staticKeys;
    }
    const material = authConfig.publicKey || (authConfig.publicKeyFile ? fs.readFileSync(authConfig.publicKeyFile, 'utf8') : '');
    staticKeys = parseStaticKeyMaterial(material);
    if (!staticKeys.length) throw new JwtError('CONFIG', 'статический ключ проверки подписи не задан');
    return staticKeys;
  }

  async function resolveJwksUri() {
    if (jwksUri) return jwksUri;
    const issuer = normalizeIssuer(authConfig.issuer);
    if (!issuer) throw new JwtError('CONFIG', 'AUTH_OIDC_ISSUER не задан');
    const discoveryUrl = `${assertHttps(issuer, 'AUTH_OIDC_ISSUER', { allowHttp }).href.replace(/\/$/, '')}${DISCOVERY_SUFFIX}`;
    const doc = await fetchImpl(discoveryUrl, timeoutMs);
    if (!doc || typeof doc.jwks_uri !== 'string') {
      throw new JwtError('JWKS_FETCH_FAILED', 'discovery-документ без jwks_uri');
    }
    if (typeof doc.issuer === 'string' && normalizeIssuer(doc.issuer) !== issuer) {
      throw new JwtError('CONFIG', 'issuer в discovery-документе не совпадает с настроенным');
    }
    const parsed = assertHttps(doc.jwks_uri, 'jwks_uri', { allowHttp });
    if (parsed.host !== new URL(issuer).host) {
      throw new JwtError('CONFIG', 'jwks_uri указывает на другой хост, чем issuer');
    }
    jwksUri = parsed.href;
    return jwksUri;
  }

  async function fetchJwks() {
    const uri = await resolveJwksUri();
    const doc = await fetchImpl(assertHttps(uri, 'AUTH_JWKS_URI', { allowHttp }).href, timeoutMs);
    const keys = Array.isArray(doc && doc.keys) ? doc.keys : [];
    const map = new Map();
    for (const jwk of keys) {
      const key = jwkToKey(jwk);
      if (!key) continue;
      const bucket = jwk.kid ? String(jwk.kid) : '';
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket).push(key);
      if (bucket) {
        // Ключи без kid в токене должны находиться перебором — держим общий список.
        if (!map.has('')) map.set('', []);
        map.get('').push(key);
      }
    }
    if (!map.size) throw new JwtError('JWKS_EMPTY', 'JWKS не содержит пригодных ключей');
    jwksKeys = map;
    jwksFetchedAt = now();
    return map;
  }

  // Одновременные запросы делят один поход в сеть (иначе всплеск трафика после
  // истечения кэша умножается на число параллельных запросов).
  function fetchJwksOnce() {
    if (inflight) return inflight;
    lastFetchAttempt = now();
    inflight = fetchJwks().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function getJwksKeys({ force = false } = {}) {
    const fresh = jwksKeys && now() - jwksFetchedAt < cacheMs;
    if (fresh && !force) return jwksKeys;
    if (force && jwksKeys && now() - lastFetchAttempt < minRefetchMs) return jwksKeys;
    try {
      return await fetchJwksOnce();
    } catch (err) {
      // Провайдер недоступен, но кэш есть — работаем на кэше: короткий сбой сети
      // у IdP не должен мгновенно останавливать весь портал.
      if (jwksKeys) return jwksKeys;
      throw err;
    }
  }

  async function resolveKeys(header) {
    if (mode === 'secret' || mode === 'public_key') {
      const kid = header && header.kid ? String(header.kid) : '';
      const keys = loadStaticKeys();
      const matching = kid ? keys.filter((k) => !k.kid || k.kid === kid) : keys;
      return (matching.length ? matching : keys).map((k) => k.key);
    }
    if (mode !== 'oidc' && mode !== 'jwks') {
      throw new JwtError('CONFIG', `режим аутентификации ${mode} не поддерживается`);
    }
    const kid = header && header.kid ? String(header.kid) : '';
    let map = await getJwksKeys();
    let keys = map.get(kid) || (kid ? [] : map.get('') || []);
    if (!keys.length) {
      // Неизвестный kid — возможно, провайдер провернул ротацию. Один
      // перезапрос, не чаще jwksMinRefetchSec.
      map = await getJwksKeys({ force: true });
      keys = map.get(kid) || (kid ? [] : map.get('') || []);
    }
    return keys;
  }

  return {
    mode,
    resolveKeys,
    // Для диагностики/тестов — без выдачи самих ключей наружу.
    stats: () => ({ mode, jwksUri, cachedKids: jwksKeys ? [...jwksKeys.keys()].filter(Boolean) : [], jwksFetchedAt }),
  };
}

module.exports = { createKeyStore, jwkToKey, parseStaticKeyMaterial, normalizeIssuer };
