'use strict';

// Проверка загружаемого файла ДО того, как он попадёт в рабочую папку тендера.
//
// Три независимых сита (файл обязан пройти все):
//   1. РАСШИРЕНИЕ — закрытый список форматов, с которыми работает портал;
//   2. СОДЕРЖИМОЕ — сигнатура («магические байты») обязана соответствовать
//      расширению: `virus.exe`, переименованный в `тз.docx`, не пройдёт,
//      потому что смотрят не на имя и не на заголовок Content-Type (их пишет
//      клиент), а на первые байты файла;
//   3. РАЗМЕР — пустой файл и файл сверх лимита отбрасываются.
//
// SHA-256 считается потоком (файлы бывают в сотни мегабайт) и сохраняется в
// documents.sha256: по нему видно, что за файл лежит на диске, и повторная
// загрузка того же ТЗ узнаётся без сравнения содержимого.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// kind → как проверять содержимое.
const ZIP = { magic: [Buffer.from([0x50, 0x4b, 0x03, 0x04])], label: 'zip/ooxml' };
const OLE = { magic: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], label: 'ole2' };
const PDF = { magic: [Buffer.from('%PDF-', 'ascii')], label: 'pdf' };
const TEXT = { magic: null, label: 'text' }; // проверяется эвристикой, см. looksLikeText

const FORMATS = Object.freeze({
  '.docx': { kind: ZIP, mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  '.xlsx': { kind: ZIP, mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  '.doc': { kind: OLE, mimes: ['application/msword'] },
  '.xls': { kind: OLE, mimes: ['application/vnd.ms-excel'] },
  '.pdf': { kind: PDF, mimes: ['application/pdf'] },
  '.md': { kind: TEXT, mimes: ['text/markdown', 'text/x-markdown', 'text/plain'] },
  '.txt': { kind: TEXT, mimes: ['text/plain'] },
  '.csv': { kind: TEXT, mimes: ['text/csv', 'text/plain', 'application/csv'] },
});

const DEFAULT_EXTENSIONS = Object.freeze(Object.keys(FORMATS));

function allowedExtensions(config) {
  const configured = config && config.uploads && config.uploads.allowedExtensions;
  if (!configured || !configured.length) return DEFAULT_EXTENSIONS;
  // Из .env можно только СУЗИТЬ список: расширение, для которого нет правила
  // проверки содержимого, не может быть разрешено.
  return configured.map((e) => (e.startsWith('.') ? e : `.${e}`)).filter((e) => FORMATS[e]);
}

// Расширение имени файла. Регистр не важен, хвост из нескольких точек
// («тз.docx.exe») даёт .exe — и такой файл не пройдёт список.
function extensionOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function startsWith(buffer, magic) {
  if (buffer.length < magic.length) return false;
  return buffer.subarray(0, magic.length).equals(magic);
}

// Текстовый файл: без NUL-байтов, валидный UTF-8 и не начинается с сигнатуры
// исполняемого/архива (MZ, ELF, PK, %PDF) — такие «текстовые» файлы обманывают
// именно расширением.
const BINARY_PREFIXES = [
  Buffer.from([0x4d, 0x5a]), // MZ  — Windows PE
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK — zip
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), // OLE
  Buffer.from('%PDF-', 'ascii'),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O / class
];

function looksLikeText(buffer) {
  if (buffer.includes(0x00)) return false;
  if (BINARY_PREFIXES.some((p) => startsWith(buffer, p))) return false;
  // Строгая проверка UTF-8: перекодировка «туда-обратно» меняет байты только
  // если исходная последовательность невалидна (появится U+FFFD).
  const text = buffer.toString('utf8');
  return !text.includes('�');
}

function detectKind(buffer) {
  if (startsWith(buffer, ZIP.magic[0])) return ZIP.label;
  if (startsWith(buffer, OLE.magic[0])) return OLE.label;
  if (startsWith(buffer, PDF.magic[0])) return PDF.label;
  if (looksLikeText(buffer)) return TEXT.label;
  return 'unknown';
}

// Проверка «заголовок файла ↔ расширение». Чистая: на вход буфер, не путь.
function checkSignature(ext, headerBuffer) {
  const format = FORMATS[ext];
  if (!format) return { ok: false, code: 'EXT_NOT_ALLOWED', reason: `расширение ${ext || '(нет)'} не разрешено` };
  const detected = detectKind(headerBuffer);
  if (format.kind === TEXT) {
    if (detected !== TEXT.label) {
      return { ok: false, code: 'CONTENT_NOT_TEXT', reason: `содержимое не текст (${detected})`, detected };
    }
    return { ok: true, detected };
  }
  if (detected !== format.kind.label) {
    return {
      ok: false,
      code: 'MAGIC_MISMATCH',
      reason: `содержимое (${detected}) не соответствует расширению ${ext} (ожидался ${format.kind.label})`,
      detected,
    };
  }
  return { ok: true, detected };
}

// Declared mime — из запроса, доверия к нему нет: расхождение не отклоняет
// файл (браузеры и Windows врут про типы), но попадает в отчёт и в аудит.
function checkDeclaredMime(ext, mimeType) {
  const format = FORMATS[ext];
  if (!format || !mimeType) return { match: true };
  const clean = String(mimeType).split(';')[0].trim().toLowerCase();
  if (clean === 'application/octet-stream' || !clean) return { match: true };
  return { match: format.mimes.includes(clean), declared: clean, expected: format.mimes };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readHeader(filePath, bytes = 4096) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// Полная проверка файла на диске: расширение → размер → сигнатура → SHA-256.
// Возвращает { ok, code, reason, ext, detected, sha256, size, mimeMismatch }.
async function inspectFile({ filePath, originalName, mimeType, maxBytes, allowed = DEFAULT_EXTENSIONS }) {
  const ext = extensionOf(originalName);
  if (!allowed.includes(ext)) {
    return { ok: false, code: 'EXT_NOT_ALLOWED', reason: `формат ${ext || '(без расширения)'} не разрешён`, ext };
  }
  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0) return { ok: false, code: 'FILE_EMPTY', reason: 'файл пустой', ext, size: 0 };
  if (maxBytes && stat.size > maxBytes) {
    return { ok: false, code: 'FILE_TOO_LARGE', reason: `файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`, ext, size: stat.size };
  }
  const header = await readHeader(filePath);
  const signature = checkSignature(ext, header);
  if (!signature.ok) return { ...signature, ext, size: stat.size };

  const mime = checkDeclaredMime(ext, mimeType);
  const sha256 = await sha256File(filePath);
  return {
    ok: true,
    ext,
    detected: signature.detected,
    size: stat.size,
    sha256,
    mimeMismatch: mime.match ? null : { declared: mime.declared, expected: mime.expected },
  };
}

module.exports = {
  FORMATS,
  DEFAULT_EXTENSIONS,
  allowedExtensions,
  extensionOf,
  detectKind,
  looksLikeText,
  checkSignature,
  checkDeclaredMime,
  inspectFile,
  sha256File,
  readHeader,
};
