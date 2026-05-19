import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// TUNNEL=1 — dev-only режим для временного Cloudflare-туннеля.
// Без TUNNEL поведение байт-в-байт как раньше (localhost, open, без allowedHosts).
const TUNNEL = process.env.TUNNEL === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: !TUNNEL,
    host: TUNNEL ? true : 'localhost',
    proxy: {
      // Объектная форма + большие тайм-ауты: синхронный запуск Стадии 1
      // (анализ ТЗ Claude) занимает ~6-7 мин (worst ~12) — дефолтный
      // сокет-таймаут прокси оборвал бы запрос («Failed to fetch»).
      // Согласовано с server.requestTimeout в server/app.js (900000).
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        timeout: 900000,
        proxyTimeout: 900000,
      },
    },
    // Случайный сабдомен *.trycloudflare.com → суффикс-матч (безопаснее, чем
    // allowedHosts:true). HMR через HTTPS-туннель: wss на 443.
    ...(TUNNEL
      ? {
          allowedHosts: ['.trycloudflare.com'],
          hmr: { protocol: 'wss', clientPort: 443 },
        }
      : {}),
  },
});
