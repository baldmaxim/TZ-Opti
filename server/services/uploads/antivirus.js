'use strict';

// Антивирусная проверка загрузок — ОБЯЗАТЕЛЬНЫЙ шаг, а не опция.
//
// Сам движок не встроен (и не должен быть): портал вызывает внешний сканер
// одним из трёх способов, а в production обязан быть настроен хотя бы один
// (проверяется на старте, security/config.js):
//   clamd   — ClamAV по TCP, протокол INSTREAM (файл не кладётся в общую папку);
//   command — произвольный сканер как процесс: код 0 — чисто, 1 — заражено;
//   http    — ICAP-подобный сервис: POST тела файла, ответ {status:'clean'|'infected'}.
//
// FAIL-CLOSED: всё, что не «однозначно чисто» (заражено, таймаут, сканер лежит,
// нераспознанный ответ), считается непройденной проверкой и файл не принимается.
// Тихого «пропустим, антивирус недоступен» здесь нет by design.

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');

class AntivirusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AntivirusError';
    this.code = code;
  }
}

const CLEAN = (engine, extra = {}) => ({ status: 'clean', engine, ...extra });
const INFECTED = (engine, signature) => ({ status: 'infected', engine, signature });

// --- clamd (INSTREAM) --------------------------------------------------------
// z-команда + чанки [4 байта длины BE][данные], завершение — нулевая длина.
function scanWithClamd(filePath, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    let settled = false;

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new AntivirusError(code, message));
    };

    socket.setTimeout(timeoutMs, () => fail('AV_TIMEOUT', `clamd не ответил за ${timeoutMs} мс`));
    socket.on('error', (err) => fail('AV_UNAVAILABLE', `clamd недоступен: ${err.message}`));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      });
      stream.on('end', () => socket.write(Buffer.alloc(4))); // нулевая длина = конец потока
      stream.on('error', (err) => fail('AV_READ_FAILED', err.message));
    });

    socket.on('data', (data) => {
      response += data.toString('utf8');
    });

    socket.on('close', () => {
      if (settled) return;
      settled = true;
      const text = response.replace(/\0/g, '').trim();
      if (/\bOK$/.test(text)) return resolve(CLEAN('clamav', { raw: text }));
      const found = /^(?:stream:)?\s*(.+?)\s+FOUND$/i.exec(text);
      if (found) return resolve(INFECTED('clamav', found[1]));
      reject(new AntivirusError('AV_BAD_RESPONSE', `clamd вернул нераспознанный ответ: ${text.slice(0, 200)}`));
    });
  });
}

// --- внешняя команда ---------------------------------------------------------
// AV_COMMAND — путь к исполняемому файлу КАК ЕСТЬ (в нём бывают пробелы:
// "C:\Program Files\ClamAV\clamscan.exe"), дополнительные аргументы — отдельной
// переменной AV_COMMAND_ARGS. Разбирать одну строку на слова нельзя: путь с
// пробелом развалился бы, а кавычки открыли бы дорогу к подстановке аргументов.
// Запуск без shell, путь к файлу — последним аргументом массива.
function scanWithCommand(filePath, { command, commandArgs = [], timeoutMs }) {
  return new Promise((resolve, reject) => {
    const bin = command;
    const args = [...commandArgs, filePath];
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (!err) return resolve(CLEAN(bin, { raw: out.slice(0, 500) }));
      if (err.killed) return reject(new AntivirusError('AV_TIMEOUT', `сканер не ответил за ${timeoutMs} мс`));
      // Соглашение clamscan: 1 — найден вирус, всё остальное — ошибка сканера.
      if (err.code === 1) {
        const sig = /:\s*(.+?)\s+FOUND/i.exec(out);
        return resolve(INFECTED(bin, sig ? sig[1] : 'unknown'));
      }
      return reject(new AntivirusError('AV_FAILED', `сканер завершился с кодом ${err.code}: ${out.slice(0, 200)}`));
    });
  });
}

// --- HTTP-сервис -------------------------------------------------------------
async function scanWithHttp(filePath, { url, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: await fs.promises.readFile(filePath),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AntivirusError('AV_UNAVAILABLE', `сервис проверки недоступен: ${err.message}`);
  }
  if (res.status === 422 || res.status === 406) return INFECTED('http', 'reported-by-service');
  if (!res.ok) throw new AntivirusError('AV_FAILED', `сервис проверки вернул HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new AntivirusError('AV_BAD_RESPONSE', 'сервис проверки вернул не JSON');
  }
  const status = String((body && body.status) || '').toLowerCase();
  if (status === 'clean' || body.clean === true || body.infected === false) return CLEAN('http', { raw: status });
  if (status === 'infected' || body.infected === true) return INFECTED('http', body.signature || 'unknown');
  throw new AntivirusError('AV_BAD_RESPONSE', `нераспознанный ответ сервиса проверки: ${JSON.stringify(body).slice(0, 200)}`);
}

// Единая точка входа. Возвращает {status:'clean'|'infected'|'skipped', ...}
// либо бросает AntivirusError (= файл не принимаем).
async function scanFile(filePath, config) {
  const av = config.uploads.av;
  if (av.mode === 'disabled') {
    if (config.isProduction) {
      // Недостижимо при корректном старте (assertProductionSecurity), но
      // остаётся вторым рубежом: выключенный антивирус в production = отказ.
      throw new AntivirusError('AV_NOT_CONFIGURED', 'антивирусная проверка обязательна в production');
    }
    return { status: 'skipped', engine: 'none', reason: 'AV_SCAN_MODE=disabled (только вне production)' };
  }

  const stat = await fs.promises.stat(filePath);
  const maxBytes = Math.max(1, av.maxMb) * 1024 * 1024;
  if (stat.size > maxBytes) {
    throw new AntivirusError('AV_FILE_TOO_LARGE', `файл больше лимита сканера (${av.maxMb} МБ)`);
  }

  if (av.mode === 'clamd') return scanWithClamd(filePath, av);
  if (av.mode === 'command') {
    if (!av.command) throw new AntivirusError('AV_NOT_CONFIGURED', 'AV_COMMAND не задан');
    return scanWithCommand(filePath, av);
  }
  if (av.mode === 'http') {
    if (!av.url) throw new AntivirusError('AV_NOT_CONFIGURED', 'AV_HTTP_URL не задан');
    return scanWithHttp(filePath, av);
  }
  throw new AntivirusError('AV_NOT_CONFIGURED', `неизвестный режим AV_SCAN_MODE=${av.mode}`);
}

module.exports = { scanFile, scanWithClamd, scanWithCommand, scanWithHttp, AntivirusError };
