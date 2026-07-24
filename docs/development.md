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
| `.env` (корень) | рабочее окружение: `DATABASE_URL`, LLM-ключи, настройки воркера очереди (`WORKER_*`). Шаблон — `.env.example`. Не читается тестами |
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
| `fakeQueue.js` | офлайн-стор очереди задач (те же правила из `jobs/jobModel`) + фейковый advisory-lock |
| `queueWorkerProc.js` | отдельный ПРОЦЕСС-воркер для integration-теста «два воркера» (`child_process.fork`) |

## Запуск приложения

```bash
npm run dev          # server :4000 + client :5173 + LLM-bridge :4010
npm run dev:server   # только сервер (nodemon server/server.js)
npm run dev:client   # только клиент
npm run bridge       # только LLM-bridge
npm run worker       # отдельный процесс-воркер очереди (см. ниже)
```

Точка входа сервера — `server/server.js`: читает `.env`, применяет миграцию,
сеет демо-данные при пустой БД, чинит «зомби»-статусы, поднимает воркер очереди
и слушает порт. `server/app.js` содержит только `createApp()` и при импорте
**не** открывает порт, **не** мигрирует и **не** сеет БД — поэтому приложение
можно собрать в тесте офлайн (`server/test/unit/appSmoke.test.js`).

Публичные маршруты при этом не менялись.

### Воркеры очереди

Фоновые прогоны (анализ стадии, пересборка конвейера) идут через очередь в
Postgres — `analysis_jobs` / `analysis_tasks` (см. раздел «Очередь фоновых
задач» в [README](../README.md)). Кто её разбирает, задаёт `WORKER_MODE`:

| Режим | Что запускать | Когда |
|-------|---------------|-------|
| `embedded` (дефолт) | `npm run dev` / `npm --prefix server start` | обычная разработка: сервер сам поднимает воркер внутри процесса |
| `external` | `WORKER_MODE=external npm --prefix server start` + `npm run worker` | когда API и тяжёлый анализ нужно разнести по процессам/машинам |

Воркеров можно запускать несколько — координация целиком в БД (`FOR UPDATE SKIP
LOCKED` + аренда + advisory-lock), общего состояния в памяти нет. Тюнинг —
`WORKER_CONCURRENCY`, `WORKER_LEASE_MS`, `WORKER_HEARTBEAT_MS`, `WORKER_POLL_MS`,
`WORKER_REAP_MS` (значения и смысл — в `.env.example`).

Остановка процесса (`Ctrl+C`, `SIGTERM`) возвращает незаконченные задачи в
очередь, чтобы после перезапуска они продолжились сразу, не дожидаясь истечения
аренды. Аварийная гибель процесса тоже не теряет работу — задачу подберёт
reaper, когда истечёт аренда.

> **Пулер соединений.** Замок на область берётся session-level
> (`pg_try_advisory_lock` на выделенном соединении). С Supabase это порт **5432**
> (session mode). Transaction-mode пулер (6543) session-level замки не
> сохраняет — с ним гарантия «одна стадия одной ревизии» ослабнет до защиты
> уровня очереди.

## Инварианты

Список свойств, которые обязаны выполняться всегда, и их фактический статус —
[docs/safety-invariants.md](safety-invariants.md).
