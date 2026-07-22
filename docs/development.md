# Разработка и проверки

Фактическая матрица команд репозитория. Всё ниже проверено на Windows 10 +
Node.js v24.14.1 / npm 11.11.0.

## Требования

| Что | Версия |
|-----|--------|
| Node.js | ≥ 20 (нужны `--env-file`, `node --test` с glob). Проверено на 24.14.1 |
| npm | ≥ 10 (проверено на 11.11.0) |
| PostgreSQL | нужен для запуска приложения и для integration-тестов; юнит-тестам не нужен |

## Установка (по lock-файлам)

Три независимых пакета — три установки:

```bash
npm ci                      # root  (concurrently)
npm --prefix server ci      # server
npm --prefix client ci      # client
```

`npm ci` ставит строго по `package-lock.json` и падает при рассинхроне с
`package.json`. Для обычной локальной работы есть агрегат `npm run install:all`
(`npm install` в трёх пакетах) — он lock-файлы может обновлять, поэтому для
воспроизводимой проверки используйте `npm ci`.

## Переменные окружения

| Файл | Назначение |
|------|-----------|
| `.env` (корень) | рабочее окружение: `DATABASE_URL`, LLM-ключи. Шаблон — `.env.example`. Не читается тестами |
| `.env.test` (корень, необязателен) | окружение integration-тестов: `TEST_DATABASE_URL`. Шаблон — `.env.test.example`. В git не коммитится |
| `server/test/env/test.env` | `NODE_ENV=test` — включает fail-closed защиты тестового процесса (в git есть) |
| `server/test/env/strict.env` | `TEST_DB_REQUIRED=1` — строгий режим integration (в git есть) |

**Почему тестовая БД задаётся отдельной переменной.** В тестовом процессе
`server/db/connectionTarget.js` читает **только** `TEST_DATABASE_URL`;
`DATABASE_URL` как источник подключения не используется вообще, а совпадение
двух строк — ошибка. Признак «тестовый процесс» берётся из двух независимых
сигналов: `NODE_TEST_CONTEXT` (его выставляет сам `node --test`) и
`NODE_ENV=test`. Отключить защиту одной переменной нельзя.

Важно: `node --env-file` **не перезаписывает** уже заданные переменные
окружения. Если `TEST_DATABASE_URL` задан в системном окружении, он
приоритетнее `.env.test`.

Локальный TLS: строки подключения к managed-Postgres (Supabase) идут с TLS по
умолчанию; для локального кластера добавьте `?sslmode=disable` — это
единственный явный способ выключить TLS (`sslOptionFor`).

## Миграции

```bash
npm --prefix server run migrate     # применить schema.sql + идемпотентные ALTER
npm run seed                        # демо-данные (node server/db/seed.js -f — сброс)
```

Обе команды читают `.env` только при самостоятельном запуске (`require.main`);
при импорте из кода/тестов окружение задаёт вызывающий. Сервер применяет
миграцию сам при старте (`server/server.js`), но **не** при импорте `app.js`.

Миграция идемпотентна — повторный прогон безопасен (проверяется в
`server/test/integration/db.integration.test.js`).

## Тесты

| Команда | Что делает | Нужна БД/сеть |
|---------|-----------|----------------|
| `npm run test:unit` | серверные юнит-тесты (`server/test/unit/**`) | нет |
| `npm run test:integration` | integration (`server/test/integration/**`); без `TEST_DATABASE_URL` — **skip** с причиной | Postgres (опц.) |
| `npm test` | `test:unit` + `test:integration` (общий вход сохранён) | Postgres (опц.) |
| `npm run verify` | `test:unit` → `test:integration` → production-сборка клиента | Postgres (опц.) |
| `npm run verify:integration` | integration в строгом режиме: без `TEST_DATABASE_URL` **падает** | Postgres (обяз.) |
| `npm run build` | production-сборка клиента (`vite build`) | нет |

Юнит-тесты не требуют Postgres, не читают `.env` и не ходят в сеть: попытка
исходящего соединения в тесте блокируется helper'ом
`server/test/helpers/network.js`, а реальный вызов LLM запрещён самим
`openaiClient` (`LLM_CALL_IN_TEST_PROCESS`).

`verify` зелёный и без тестовой БД — integration-тесты в нём пропускаются, и
пропуск виден в выводе (`skipped N` + причина у каждого теста). Если нужно
доказать, что интеграция реально выполнялась, запускайте `verify:integration`.

### Локальная БД для integration-тестов

Отдельная инфраструктура в репозиторий не добавлялась (ни Docker, ни
testcontainers) — достаточно любой пустой базы. Пример с локальным кластером
PostgreSQL:

```bash
initdb -D /tmp/pgdata -U postgres --auth=trust --encoding=UTF8
pg_ctl -D /tmp/pgdata -o "-p 55432 -h 127.0.0.1" -l /tmp/pg.log -w start
psql -h 127.0.0.1 -p 55432 -U postgres -c "CREATE DATABASE tz_opti_test;"

# .env.test в корне репозитория:
# TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/tz_opti_test?sslmode=disable

npm run verify:integration
```

Integration-тест применяет схему (`runMigration`) к указанной базе — указывайте
**отдельную** БД, не рабочую.

### Test helpers

`server/test/helpers/` — переиспользуемые заготовки, чтобы тесты не собирали
инфраструктуру заново:

| Helper | Для чего |
|--------|----------|
| `tmpDir.js` | временные каталоги/файлы в `os.tmpdir()` с автоуборкой |
| `docxFixtures.js` | сборка `.docx`-фикстур (абзац/список/таблица/мультиформат) + запись во временный файл |
| `fakeLlm.js` | fake LLM-провайдер через `setChatJsonProvider` (очередь ответов, запись вызовов, ошибки) |
| `clock.js` | контролируемые часы (`installFakeClock`) и детерминированные ID |
| `network.js` | блокировка исходящей сети (`blockNetwork`) |
| `testDb.js` | доступ к тестовой БД + решение skip / strict-fail |

## Запуск приложения

```bash
npm run dev          # server :4000 + client :5173 + LLM-bridge :4010
npm run dev:server   # только сервер (nodemon server/server.js)
npm run dev:client   # только клиент
npm run bridge       # только LLM-bridge
```

Точка входа сервера — `server/server.js`: читает `.env`, применяет миграцию,
сеет демо-данные при пустой БД, чинит «зомби»-статусы, слушает порт.
`server/app.js` содержит только `createApp()` и при импорте **не** открывает
порт, **не** мигрирует и **не** сеет БД — поэтому приложение можно собрать в
тесте офлайн (`server/test/unit/appSmoke.test.js`).

Публичные маршруты при этом не менялись.

## Инварианты

Список свойств, которые обязаны выполняться всегда, и их фактический статус —
[docs/safety-invariants.md](safety-invariants.md).
