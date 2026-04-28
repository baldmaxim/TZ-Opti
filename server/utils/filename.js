'use strict';

/**
 * Multer 1.x декодирует имена файлов из multipart как latin1,
 * а браузеры присылают их в UTF-8. Получается мохидзаке («Ð¢ÐµÑ……»).
 *
 * Эта функция читает байты обратно как latin1 и декодирует их как UTF-8.
 * Для чисто ASCII-имён round-trip — no-op, так что вызывать её безопасно
 * для любых имён.
 */
function decodeMulterFilename(name) {
  if (!name || typeof name !== 'string') return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (_e) {
    return name;
  }
}

module.exports = { decodeMulterFilename };
