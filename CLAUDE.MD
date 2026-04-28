# CLAUDE.md

Инструкция для Claude Code при работе с этим репозиторием.

## Обзор проекта

**TZ-Opti** — MVP-портал для инженера тендерного отдела строительной компании. Анализ ТЗ на СМР через 4-стадийный последовательный пайплайн с экспортом исходного ТЗ в `.docx` с правками и комментариями в логике Word Review.

## Стек

- **client**: Vite + React 18 + JS (без TypeScript) + React Router + Tailwind CSS + Zustand
- **server**: Node.js + Express + pg (PostgreSQL/Supabase) + Multer
- **docx-экспорт**: pizzip + @xmldom/xmldom + xpath (модификация оригинального .docx, не генерация с нуля)

## БД

Postgres-обёртка в `server/db/connection.js` экспортирует **асинхронный** API:
`queryOne / queryAll / queryRun / exec / transaction`. Плейсхолдеры пишутся в стиле SQLite (`?`), конвертер автоматически превращает их в `$1, $2, ...`. Транзакции — `await db.transaction(async (tx) => { await tx.queryRun(...) })`. **Не использовать** `db.prepare(...)` (better-sqlite3 API) и `db.queryTransaction` — таких функций нет.

## Команды

```bash
npm run install:all   # установить зависимости root/server/client
npm run dev           # запустить server (:4000) и client (:5173) одновременно
npm run seed          # пересеять Postgres-БД демо-данными (--force чтобы перезаписать)
npm run build         # production-сборка клиента
```

## Архитектура

```
TZ-Opti/
├── client/    Vite + React + Tailwind + Zustand
├── server/    Express + pg (Supabase Postgres) + Multer
└── README.md  главный документ — содержит "что работает / что mock / что следующая задача"
```

Бизнес-логика — в `server/services/`. UI на русском, код на английском.

## Конвенции

- Без TypeScript на клиенте
- Tailwind для стилей (один источник правды)
- Zustand вместо Redux
- Тексты UI — на русском
- Имена файлов / переменных / функций — английский
- Один файл ≤ 600 строк (разбивать)

## Главный артефакт

Экспорт `/api/tenders/:id/export/docx` собирает исходный ТЗ.docx с комментариями (Word Comments API) и визуальным вычёркиванием для решений `delete` / `remove_from_scope`. Настоящий Track Changes (`w:ins` / `w:del`) — следующая задача, архитектура готова (`server/services/reviewDocx/trackChangesWriter.js` — stub).

## Анализатор

4 стадии (последовательно), rule-based:
1. ТЗ + Чек-лист + ВОР
2. ТЗ + Q&A форма + Таблица характеристик (Q&A загружается xlsx)
3. ТЗ + Типовые риски
4. Самоанализ ТЗ (скрытые работы / двусмыслия / срок)

После каждой стадии решения с действием `delete` / `remove_from_scope` исключают фрагменты из активного текста для следующих стадий.

## .env

Один `.env` в корне репозитория. Шаблон рядом — `.env.example`. Сервер подгружает из корня через `dotenv.config({ path: '../../.env' })` (относительно `server/app.js` и `server/db/seed.js`).
