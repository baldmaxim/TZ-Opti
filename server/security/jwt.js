'use strict';

// Проверка JWS-подписанного токена (JWT) средствами node:crypto — без внешних
// библиотек и без привязки к провайдеру. Всё, что зависит от развёртывания
// (откуда берётся ключ), вынесено в keyResolver; здесь — только формат,
// подпись и утверждения.
//
// Что здесь считается атакой и отбивается явно:
//   • alg: none и любой алгоритм вне allowlist;
//   • alg-confusion (HS-подпись, проверенная публичным RSA-ключом): семейство
//     алгоритма ОБЯЗАНО совпадать с типом ключа, симметрика проверяется только
//     секретом;
//   • подмена kid / отсутствие kid при нескольких ключах — решает keyResolver;
//   • чужой issuer / audience (токен другого сервиса того же провайдера);
//   • просроченный или ещё не активный токен (с настраиваемым перекосом часов);
//   • `crit`-заголовок с неизвестными обязательными расширениями.

const crypto = require('crypto');

class JwtError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

const B64URL = /^[A-Za-z0-9_-]*$/;

function b64urlToBuffer(part, what) {
  if (typeof part !== 'string' || !B64URL.test(part)) {
    throw new JwtError('TOKEN_MALFORMED', `${what}: не base64url`);
  }
  return Buffer.from(part, 'base64url');
}

function parseJson(buf, what) {
  let value;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new JwtError('TOKEN_MALFORMED', `${what}: не JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JwtError('TOKEN_MALFORMED', `${what}: не объект`);
  }
  return value;
}

// Разбор без какой-либо проверки подписи. Отдельная функция — чтобы можно было
// достать `kid`/`iss` ДО получения ключа (и чтобы нигде в коде не возникло
// соблазна использовать payload не проверенного токена: имя говорит само за себя).
function decodeUnverified(token) {
  if (typeof token !== 'string' || !token) throw new JwtError('TOKEN_MISSING', 'пустой токен');
  const parts = token.split('.');
  if (parts.length !== 3) {
    // 5 частей — это JWE (зашифрованный токен): его мы не поддерживаем сознательно.
    throw new JwtError('TOKEN_MALFORMED', parts.length === 5 ? 'JWE не поддерживается' : 'ожидался JWS из трёх частей');
  }
  const [h, p, s] = parts;
  const header = parseJson(b64urlToBuffer(h, 'header'), 'header');
  const payload = parseJson(b64urlToBuffer(p, 'payload'), 'payload');
  const signature = b64urlToBuffer(s, 'signature');
  return { header, payload, signature, signingInput: `${h}.${p}` };
}

const ALG_SPEC = {
  HS256: { family: 'hmac', hash: 'sha256' },
  HS384: { family: 'hmac', hash: 'sha384' },
  HS512: { family: 'hmac', hash: 'sha512' },
  RS256: { family: 'rsa', hash: 'sha256' },
  RS384: { family: 'rsa', hash: 'sha384' },
  RS512: { family: 'rsa', hash: 'sha512' },
  PS256: { family: 'rsa-pss', hash: 'sha256' },
  PS384: { family: 'rsa-pss', hash: 'sha384' },
  PS512: { family: 'rsa-pss', hash: 'sha512' },
  ES256: { family: 'ec', hash: 'sha256', curve: 'prime256v1' },
  ES384: { family: 'ec', hash: 'sha384', curve: 'secp384r1' },
  ES512: { family: 'ec', hash: 'sha512', curve: 'secp521r1' },
};

function verifySignature(alg, signingInput, signature, key) {
  const spec = ALG_SPEC[alg];
  if (!spec) throw new JwtError('ALG_UNSUPPORTED', `алгоритм ${alg} не поддерживается`);
  const data = Buffer.from(signingInput, 'ascii');

  if (spec.family === 'hmac') {
    // Симметрика: ключ обязан быть секретом, а не публичным ключом. Иначе это
    // alg-confusion — подпись HMAC'ом на публичном ключе, который знают все.
    const secret = Buffer.isBuffer(key) ? key : key && key.type === 'secret' ? key : null;
    if (!secret) throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует симметричный секрет`);
    const expected = crypto.createHmac(spec.hash, secret).update(data).digest();
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(expected, signature);
  }

  if (!key || typeof key !== 'object' || key.type !== 'public') {
    throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует асимметричный публичный ключ`);
  }
  const keyType = key.asymmetricKeyType;

  if (spec.family === 'rsa') {
    if (keyType !== 'rsa' && keyType !== 'rsa-pss') {
      throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует RSA-ключ, получен ${keyType}`);
    }
    return crypto.verify(spec.hash, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  }
  if (spec.family === 'rsa-pss') {
    if (keyType !== 'rsa' && keyType !== 'rsa-pss') {
      throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует RSA-ключ, получен ${keyType}`);
    }
    return crypto.verify(
      spec.hash,
      data,
      { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
      signature,
    );
  }
  if (spec.family === 'ec') {
    if (keyType !== 'ec') throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует EC-ключ, получен ${keyType}`);
    const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
    if (curve && curve !== spec.curve) {
      throw new JwtError('ALG_KEY_MISMATCH', `${alg} требует кривую ${spec.curve}, получена ${curve}`);
    }
    // JWS для ECDSA использует «сырое» r||s (P1363), а не DER.
    return crypto.verify(spec.hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  throw new JwtError('ALG_UNSUPPORTED', `алгоритм ${alg} не поддерживается`);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function checkClaims(payload, { issuer, audience = [], clockSkewSec = 60, now, requireExp = true, subjectRequired = true }) {
  const nowSec = Math.floor((now === undefined ? Date.now() : now) / 1000);

  if (issuer) {
    const iss = typeof payload.iss === 'string' ? payload.iss : '';
    // Сравнение точное (с точностью до финального слэша) — подстрока/префикс
    // допустили бы issuer вида "https://evil.example/https://good.example".
    if (iss.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
      throw new JwtError('ISS_MISMATCH', 'issuer токена не совпадает с настроенным');
    }
  }

  if (audience.length) {
    const aud = asArray(payload.aud).filter((a) => typeof a === 'string');
    if (!aud.some((a) => audience.includes(a))) {
      throw new JwtError('AUD_MISMATCH', 'audience токена не совпадает с настроенным');
    }
  }

  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number') throw new JwtError('TOKEN_MALFORMED', 'exp не число');
    if (nowSec >= payload.exp + clockSkewSec) throw new JwtError('TOKEN_EXPIRED', 'срок действия токена истёк');
  } else if (requireExp) {
    throw new JwtError('EXP_MISSING', 'токен без exp не принимается');
  }

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') throw new JwtError('TOKEN_MALFORMED', 'nbf не число');
    if (nowSec + clockSkewSec < payload.nbf) throw new JwtError('TOKEN_NOT_ACTIVE', 'токен ещё не активен');
  }

  if (payload.iat !== undefined) {
    if (typeof payload.iat !== 'number') throw new JwtError('TOKEN_MALFORMED', 'iat не число');
    // Токен «из будущего» — признак рассинхронизации или подделки.
    if (payload.iat > nowSec + Math.max(clockSkewSec, 60)) throw new JwtError('IAT_IN_FUTURE', 'iat в будущем');
  }

  if (subjectRequired && (typeof payload.sub !== 'string' || !payload.sub.trim())) {
    throw new JwtError('SUB_MISSING', 'в токене нет subject');
  }
}

// Полная проверка. keyResolver(header, payload) → KeyObject | Buffer | массив
// кандидатов (при ротации ключей провайдера подходящим может быть не первый).
async function verifyJwt(token, options = {}) {
  const {
    keyResolver,
    algorithms,
    issuer = '',
    audience = [],
    clockSkewSec = 60,
    now,
    requireExp = true,
  } = options;

  if (typeof keyResolver !== 'function') throw new JwtError('CONFIG', 'keyResolver обязателен');
  const allowed = Array.isArray(algorithms) && algorithms.length ? algorithms : null;
  if (!allowed) throw new JwtError('CONFIG', 'список разрешённых алгоритмов обязателен');

  const { header, payload, signature, signingInput } = decodeUnverified(token);

  const alg = typeof header.alg === 'string' ? header.alg.toUpperCase() : '';
  if (!alg || alg === 'NONE') throw new JwtError('ALG_NONE', 'alg=none запрещён');
  if (!allowed.includes(alg)) throw new JwtError('ALG_NOT_ALLOWED', `alg ${alg} не в списке разрешённых`);
  if (header.crit !== undefined) throw new JwtError('CRIT_UNSUPPORTED', 'заголовок crit не поддерживается');
  if (header.typ !== undefined) {
    const typ = String(header.typ).toLowerCase();
    if (typ !== 'jwt' && typ !== 'at+jwt' && typ !== 'application/at+jwt') {
      throw new JwtError('TYP_UNSUPPORTED', `typ ${header.typ} не поддерживается`);
    }
  }

  const keys = asArray(await keyResolver(header, payload));
  if (!keys.length) throw new JwtError('KEY_NOT_FOUND', 'ключ для проверки подписи не найден');

  let ok = false;
  let lastError = null;
  for (const key of keys) {
    try {
      if (verifySignature(alg, signingInput, signature, key)) {
        ok = true;
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!ok) {
    if (lastError) throw lastError;
    throw new JwtError('SIGNATURE_INVALID', 'подпись токена не прошла проверку');
  }

  // Утверждения проверяются ПОСЛЕ подписи: иначе по разным ошибкам можно было бы
  // изучать содержимое неподписанных токенов.
  checkClaims(payload, { issuer, audience, clockSkewSec, now, requireExp });

  return { header, payload };
}

module.exports = { verifyJwt, decodeUnverified, checkClaims, verifySignature, JwtError, ALG_SPEC };
