'use strict';

// Приём файла целиком, через HTTP: карантин → проверки → папка тендера.
// UPLOAD_DIR подменяется ДО загрузки модулей — иначе тест писал бы в рабочий
// каталог server/uploads.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeTmpDir } = require('../../helpers/tmpDir');

const UPLOAD_DIR = makeTmpDir();
process.env.UPLOAD_DIR = UPLOAD_DIR;

const { generateRsa, signToken, claims, stubDb, withApp } = require('../../helpers/securityFixtures');

const { publicKey, privateKey } = generateRsa();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const token = (o = {}) => signToken({ payload: claims({ roles: ['engineer'], ...o }), key: privateKey, alg: 'RS256' });

const FIXTURES = { tenders: { 'tender-A': 'tenant-a', 'tender-B': 'tenant-b' } };
const app = (t, env = {}) => withApp(t, { publicKeyPem: PUBLIC_PEM, tenantFixtures: FIXTURES, env });

const tenderDir = () => path.join(UPLOAD_DIR, 'tenders', 'tender-A');
const quarantineDir = () => path.join(UPLOAD_DIR, 'quarantine');
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

async function upload(base, { name, content, type = 'application/octet-stream', docType = 'tz', tk }) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  form.append('doc_type', docType);
  const res = await fetch(`${base}/api/tenders/tender-A/documents`, {
    method: 'POST',
    headers: tk ? { authorization: `Bearer ${tk}` } : {},
    body: form,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, body };
}

test('корректный файл проходит: сохраняется хэш, файл переезжает из карантина', async (t) => {
  const { base } = await app(t);
  const calls = stubDb(t, ({ sql }) => {
    if (/SELECT id FROM tenders/.test(sql)) return { id: 'tender-A' };
    if (/SELECT id, tender_id, doc_type/.test(sql)) return { id: 'doc-1', tender_id: 'tender-A' };
    return undefined;
  });

  const res = await upload(base, { name: 'ТЗ.md', content: '# ТЗ на СМР\n', type: 'text/markdown', tk: token() });
  assert.equal(res.status, 201);

  const insert = calls.find((c) => /INSERT INTO documents/.test(c.sql));
  assert.ok(insert.sql.includes('sha256'), 'хэш обязан сохраняться');
  const sha = insert.params.find((p) => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p));
  assert.ok(sha, 'в параметрах вставки должен быть SHA-256');
  assert.ok(insert.params.includes('user-1'), 'кто загрузил — тоже фиксируется');

  assert.equal(listDir(tenderDir()).length, 1, 'файл должен лежать в папке тендера');
  assert.deepEqual(listDir(quarantineDir()), [], 'карантин должен остаться пустым');
});

test('исполняемый файл под видом .docx не принимается и не остаётся на диске', async (t) => {
  const { base } = await app(t);
  stubDb(t, ({ sql }) => (/SELECT id FROM tenders/.test(sql) ? { id: 'tender-A' } : undefined));
  const before = listDir(tenderDir()).length;

  const res = await upload(base, {
    name: 'ТЗ.docx',
    content: Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(512, 0x41)]),
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    tk: token(),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MAGIC_MISMATCH');
  assert.equal(listDir(tenderDir()).length, before, 'в папке тендера ничего не прибавилось');
  assert.deepEqual(listDir(quarantineDir()), [], 'файл удалён из карантина');
});

test('запрещённое расширение отсекается до записи на диск', async (t) => {
  const { base } = await app(t);
  stubDb(t, ({ sql }) => (/SELECT id FROM tenders/.test(sql) ? { id: 'tender-A' } : undefined));

  const res = await upload(base, { name: 'payload.exe', content: 'MZ', tk: token() });
  assert.equal(res.status, 415);
  assert.deepEqual(listDir(quarantineDir()), []);
});

test('заражённый файл: 422, файл уничтожен, событие в журнале аудита', async (t) => {
  const { base, audit } = await app(t, {
    AV_SCAN_MODE: 'command',
    AV_COMMAND: process.execPath,
    AV_COMMAND_ARGS: '-e,console.log("f: EICAR-Test-File FOUND"); process.exit(1)',
  });
  stubDb(t, ({ sql }) => (/SELECT id FROM tenders/.test(sql) ? { id: 'tender-A' } : undefined));
  const before = listDir(tenderDir()).length;

  const res = await upload(base, { name: 'ТЗ.md', content: '# ТЗ', type: 'text/markdown', tk: token() });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'AV_INFECTED');
  assert.equal(listDir(tenderDir()).length, before);
  assert.deepEqual(listDir(quarantineDir()), []);

  const entry = audit.entries.find((e) => e.action === 'document.upload');
  assert.equal(entry.outcome, 'error');
  assert.equal(entry.meta.rejected, 'AV_INFECTED');
  assert.equal(entry.meta.signature, 'EICAR-Test-File');
});

test('недоступный антивирус — отказ в приёме (fail-closed), а не тихая загрузка', async (t) => {
  const { base } = await app(t, {
    AV_SCAN_MODE: 'clamd',
    AV_CLAMD_HOST: '127.0.0.1',
    AV_CLAMD_PORT: '1',
    AV_TIMEOUT_MS: '1000',
  });
  stubDb(t, ({ sql }) => (/SELECT id FROM tenders/.test(sql) ? { id: 'tender-A' } : undefined));

  const res = await upload(base, { name: 'ТЗ.md', content: '# ТЗ', type: 'text/markdown', tk: token() });
  assert.equal(res.status, 503);
  assert.deepEqual(listDir(quarantineDir()), []);
});

test('файл сверх лимита не принимается', async (t) => {
  const { base } = await app(t, { MAX_UPLOAD_MB: '1' });
  stubDb(t, ({ sql }) => (/SELECT id FROM tenders/.test(sql) ? { id: 'tender-A' } : undefined));

  const res = await upload(base, { name: 'big.md', content: 'x'.repeat(2 * 1024 * 1024), type: 'text/markdown', tk: token() });
  assert.equal(res.status, 413);
  assert.deepEqual(listDir(quarantineDir()), []);
});

test('загрузка в чужой тендер запрещена до всякой записи файла', async (t) => {
  const { base } = await app(t);
  stubDb(t, () => undefined);
  const form = new FormData();
  form.append('file', new Blob(['# ТЗ'], { type: 'text/markdown' }), 'ТЗ.md');
  form.append('doc_type', 'tz');
  const res = await fetch(`${base}/api/tenders/tender-B/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}` },
    body: form,
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'CROSS_TENANT_DENIED');
  assert.deepEqual(listDir(quarantineDir()), [], 'чужой файл не должен попасть даже в карантин');
});

test('viewer не может загружать документы', async (t) => {
  const { base } = await app(t);
  stubDb(t, () => undefined);
  const res = await upload(base, { name: 'ТЗ.md', content: '# ТЗ', tk: token({ roles: ['viewer'] }) });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'INSUFFICIENT_ROLE');
});
