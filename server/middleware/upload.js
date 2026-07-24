'use strict';

// Приём файла: КАРАНТИН → проверки → рабочая папка тендера.
//
// Раньше multer писал файл сразу в папку тендера, и любой принятый байт
// оказывался в рабочем каталоге. Теперь файл сначала попадает в отдельный
// каталог карантина, и переезжает в папку тендера ТОЛЬКО пройдя все проверки:
//   расширение → размер → магические байты → SHA-256 → антивирус.
// Непрошедший файл удаляется, наружу уходит понятная ошибка, в журнал аудита —
// причина и хэш.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');

const { decodeMulterFilename } = require('../utils/filename');
const { getSecurityConfig } = require('../security/config');
const { inspectFile, allowedExtensions, extensionOf } = require('../services/uploads/fileSafety');
const { scanFile, AntivirusError } = require('../services/uploads/antivirus');
const { HttpError, badRequest } = require('../utils/errors');

const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
const QUARANTINE_ROOT = path.join(UPLOAD_ROOT, 'quarantine');
fs.mkdirSync(QUARANTINE_ROOT, { recursive: true });

// Имя на диске не наследует пользовательское: uuid + очищенная основа + расширение.
function safeFilename(originalname) {
  const fixed = decodeMulterFilename(originalname);
  const ext = extensionOf(fixed);
  const base = path
    .basename(fixed, path.extname(fixed))
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 60);
  return { fixed, name: `${uuid()}__${base}${ext}` };
}

const quarantineStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, QUARANTINE_ROOT);
  },
  filename(_req, file, cb) {
    const { fixed, name } = safeFilename(file.originalname);
    file.originalname = fixed;
    cb(null, name);
  },
});

// Конфигурация берётся у приложения (createApp кладёт её в app.locals), а не из
// глобального синглтона: так тест поднимает приложение со своими правилами
// приёма файлов, а в бою это тот же самый объект.
function configOf(req) {
  const local = req && req.app && req.app.locals && req.app.locals.security;
  return (local && local.config) || getSecurityConfig();
}

// Ранний отсев по расширению — до того, как байты попадут на диск.
function extensionFilter(req, file, cb) {
  const config = configOf(req);
  const fixed = decodeMulterFilename(file.originalname);
  const ext = extensionOf(fixed);
  if (!allowedExtensions(config).includes(ext)) {
    return cb(new HttpError(415, `Формат ${ext || 'без расширения'} не поддерживается`, { allowed: allowedExtensions(config) }));
  }
  return cb(null, true);
}

// multer-инстансы кэшируются по действующим ограничениям: пересоздавать их на
// каждый запрос незачем, а «прибить» лимит на этапе загрузки модуля нельзя.
const uploaders = new Map();
function uploaderFor(config) {
  const key = `${config.uploads.maxMb}|${allowedExtensions(config).join(',')}`;
  if (!uploaders.has(key)) {
    uploaders.set(
      key,
      multer({
        storage: quarantineStorage,
        limits: { fileSize: Math.max(1, config.uploads.maxMb) * 1024 * 1024, files: 1, fields: 20 },
        fileFilter: extensionFilter,
      }),
    );
  }
  return uploaders.get(key);
}

// Оборачивает multer: его собственные ошибки превращаются в человеческий 4xx,
// а не в 500 «MulterError: File too large».
function acceptSingle(field) {
  return function acceptSingleMiddleware(req, res, next) {
    const config = configOf(req);
    uploaderFor(config).single(field)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new HttpError(413, `Файл больше ${config.uploads.maxMb} МБ`, { max_mb: config.uploads.maxMb }));
        }
        return next(badRequest(`Загрузка отклонена: ${err.code}`));
      }
      return next(err);
    });
  };
}

async function removeQuietly(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    /* файла уже нет — не мешает */
  }
}

// Проверка + переезд из карантина. subdirResolver(req) → подпапка внутри uploads.
function screenUpload(subdirResolver) {
  return async function screenUploadMiddleware(req, _res, next) {
    if (!req.file) return next();
    const config = configOf(req);
    const quarantinePath = req.file.path;

    const reject = async (status, code, message, meta = {}) => {
      await removeQuietly(quarantinePath);
      req.auditMeta = { ...(req.auditMeta || {}), filename: req.file.originalname, rejected: code, ...meta };
      const err = new HttpError(status, message);
      err.code = code;
      return next(err);
    };

    try {
      const verdict = await inspectFile({
        filePath: quarantinePath,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        maxBytes: Math.max(1, config.uploads.maxMb) * 1024 * 1024,
        allowed: allowedExtensions(config),
      });
      if (!verdict.ok) {
        const status = verdict.code === 'EXT_NOT_ALLOWED' ? 415 : verdict.code === 'FILE_TOO_LARGE' ? 413 : 400;
        return reject(status, verdict.code, `Файл не принят: ${verdict.reason}`);
      }

      let scan;
      try {
        scan = await scanFile(quarantinePath, config);
      } catch (err) {
        if (err instanceof AntivirusError) {
          // Сканер недоступен — файл НЕ принимается (fail-closed).
          return reject(503, err.code, 'Проверка файла антивирусом не выполнена, загрузка отклонена', {
            sha256: verdict.sha256,
          });
        }
        throw err;
      }
      if (scan.status === 'infected') {
        return reject(422, 'AV_INFECTED', 'Файл отклонён антивирусом', {
          sha256: verdict.sha256,
          signature: scan.signature,
          engine: scan.engine,
        });
      }

      // Проверки пройдены — переносим в рабочую папку.
      const targetDir = path.join(UPLOAD_ROOT, subdirResolver(req));
      await fs.promises.mkdir(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, path.basename(quarantinePath));
      try {
        await fs.promises.rename(quarantinePath, targetPath);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        // Карантин на другом томе — копируем и убираем оригинал.
        await fs.promises.copyFile(quarantinePath, targetPath);
        await removeQuietly(quarantinePath);
      }

      req.file.path = targetPath;
      req.fileScan = {
        sha256: verdict.sha256,
        size: verdict.size,
        ext: verdict.ext,
        detected: verdict.detected,
        mimeMismatch: verdict.mimeMismatch,
        av_status: scan.status,
        av_engine: scan.engine || null,
      };
      req.auditMeta = {
        ...(req.auditMeta || {}),
        filename: req.file.originalname,
        sha256: verdict.sha256,
        size: verdict.size,
        av: scan.status,
      };
      return next();
    } catch (err) {
      await removeQuietly(quarantinePath);
      return next(err);
    }
  };
}

const documentScreening = screenUpload((req) => path.join('tenders', req.params.id || 'misc'));
const qaScreening = screenUpload((req) => path.join('tenders', req.params.id || 'misc', 'qa'));

module.exports = {
  UPLOAD_ROOT,
  QUARANTINE_ROOT,
  acceptSingle,
  screenUpload,
  documentScreening,
  qaScreening,
  // Совместимость с прежним API маршрутов (documentUpload.single('file')).
  documentUpload: { single: (field) => acceptSingle(field) },
  qaUpload: { single: (field) => acceptSingle(field) },
};
