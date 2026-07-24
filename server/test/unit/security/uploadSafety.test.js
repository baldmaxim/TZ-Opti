'use strict';

// Приём файлов: список форматов, магические байты, SHA-256 и обязательный
// антивирус. Настоящие файлы во временном каталоге, без сети.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  inspectFile,
  checkSignature,
  detectKind,
  extensionOf,
  allowedExtensions,
  sha256File,
  DEFAULT_EXTENSIONS,
} = require('../../../services/uploads/fileSafety');
const { scanFile, AntivirusError } = require('../../../services/uploads/antivirus');
const { buildConfig } = require('../../../security/config');
const { makeTmpDir } = require('../../helpers/tmpDir');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PE_MAGIC = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ — windows-исполняемый

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const testConfig = (overrides = {}) => buildConfig({ NODE_ENV: 'test', ...overrides });

// --- список форматов ---------------------------------------------------------

test('разрешены только рабочие форматы портала', () => {
  assert.deepEqual([...DEFAULT_EXTENSIONS].sort(), ['.csv', '.doc', '.docx', '.md', '.pdf', '.txt', '.xls', '.xlsx']);
  assert.equal(extensionOf('ТЗ.DOCX'), '.docx');
  assert.equal(extensionOf('архив.tar.gz'), '.gz');
  assert.equal(extensionOf('без_расширения'), '');
});

test('список форматов можно сузить переменной, но не расширить', () => {
  assert.deepEqual(allowedExtensions(testConfig({ UPLOAD_ALLOWED_EXTENSIONS: 'docx,pdf' })), ['.docx', '.pdf']);
  assert.deepEqual(
    allowedExtensions(testConfig({ UPLOAD_ALLOWED_EXTENSIONS: 'exe,sh,docx' })),
    ['.docx'],
    'форматов без правила проверки содержимого в списке быть не может',
  );
});

// --- магические байты --------------------------------------------------------

test('сигнатура распознаётся по содержимому', () => {
  assert.equal(detectKind(Buffer.concat([ZIP_MAGIC, Buffer.alloc(10)])), 'zip/ooxml');
  assert.equal(detectKind(OLE_MAGIC), 'ole2');
  assert.equal(detectKind(Buffer.from('%PDF-1.7\n...')), 'pdf');
  assert.equal(detectKind(Buffer.from('# Заголовок ТЗ\n')), 'text');
  assert.equal(detectKind(PE_MAGIC), 'unknown');
  assert.equal(detectKind(Buffer.from([0x00, 0x01, 0x02])), 'unknown');
});

test('несовпадение содержимого и расширения отклоняется', () => {
  assert.equal(checkSignature('.docx', ZIP_MAGIC).ok, true);
  assert.equal(checkSignature('.xlsx', ZIP_MAGIC).ok, true);
  assert.equal(checkSignature('.doc', OLE_MAGIC).ok, true);
  assert.equal(checkSignature('.pdf', Buffer.from('%PDF-1.4')).ok, true);
  assert.equal(checkSignature('.md', Buffer.from('# ТЗ')).ok, true);

  const forged = checkSignature('.docx', PE_MAGIC);
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'MAGIC_MISMATCH');

  const exeAsMd = checkSignature('.md', PE_MAGIC);
  assert.equal(exeAsMd.ok, false);
  assert.equal(exeAsMd.code, 'CONTENT_NOT_TEXT');

  assert.equal(checkSignature('.exe', PE_MAGIC).code, 'EXT_NOT_ALLOWED');
});

test('исполняемый файл, переименованный в ТЗ.docx, не проходит', async (t) => {
  const dir = makeTmpDir(t);
  const evil = writeFile(dir, 'ТЗ.docx', Buffer.concat([PE_MAGIC, Buffer.alloc(2048, 0x41)]));
  const verdict = await inspectFile({ filePath: evil, originalName: 'ТЗ.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'MAGIC_MISMATCH');
});

test('двойное расширение не обманывает список форматов', async (t) => {
  const dir = makeTmpDir(t);
  const evil = writeFile(dir, 'смета.xlsx.exe', PE_MAGIC);
  const verdict = await inspectFile({ filePath: evil, originalName: 'смета.xlsx.exe' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'EXT_NOT_ALLOWED');
});

test('текстовый формат: бинарь и битый UTF-8 не проходят', async (t) => {
  const dir = makeTmpDir(t);
  const withNull = writeFile(dir, 'a.md', Buffer.from([0x23, 0x20, 0x00, 0x41]));
  assert.equal((await inspectFile({ filePath: withNull, originalName: 'a.md' })).code, 'CONTENT_NOT_TEXT');

  const brokenUtf8 = writeFile(dir, 'b.txt', Buffer.from([0xff, 0xfe, 0x41, 0x42]));
  assert.equal((await inspectFile({ filePath: brokenUtf8, originalName: 'b.txt' })).code, 'CONTENT_NOT_TEXT');

  const ok = writeFile(dir, 'c.md', '# ТЗ на СМР\n- пункт 1\n');
  assert.equal((await inspectFile({ filePath: ok, originalName: 'c.md' })).ok, true);
});

test('пустой файл и файл сверх лимита отклоняются', async (t) => {
  const dir = makeTmpDir(t);
  const empty = writeFile(dir, 'empty.pdf', Buffer.alloc(0));
  assert.equal((await inspectFile({ filePath: empty, originalName: 'empty.pdf' })).code, 'FILE_EMPTY');

  const big = writeFile(dir, 'big.pdf', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(5000)]));
  const verdict = await inspectFile({ filePath: big, originalName: 'big.pdf', maxBytes: 1024 });
  assert.equal(verdict.code, 'FILE_TOO_LARGE');
});

// --- SHA-256 -----------------------------------------------------------------

test('SHA-256 считается по содержимому и попадает в вердикт', async (t) => {
  const dir = makeTmpDir(t);
  const content = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('ТЗ на СМР')]);
  const file = writeFile(dir, 'tz.pdf', content);
  const expected = crypto.createHash('sha256').update(content).digest('hex');

  assert.equal(await sha256File(file), expected);
  const verdict = await inspectFile({ filePath: file, originalName: 'tz.pdf', mimeType: 'application/pdf' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sha256, expected);
  assert.equal(verdict.size, content.length);
});

test('расхождение заявленного Content-Type не отклоняет файл, но фиксируется', async (t) => {
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.pdf', Buffer.from('%PDF-1.7\nтело'));
  const verdict = await inspectFile({ filePath: file, originalName: 'tz.pdf', mimeType: 'text/html' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.mimeMismatch.declared, 'text/html');

  const octet = await inspectFile({ filePath: file, originalName: 'tz.pdf', mimeType: 'application/octet-stream' });
  assert.equal(octet.mimeMismatch, null, 'octet-stream — это «не знаю», а не расхождение');
});

// --- антивирус ---------------------------------------------------------------

test('антивирус обязателен: в production disabled — отказ, вне production — пропуск с пометкой', async (t) => {
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.md', '# ТЗ');

  const dev = await scanFile(file, testConfig({ AV_SCAN_MODE: 'disabled' }));
  assert.equal(dev.status, 'skipped');

  // Тестовый процесс не может стать production, поэтому конфигурацию режима
  // подменяем напрямую — проверяется именно ветка «production + disabled».
  const prodLike = { ...testConfig({ AV_SCAN_MODE: 'disabled' }), isProduction: true };
  await assert.rejects(() => scanFile(file, prodLike), (err) => err.code === 'AV_NOT_CONFIGURED');
});

test('сканер-команда: код 0 — чисто, код 1 — заражено', async (t) => {
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.md', '# ТЗ');

  // Путь к «сканеру» берётся как есть (в нём бывают пробелы), аргументы — списком.
  const clean = await scanFile(
    file,
    testConfig({ AV_SCAN_MODE: 'command', AV_COMMAND: process.execPath, AV_COMMAND_ARGS: '-e,process.exit(0)' }),
  );
  assert.equal(clean.status, 'clean');

  const infected = await scanFile(
    file,
    testConfig({
      AV_SCAN_MODE: 'command',
      AV_COMMAND: process.execPath,
      AV_COMMAND_ARGS: '-e,console.log("file: Eicar-Test-Signature FOUND"); process.exit(1)',
    }),
  );
  assert.equal(infected.status, 'infected');
  assert.equal(infected.signature, 'Eicar-Test-Signature');
});

test('сбой сканера — отказ в приёме файла, а не «пропустим»', async (t) => {
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.md', '# ТЗ');

  await assert.rejects(
    () =>
      scanFile(
        file,
        testConfig({ AV_SCAN_MODE: 'command', AV_COMMAND: process.execPath, AV_COMMAND_ARGS: '-e,process.exit(7)' }),
      ),
    (err) => err instanceof AntivirusError && err.code === 'AV_FAILED',
  );

  // Недоступный демон clamd — тоже отказ (fail-closed).
  await assert.rejects(
    () => scanFile(file, testConfig({ AV_SCAN_MODE: 'clamd', AV_CLAMD_HOST: '127.0.0.1', AV_CLAMD_PORT: '1', AV_TIMEOUT_MS: '1500' })),
    (err) => err instanceof AntivirusError,
  );

  await assert.rejects(
    () => scanFile(file, testConfig({ AV_SCAN_MODE: 'http' })),
    (err) => err.code === 'AV_NOT_CONFIGURED',
  );
});

test('файл больше лимита сканера не принимается молча', async (t) => {
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.md', Buffer.alloc(3 * 1024 * 1024, 0x41));
  await assert.rejects(
    () => scanFile(file, testConfig({ AV_SCAN_MODE: 'command', AV_COMMAND: 'true', AV_MAX_MB: '1' })),
    (err) => err.code === 'AV_FILE_TOO_LARGE',
  );
});

test('clamd: разбор ответов протокола INSTREAM', async (t) => {
  const net = require('node:net');
  const dir = makeTmpDir(t);
  const file = writeFile(dir, 'tz.md', '# ТЗ');

  // Мини-сервер, отвечающий как clamd: ждёт завершающий нулевой чанк INSTREAM
  // (4 нулевых байта) и только тогда отвечает.
  const serve = (reply) =>
    new Promise((resolve) => {
      const server = net.createServer((socket) => {
        let seen = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          seen = Buffer.concat([seen, chunk]).subarray(-4);
          if (seen.length === 4 && seen.equals(Buffer.alloc(4))) socket.end(reply);
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

  for (const [reply, expected] of [
    ['stream: OK\0', 'clean'],
    ['stream: Win.Test.EICAR_HDB-1 FOUND\0', 'infected'],
  ]) {
    const server = await serve(reply);
    t.after(() => new Promise((r) => server.close(r)));
    const result = await scanFile(
      file,
      testConfig({ AV_SCAN_MODE: 'clamd', AV_CLAMD_HOST: '127.0.0.1', AV_CLAMD_PORT: String(server.address().port), AV_TIMEOUT_MS: '3000' }),
    );
    assert.equal(result.status, expected);
    if (expected === 'infected') assert.equal(result.signature, 'Win.Test.EICAR_HDB-1');
  }
});
