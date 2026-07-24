'use strict';

// Проверка подписи и утверждений токена — на уровне самой функции verifyJwt.
// Ключи рождаются в тесте, сеть не нужна.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyJwt, decodeUnverified, JwtError } = require('../../../security/jwt');
const { parseStaticKeyMaterial, jwkToKey, createKeyStore } = require('../../../security/keyStore');
const { generateRsa, generateEc, signToken, claims } = require('../../helpers/securityFixtures');

const rsa = generateRsa();
const ec = generateEc();
const ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'];

const verify = (token, opts = {}) =>
  verifyJwt(token, {
    keyResolver: () => rsa.publicKey,
    algorithms: ALGS,
    issuer: 'https://idp.example.com/realms/tz',
    audience: ['tz-opti-api'],
    ...opts,
  });

test('валидный RS256 принимается', async () => {
  const token = signToken({ payload: claims(), key: rsa.privateKey, alg: 'RS256' });
  const { payload } = await verify(token);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.tenant_id, 'tenant-a');
});

test('PS256 и ES256 проверяются корректно', async () => {
  const ps = signToken({ payload: claims(), key: rsa.privateKey, alg: 'PS256' });
  await verify(ps);

  const es = signToken({ payload: claims(), key: ec.privateKey, alg: 'ES256' });
  const { payload } = await verify(es, { keyResolver: () => ec.publicKey });
  assert.equal(payload.sub, 'user-1');
});

test('ECDSA-подпись в формате DER (а не P1363) не принимается', async () => {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims())).toString('base64url');
  const der = crypto.sign('sha256', Buffer.from(`${head}.${body}`, 'ascii'), ec.privateKey); // DER по умолчанию
  const token = `${head}.${body}.${der.toString('base64url')}`;
  await assert.rejects(() => verify(token, { keyResolver: () => ec.publicKey }), (err) => err.code === 'SIGNATURE_INVALID');
});

test('alg=none отбивается до любой работы с ключом', async () => {
  const token = signToken({ payload: claims(), alg: 'none' });
  await assert.rejects(
    () =>
      verify(token, {
        keyResolver: () => {
          throw new Error('keyResolver не должен вызываться');
        },
      }),
    (err) => err.code === 'ALG_NONE',
  );
});

test('алгоритм вне allowlist не принимается', async () => {
  const token = signToken({ payload: claims(), alg: 'HS256', secret: 'shhh' });
  await assert.rejects(() => verify(token), (err) => err.code === 'ALG_NOT_ALLOWED');
});

test('alg confusion: HS256 с публичным ключом как секретом', async () => {
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const token = signToken({ payload: claims(), alg: 'HS256', secret: pem });
  // Даже если HS256 разрешён списком, ключ асимметричный — семейства не совпадают.
  await assert.rejects(
    () => verify(token, { algorithms: [...ALGS, 'HS256'] }),
    (err) => err.code === 'ALG_KEY_MISMATCH',
  );
});

test('подмена payload ломает подпись', async () => {
  const token = signToken({ payload: claims({ roles: ['viewer'] }), key: rsa.privateKey, alg: 'RS256' });
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify(claims({ roles: ['admin'] }))).toString('base64url');
  await assert.rejects(() => verify(`${h}.${forged}.${s}`), (err) => err.code === 'SIGNATURE_INVALID');
});

test('срок действия: exp обязателен, nbf и iat проверяются', async () => {
  const noExp = signToken({ payload: { ...claims(), exp: undefined }, key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(noExp), (err) => err.code === 'EXP_MISSING');

  const expired = signToken({ payload: claims({ ttlSec: -120 }), key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(expired), (err) => err.code === 'TOKEN_EXPIRED');

  // Перекос часов: токен, истёкший 30 секунд назад, при skew=60 ещё принимается.
  await verify(signToken({ payload: claims({ ttlSec: -30 }), key: rsa.privateKey, alg: 'RS256' }), { clockSkewSec: 60 });

  const future = signToken({ payload: { ...claims(), nbf: Math.floor(Date.now() / 1000) + 600 }, key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(future), (err) => err.code === 'TOKEN_NOT_ACTIVE');

  const iatFuture = signToken({ payload: { ...claims(), iat: Math.floor(Date.now() / 1000) + 3600 }, key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(iatFuture), (err) => err.code === 'IAT_IN_FUTURE');
});

test('issuer сверяется точно, а не по вхождению подстроки', async () => {
  const sneaky = signToken({
    payload: claims({ iss: 'https://evil.example/https://idp.example.com/realms/tz' }),
    key: rsa.privateKey,
    alg: 'RS256',
  });
  await assert.rejects(() => verify(sneaky), (err) => err.code === 'ISS_MISMATCH');

  // Финальный слэш различием не считается.
  await verify(signToken({ payload: claims({ iss: 'https://idp.example.com/realms/tz/' }), key: rsa.privateKey, alg: 'RS256' }));
});

test('audience: подходит любой из списка, массив в токене поддерживается', async () => {
  await verify(signToken({ payload: claims({ aud: ['other', 'tz-opti-api'] }), key: rsa.privateKey, alg: 'RS256' }));
  await assert.rejects(
    () => verify(signToken({ payload: claims({ aud: ['other'] }), key: rsa.privateKey, alg: 'RS256' })),
    (err) => err.code === 'AUD_MISMATCH',
  );
});

test('sub обязателен', async () => {
  const token = signToken({ payload: { ...claims(), sub: '   ' }, key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(token), (err) => err.code === 'SUB_MISSING');
});

test('некорректный формат: не три части, не base64url, не JSON, JWE', async () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', '###.###.###']) {
    await assert.rejects(() => verify(bad), (err) => err instanceof JwtError);
  }
  await assert.rejects(() => verify('a.b.c.d.e'), (err) => /JWE/.test(err.message));
  assert.throws(() => decodeUnverified('x'), (err) => err.code === 'TOKEN_MALFORMED');
});

test('crit-заголовок с неизвестным расширением не принимается', async () => {
  const token = signToken({ header: { crit: ['exp'] }, payload: claims(), key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(token), (err) => err.code === 'CRIT_UNSUPPORTED');
});

test('утверждения проверяются ПОСЛЕ подписи (чужой токен не «протекает» через ошибки)', async () => {
  const other = generateRsa();
  const token = signToken({ payload: claims({ iss: 'https://evil.example', ttlSec: -999 }), key: other.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(token), (err) => err.code === 'SIGNATURE_INVALID');
});

test('несколько кандидатов ключей: подходит любой (ротация ключей провайдера)', async () => {
  const other = generateRsa();
  const token = signToken({ payload: claims(), key: rsa.privateKey, alg: 'RS256' });
  await verify(token, { keyResolver: () => [other.publicKey, rsa.publicKey] });
});

test('нет ключа — отказ, а не пропуск', async () => {
  const token = signToken({ payload: claims(), key: rsa.privateKey, alg: 'RS256' });
  await assert.rejects(() => verify(token, { keyResolver: () => [] }), (err) => err.code === 'KEY_NOT_FOUND');
});

// --- источник ключей ---------------------------------------------------------

test('статический ключ разбирается из PEM, JWK и JWKS', () => {
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(parseStaticKeyMaterial(pem).length, 1);

  const jwk = rsa.publicKey.export({ format: 'jwk' });
  assert.equal(parseStaticKeyMaterial(JSON.stringify({ ...jwk, kid: 'k1' })).length, 1);
  assert.equal(parseStaticKeyMaterial(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }, { ...jwk, kid: 'k2' }] })).length, 2);
});

test('JWKS: ключи для шифрования и симметричные ключи отбрасываются', () => {
  const jwk = rsa.publicKey.export({ format: 'jwk' });
  assert.equal(jwkToKey({ ...jwk, use: 'enc' }), null, 'use=enc не для подписи');
  assert.equal(jwkToKey({ kty: 'oct', k: 'AAAA' }), null, 'симметричный ключ в JWKS не принимается');
  assert.equal(jwkToKey({ ...jwk, key_ops: ['encrypt'] }), null);
  assert.ok(jwkToKey(jwk), 'обычный ключ подписи принимается');
});

test('OIDC discovery: jwks_uri берётся из документа, чужой хост отвергается', async () => {
  const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return { issuer: 'https://idp.example.com/realms/tz', jwks_uri: 'https://idp.example.com/realms/tz/protocol/openid-connect/certs' };
    }
    return { keys: [jwk] };
  };
  const store = createKeyStore(
    { mode: 'oidc', issuer: 'https://idp.example.com/realms/tz', jwksCacheSec: 600, jwksMinRefetchSec: 30, jwksTimeoutMs: 1000 },
    { fetchImpl },
  );
  const keys = await store.resolveKeys({ kid: 'k1' });
  assert.equal(keys.length, 1);
  assert.equal(requests.length, 2, 'discovery + jwks');

  // Второй вызов — из кэша, без сети.
  await store.resolveKeys({ kid: 'k1' });
  assert.equal(requests.length, 2, 'кэш JWKS должен работать');

  const evil = createKeyStore(
    { mode: 'oidc', issuer: 'https://idp.example.com/realms/tz', jwksCacheSec: 600, jwksMinRefetchSec: 30, jwksTimeoutMs: 1000 },
    { fetchImpl: async () => ({ issuer: 'https://idp.example.com/realms/tz', jwks_uri: 'https://attacker.example/keys' }) },
  );
  await assert.rejects(() => evil.resolveKeys({ kid: 'k1' }), (err) => /другой хост/.test(err.message));
});

test('поток токенов с выдуманным kid не превращается в поток запросов к провайдеру', async () => {
  const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1' };
  let fetches = 0;
  let clock = 1_000_000;
  const store = createKeyStore(
    { mode: 'jwks', jwksUri: 'https://idp.example.com/keys', jwksCacheSec: 600, jwksMinRefetchSec: 30, jwksTimeoutMs: 1000 },
    {
      now: () => clock,
      fetchImpl: async () => {
        fetches += 1;
        return { keys: [jwk] };
      },
    },
  );

  await store.resolveKeys({ kid: 'k1' });
  assert.equal(fetches, 1);

  // Пока не вышла пауза, неизвестный kid новых запросов не порождает.
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(await store.resolveKeys({ kid: `fake-${i}` }), []);
  }
  assert.equal(fetches, 1, 'в паузе перезапросов быть не должно');

  // После паузы — ровно один перезапрос (провайдер мог провернуть ротацию).
  clock += 31_000;
  await store.resolveKeys({ kid: 'fake-again' });
  assert.equal(fetches, 2);
  await store.resolveKeys({ kid: 'fake-again' });
  assert.equal(fetches, 2, 'следующий перезапрос — только после новой паузы');
});

test('http-адрес JWKS запрещён, когда http не разрешён явно', async () => {
  const store = createKeyStore(
    { mode: 'jwks', jwksUri: 'http://idp.example.com/keys', jwksCacheSec: 600, jwksMinRefetchSec: 30, jwksTimeoutMs: 1000 },
    { fetchImpl: async () => ({ keys: [] }), allowHttp: false },
  );
  await assert.rejects(() => store.resolveKeys({ kid: 'k1' }), (err) => /https/.test(err.message));
});
