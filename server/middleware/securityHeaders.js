'use strict';

// Заголовки безопасности для API, отдающего JSON, файлы и один HTML-preview.
//
// Набор осознанно узкий: сервер не отдаёт приложение (его собирает Vite и
// раздаёт фронтовый хост), поэтому политика рассчитана на «ответ не должен
// исполняться в браузере и не должен попадать в чужие кэши».
//
//   Content-Security-Policy         — sandbox для preview/скачанных файлов:
//                                     ни скриптов, ни подгрузки чужих ресурсов;
//   X-Content-Type-Options: nosniff — .docx не станет HTML по «догадке» браузера;
//   X-Frame-Options / frame-ancestors — ответы API не встраиваются в чужой фрейм;
//   Referrer-Policy                 — id тендера не утекает в чужие логи по Referer;
//   Cross-Origin-*                  — окно/ресурсы изолированы от чужих страниц;
//   Cache-Control: no-store         — ТЗ и выгрузки не оседают в промежуточных кэшах;
//   HSTS                            — только в production и только поверх https.

const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  'sandbox',
].join('; ');

function securityHeaders(config) {
  const hstsValue = `max-age=${config.headers.hstsMaxAgeSec}; includeSubDomains`;
  const useHsts = config.isProduction && config.headers.hstsEnabled;

  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    // Версия и стек сервера — лишняя подсказка о том, чем нас атаковать.
    res.removeHeader('X-Powered-By');
    if (useHsts && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
      res.setHeader('Strict-Transport-Security', hstsValue);
    }
    next();
  };
}

module.exports = { securityHeaders, CSP };
