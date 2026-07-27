# TZ-Opti

MVP-портал для инженера тендерного отдела строительной компании. Анализ ТЗ на СМР по 5-стадийному последовательному пайплайну на LLM-агентах с экспортом исходного `.docx` с настоящими правками (Word Track Changes) и комментариями в логике Word Review.

---

## Что это и для кого

Инженер тендерного отдела участвует в тендерах на ЖК в Москве (генподряд + коробка). Каждый тендер требует:
- сверки ТЗ с чек-листом работ и ВОР (что входит в объём генподрядчика),
- сверки ТЗ с принятыми бизнес-решениями (Q&A форма) и таблицей характеристик,
- сверки ТЗ с существенными договорными условиями компании,
- проверки ТЗ против типовых рисков (прямые и косвенные упоминания),
- самоанализа ТЗ (скрытые работы, двусмыслия, влияние на срок),
- формирования итогового файла с замечаниями.

Портал собирает все материалы в одной карточке тендера и проводит инженера через 5 стадий анализа LLM-агентом. Результат — исходный ТЗ.docx, в который встроены настоящие правки Word (Track Changes) и комментарии по принятым решениям.

---

## Архитектура

```
┌─────────────────┐         REST JSON         ┌──────────────────────┐
│  client (Vite)  │ ◀────────────────────────▶│  server (Express)    │
│  :5173          │                            │  :4000               │
│  React + JS     │                            │  pg (Postgres)       │
│  Tailwind +     │                            │  Multer • Mammoth    │
│  Zustand        │                            │  XLSX • pdf-parse    │
│  React Router   │                            │  pizzip + xmldom     │
└─────────────────┘                            └─────┬───────────┬────┘
                                                     │           │
                              OpenAI-совместимый ▼   │           ▼
                          ┌──────────────────────────┐   ┌──────────────────────┐
                          │ LLM bridge (dev) :4010   │   │ Postgres / Supabase  │
                          │ claudeBridge.js → Claude │   │ (DATABASE_URL)       │
                          │ Agent SDK (sonnet-4-6)   │   │ uploads/ (Multer)    │
                          └──────────────────────────┘   └──────────────────────┘
```

В dev LLM-вызовы идут в локальный `claudeBridge.js` (OpenAI-совместимый прокси к Claude через Agent SDK). В проде `OPENAI_BASE_URL` можно направить на любой OpenAI-совместимый эндпоинт.

---

## Стек

- **Frontend**: Vite, React 18, JS (без TypeScript), React Router, Tailwind CSS, Zustand
- **Backend**: Node.js, Express, **pg (PostgreSQL / Supabase)**, Multer
- **LLM**: OpenAI-совместимый клиент (`server/services/stageAnalysis/llm/openaiClient.js`), structured output по JSON Schema; в dev — локальный Claude-bridge (`server/devtools/claudeBridge.js`)
- **Извлечение текста**: mammoth (.docx), pdf-parse (.pdf), xlsx (.xlsx), нативный fs (.txt/.md/.csv)
- **Экспорт .docx**: pizzip + @xmldom/xmldom + xpath — модификация исходного `.docx` с настоящими Word Track Changes (`w:ins` / `w:del`) и комментариями Word

Никакого TypeScript на клиенте, Redux, MUI/AntD. UI на русском, код на английском.

---

## Запуск

Требуется Node.js ≥ 20 (нужны `--env-file` и `node --test` с glob-шаблонами;
проверено на 24.14.1).

```bash
# 1. Установить зависимости root + client + server
npm run install:all

# 2. Создать .env в корне (шаблон — .env.example)
#    Обязательно: DATABASE_URL (Postgres/Supabase) и доступ к LLM.

# 3. Запустить dev (server :4000, client :5173, bridge :4010)
npm run dev
```

Откроется `http://localhost:5173`. На старте сервер применяет миграцию (`schema.sql`) и при пустой БД подгружает демо-данные (2 тендера).

**Конфигурация (`.env` в корне, см. `.env.example`):**
- `DATABASE_URL` — Postgres/Supabase (рекомендуется pooler `*.pooler.supabase.com:6543`). **Без него сервер не стартует.**
- LLM: либо реальный OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`), либо локальный bridge — `OPENAI_BASE_URL=http://127.0.0.1:4010/v1`, `OPENAI_API_KEY=local-bridge` (любая непустая строка), `BRIDGE_MODEL=claude-sonnet-4-6`.
- Режим промта по стадиям: `STAGE{1..5}_PROMPT_VARIANT` = `structural` (дефолт) | `strict` | `full`.
- Стадия 4 (риски): `STAGE4_MIN_SCORE` — порог отсева слабых находок quality scoring (дефолт `0.45`).
- Тюнинг и подробности bridge — `server/devtools/README.md`.

Команды:

| Скрипт | Действие |
|--------|----------|
| `npm run install:all` | npm install в root, server, client |
| `npm run dev` | concurrently: server + client + bridge (3 процесса) |
| `npm run dev:server` | только сервер |
| `npm run dev:client` | только клиент |
| `npm run bridge` | только LLM-bridge (`node server/devtools/claudeBridge.js`) |
| `npm run seed` | принудительный сброс и пересоздание demo-данных (`node server/db/seed.js -f`) |
| `npm run build` | production-сборка клиента |
| `npm test` | серверные тесты: unit + integration (integration без `TEST_DATABASE_URL` — skip) |
| `npm run test:unit` | только юнит-тесты (`server/test/unit/**`): без БД, без сети, без LLM |
| `npm run test:integration` | integration (`server/test/integration/**`) по `TEST_DATABASE_URL`; нет БД → skip с причиной |
| `npm run verify` | единая проверка: unit → integration (доступные) → production-сборка клиента |
| `npm run verify:integration` | integration в строгом режиме — без `TEST_DATABASE_URL` падает, а не пропускает |

Матрица команд, переменные тестовой БД и test helpers — [docs/development.md](docs/development.md).
Инварианты безопасности (что обязано выполняться всегда и чем это проверено) —
[docs/safety-invariants.md](docs/safety-invariants.md).

---

## Безопасность (production baseline)

Портал закрыт: **ни один `/api`-маршрут, кроме `/api/health`, не работает без
токена**. Полное описание — [docs/security.md](docs/security.md), переменные —
блок «БЕЗОПАСНОСТЬ» в `.env.example`.

- **Аутентификация** — Bearer JWT от корпоративного OIDC-провайдера
  (Keycloak / Entra ID / Auth0 / любой другой): discovery + JWKS, либо
  статический ключ, либо общий секрет. Проверка подписи — на `node:crypto`,
  без внешних библиотек: allowlist алгоритмов, запрет `alg:none` и
  alg-confusion, сверка `iss`/`aud`/`exp`/`nbf`.
- **Роли** — `viewer` (только смотрит), `engineer` (основной пользователь:
  подготовка, анализ, решения, выгрузки), `lead` (инженер + удаление + аудит),
  `manager` (контроль и выгрузки, без решений и запуска анализа), `admin`.
  Роли провайдера отображаются через `AUTH_ROLE_MAP`; неизвестная роль прав
  не даёт.
- **Доступ к маршрутам** — таблица `server/security/policy.js`, **default
  deny**: путь без правила запрещён, и тест обходит все маршруты приложения,
  требуя правило для каждого.
- **Изоляция тенантов** — тенант субъекта берётся только из токена, тенант
  ресурса только из БД; межтенантное обращение → 403 `CROSS_TENANT_DENIED`.
- **Журнал аудита** (`audit_log`) — чтения, изменения, запуск анализа, решения,
  выгрузки и все отказы; чтение через `GET /api/audit` в пределах своего тенанта.
- **Транспорт** — CORS по allowlist, заголовки безопасности, лимиты частоты
  (в т.ч. антиподбор токена), `X-Request-Id` в логе, аудите и ответе,
  в production 5xx без внутренних деталей.
- **Загрузки** — карантин → список форматов → магические байты → SHA-256 →
  **обязательный антивирус** (clamd / внешняя команда / http-сервис).
  Всё, что не «однозначно чисто», не принимается.
- **PostgreSQL** — в production сертификат проверяется всегда;
  `sslmode=disable`/`no-verify` — ошибка.
- **Dev-bypass** (`AUTH_DEV_BYPASS=1`) — только вне production; в production это
  ошибка старта, как и открытый CORS, выключенный антивирус или нестрогий TLS.

---

## Структура проекта

```
TZ-Opti/
├── client/    Vite + React + Tailwind + Zustand
│   └── src/
│       ├── pages/         DashboardPage, TenderOverview + setup/, stages/, analysis/, result/
│       ├── components/    ui, layout, stages, tables, tender, conditions, documents, issues, review, wizard
│       ├── store/         Zustand (tenders, активный тендер, тосты)
│       ├── services/api.js
│       └── utils/         labels, format
└── server/    Express + pg (Postgres) + Multer
    ├── server.js                                     — entrypoint: .env, миграция, авто-сид, встроенный воркер, listen
    ├── worker.js                                     — entrypoint ОТДЕЛЬНОГО воркера очереди (npm run worker)
    ├── app.js                                        — createApp(): маршруты и middleware, без side-effect'ов
    ├── routes/            tenders, documents, checklist, conditions, risks, qa,
    │                      stages, decisions, review, export, setupLocks, setupParams
    ├── controllers/       тонкие контроллеры под каждый route
    ├── devtools/
    │   ├── claudeBridge.js                           — локальный OpenAI-совместимый прокси к Claude (dev)
    │   └── README.md                                 — настройка bridge и тюнинг стадий
    ├── services/
    │   ├── jobs/                                       — устойчивая очередь фоновых задач (Postgres, без Redis)
    │   │   ├── jobModel.js                             — чистое ядро: ключи, retry/recovery, свод статуса задания
    │   │   ├── jobQueue.js                             — SQL: enqueue, claim (FOR UPDATE SKIP LOCKED), heartbeat, reaper
    │   │   ├── advisoryLock.js                         — session-level pg_advisory_lock на (тендер+область+ревизия)
    │   │   ├── worker.js                               — цикл воркера (аренда, повторы, чекпойнт, отмена)
    │   │   ├── jobService.js                           — раскладка «стадия»/«конвейер» в задание + задачи
    │   │   └── handlers/                               — обработчики задач (stage_analysis, шаги конвейера)
    │   ├── textExtractionService.js
    │   ├── tzActiveTextService.js                     — ТЗ за вычетом исключённых фрагментов (.md)
    │   ├── stageAnalysis/
    │   │   ├── stageAnalysisEngine.js                 — оркестратор 5 стадий (фоновый прогон + статусы)
    │   │   ├── stage1_llm.js … stage4_llm.js          — LLM-агенты стадий 1–4 (логика + схема находки)
    │   │   ├── stage5_llm.js                          — Стадия 5 как QC-агент над итогом (см. selfAnalysis/)
    │   │   ├── stage1Prompts.js … stage5Prompts.js    — системные промты (SHARED + 3 режима)
    │   │   ├── stage4Scoring.js                       — quality scoring + анти-триггеры Стадии 4
    │   │   ├── llm/openaiClient.js                    — OpenAI-совместимый клиент (chatJson)
    │   │   ├── shared/llmStage.js                     — общий каркас (сегментация/локализация/дедуп/раннер)
    │   │   └── shared/fragmentMatcher.js
    │   ├── signals/signalWriter.js                    — слой 1: находки стадий → единый поток сигналов
    │   ├── unifiedAnalysis/unifiedIssueBuilder.js     — слой 2: сигналы одного места ТЗ → draft_issue
    │   ├── critic/criticService.js                    — слой 3: значимость draft_issue для ГП (priority)
    │   ├── clustering/clusteringService.js            — слой 4: похожие замечания одного места → кластер
    │   ├── selfAnalysis/selfAnalysisService.js        — слой 5: QC/полнота над кластерами (self_analysis)
    │   ├── qaImportService.js                         — парсер Q&A xlsx
    │   ├── vor/                                       — структурный ВОР (xls/xlsx)
    │   │   ├── vorParser.js                           — шапка, объединённые ячейки, строки → позиции
    │   │   ├── vorNormalize.js                        — числа и единицы измерения к одному виду
    │   │   ├── vorReader.js                           — xlsx → «сетка» (единственная точка с xlsx)
    │   │   ├── vorImportService.js                    — позиции → vor_items (идемпотентно)
    │   │   ├── vorCatalog.js                          — каталог + ПАКЕТЫ под токенный бюджет
    │   │   └── vorMatchIndex.js                       — сопоставление ТЗ ↔ ВОР ↔ чек-лист
    │   ├── risksService.js                            — библиотека типовых рисков (стандартные + кастомные)
    │   ├── conditionsRenderer.js                      — рендер существенных условий компании
    │   ├── characteristicsTemplate.js                — стандартный шаблон характеристик
    │   ├── reviewDocx/                                — главный артефакт
    │   │   ├── index.js
    │   │   ├── docxPackage.js
    │   │   ├── quoteLocator.js
    │   │   ├── runSplitter.js
    │   │   ├── commentWriter.js                       — Word-комментарии (решение «Примечание»)
    │   │   ├── trackChangesWriter.js                  — настоящий Track Changes (w:ins / w:del)
    │   │   └── manifestUpdater.js
    │   ├── reviewHtmlService.js                       — HTML-preview
    │   ├── exportService.js                           — CSV / JSON / summary.md
    │   └── review/
    │       ├── decisionModel.js                       — единый «вид решения» (docx/preview/md)
    │       ├── stageDomains.js                        — реестр зон ответственности (стадия → свои типы)
    │       └── consolidation.js                       — слой сборки итога (группы / primary / конфликты)
    └── db/
        ├── connection.js                             — pg-обёртка (async queryOne/queryAll/queryRun/exec/transaction)
        ├── schema.sql
        ├── migrate.js
        ├── seed.js
        ├── standardRisks.js                          — 15 типовых рисков
        └── fixtures/                                 — ТЗ.docx, ВОР.xlsx генерируются программно
```

---

## Полный путь инженера

1. **Создать тендер** на дашборде («+ Создать тендер»).
2. **Документы**: загрузить ТЗ (`.docx`/`.pdf`), ВОР.xlsx, ПД/РД и сопутствующие материалы. Текст извлекается автоматически. Для анализа нужна **`.md`-копия ТЗ** в слот «ТЗ → Markdown» — стадии анализируют именно её.
3. **Состав работ**, **Условия компании**, **База основных рисков**, **Таблица характеристик** — заполнить (или отредактировать готовое из seed).
4. **Стадии анализа** (LLM-агент, прогон фоновый — портал опрашивает статус и сам показывает результат):
   - **Стадия 1** (ТЗ + Чек-лист + ВОР): запустить → пройти таблицу решений (принять / редактировать / отклонить / удалить из ТЗ) → завершить стадию.
   - **Стадия 2** (Q&A + Характеристики): загрузить `.xlsx` Q&A формы → запустить анализ (сверка ТЗ с решениями Q&A и таблицей характеристик) → пройти таблицу → завершить.
   - **Стадия 3** (существенные условия компании): запустить → пройти таблицу (агент выносит места ТЗ, противоречащие условиям компании) → завершить.
   - **Стадия 4** (типовые риски): запустить → пройти таблицу (прямые/косвенные упоминания рисков с экономическими последствиями для ГП) → завершить.
   - **Стадия 5** (самоанализ ТЗ: скрытые работы, двусмыслия, влияние на срок): запустить → пройти таблицу → завершить.
5. **Итог**: единый сводный результат — находки всех стадий, сведённые по одному месту ТЗ в группы (главное решение по критичности + конфликты). Один результат вместо пяти разрозненных голосов.
6. **Рецензия** (опционально): сквозной режим прохода всех `pending`-замечаний по всем стадиям.
7. **Экспорт**: скачать ТЗ.docx с правками (Track Changes) и комментариями. На одно место ТЗ — одно решение (primary). Дополнительно: HTML-preview, CSV/JSON/Markdown.

Каждое решение «удалить из ТЗ» / «вынести из объёма» **исключает фрагмент из активного текста** для следующих стадий. Возврат к предыдущей стадии **каскадно сбрасывает** все стадии после неё (с подтверждением).

---

## Q&A форма (Стадия 2): xlsx-формат

Один лист. Импортёр сам находит строку заголовков и распознаёт колонки по ключевым словам (регистр не важен, порядок свободный). Распознаются:

| Логическое поле | Ключ в заголовке | Обязательность |
|-----------------|------------------|----------------|
| Вопрос | `вопрос` | обязательна |
| Ответ | `ответ` | обязательна |
| Раздел | `раздел` | опционально |
| Принятое решение | `решен…` | опционально |
| Дата отправки | `дата` (первая) | опционально |
| Дата получения | `получен` / `дата` (вторая) | опционально |

Каждая строка с вопросом и ответом → запись в `qa_entries`. Строки, начинающиеся с «Направлено…», трактуются как метка раунда переписки.

> **Характеристики** — это отдельный стандартный шаблон таблицы (`characteristicsTemplate.js`), который инженер заполняет на вкладке «Таблица характеристик». Из Q&A xlsx они **не** импортируются.

В демо-данных записи Q&A создаются напрямую сидом (готового QA.xlsx-файла нет) — Стадию 2 на демо-тендере можно запускать без загрузки xlsx.

---

## Что работает / Что следующая задача

| Возможность | Статус |
|-------------|--------|
| CRUD тендеров, документов, чек-листа, условий, рисков, характеристик, Q&A | ✅ Реализовано |
| Извлечение текста (.docx / .pdf / .xlsx / .txt / .md) | ✅ Реализовано |
| Структурный импорт ВОР из xls/xlsx (`vor_items`): номер позиции, шифр, раздел, наименование, единица, количество, примечание, лист, строка и адреса ячеек; объединённые ячейки, синонимы колонок, нормализация чисел и единиц | ✅ Реализовано |
| Большой ВОР идёт в анализ ПАКЕТАМИ (а не выбрасывается по лимиту символов); «нет в ВОР» — только по пересечению всех пакетов; готовый вход сопоставления ТЗ ↔ ВОР ↔ чек-лист | ✅ Реализовано |
| Стадии 1–4 — LLM-агенты по тексту ТЗ (Чек-лист+ВОР, Q&A+характеристики, Условия компании, Риски) | ✅ Реализовано |
| Конвейер анализа: signals → draft_issues → critic → clustering → self-analysis (Стадия 5 = QC над итогом, issues не порождает) | ✅ Реализовано |
| Оркестратор конвейера: пересборка слоёв одним вызовом + статус свежести слоёв (`pipeline/run`, `pipeline/status`) | ✅ Реализовано |
| Фоновый прогон стадии + опрос статуса (снимает таймауты на долгих ТЗ) | ✅ Реализовано |
| Устойчивая очередь фоновых задач в Postgres (`analysis_jobs`/`analysis_tasks`): отдельный воркер, `FOR UPDATE SKIP LOCKED`, idempotency-key, heartbeat + аренда, retry, checkpoint, cancel, прогресс в БД, advisory-lock на (стадия+ревизия), продолжение или `interrupted` после рестарта | ✅ Реализовано |
| 3 режима системного промта на стадию (`structural`/`strict`/`full`) через env | ✅ Реализовано |
| Реестр Issue + рецензия по стадиям + сквозной reviewer | ✅ Реализовано |
| Зоны ответственности агентов (реестр `problem_type` на стадию) + гард домена | ✅ Реализовано |
| Рецензия и ВСЕ выгрузки от кластеров: одно решение на кластер (`review_decisions.cluster_id`) → docx / preview / review.md / CSV / JSON / summary.md (этапы 6–7) | ✅ Реализовано |
| Слой сборки итога по issues (группы primary/конфликты, `review/consolidated`) — legacy-fallback | ✅ Реализовано |
| Каскадный сброс стадий, исключение фрагментов из активного текста | ✅ Реализовано |
| Экспорт `.docx` с **настоящими Track Changes** (`w:ins`/`w:del`) + Word-комментарии | ✅ Реализовано |
| Единый «вид решения» в preview / таблице / docx (delete vs «вынести из объёма» различаются) | ✅ Реализовано |
| Пер-issue отчёт экспорта (`applied`/`fallback`/`failed`/`skipped`) + fallback на комментарий | ✅ Реализовано |
| Устойчивое сопоставление `.md↔.docx` при экспорте (терпимо к пробелам → таблицы по ячейкам → нечёткий → комментарий-фолбэк) | ✅ Реализовано |
| Стадия 4: анти-триггеры рисков + quality scoring (порог `STAGE4_MIN_SCORE`) — меньше ложных совпадений | ✅ Реализовано |
| Регресс-набор: экспорт (абзац / список / таблица / мультиформат / повтор) + scoring Стадии 4 — `npm test` | ✅ Реализовано |
| HTML-preview рецензии (cluster-primary, issue-fallback) | ✅ Реализовано |
| CSV / JSON / Markdown summary экспорты (cluster-primary, issue-fallback, `X-Export-Source`) | ✅ Реализовано |
| Q&A форма прямо в портале (вместо xlsx-загрузки) | ⚙️ Контракт `qaImportService` совместим. Следующая задача — UI-страница ввода. |
| A/B-тюнинг промтов стадий и калибровка режимов на реальных ТЗ | ⚙️ Инфраструктура (3 режима + env) готова; нужен прогон на корпусе ТЗ. |

### Как устроен анализатор

Все 5 стадий — **LLM-агенты**. Каждая стадия = пара файлов в `server/services/stageAnalysis/`:
`stageN_llm.js` (логика стадии + JSON-схема находки) и `stageNPrompts.js` (системный промт: общий блок `SHARED` + блок режима `structural`/`strict`/`full`, переключатель `STAGE{N}_PROMPT_VARIANT`, дефолт `structural`). Общий каркас (фильтр boilerplate → иерархическая сегментация ТЗ → вызов LLM по частям → межраздельная сверка → локализация фрагмента в `.docx`-абзацах) — в `shared/llmStage.js`. LLM-вызов идёт через `llm/openaiClient.js` (OpenAI-совместимый, structured output по JSON Schema); в dev — через локальный Claude-bridge.

#### Большое ТЗ: иерархическая token-aware сегментация

Документ **не подаётся в модель одним куском** — ни на одной стадии. `shared/segmentation.js` режет ТЗ на три уровня:

1. **Блок крупнее бюджета** дробится по границам предложений с перекрытием (`paragraph_index` сохраняется, поэтому локализация цитаты не ломается);
2. блоки собираются в **пункты**: заголовок — граница, нумерованный пункт («3.4.1 …», «а)», «-») начинает новый, списки и строки таблиц прилипают к текущему (таблица не рвётся построчно);
3. пункты пакуются в **части под токенный бюджет** (`STAGE_SEGMENT_TOKENS`, дефолт 20 000) с предпочтением границ разделов, с **перекрытием** хвоста предыдущей части и с **заголовочным контекстом** в шапке (`> Контекст раздела: 3. Работы › 3.4 Отделка`).

Перекрытие закрывает главный риск нарезки: требование, разорванное границей, читается целиком хотя бы в одной части (регресс-тест — `server/test/unit/segmentation.test.js`, риск ставится ровно на стык).

**Стадии 2 и 3 больше не требуют весь документ в одном контексте**: справочники (Q&A + характеристики, существенные условия) повторяются в каждой части, а связи между разделами закрывает финальная **межраздельная сверка** (`shared/crossSegmentReview.js`) — детерминированный дедуп «швов» + LLM-шаг, который убирает повторы одного места ТЗ и помечает противоречия/связи между разделами (повысить критичность может, понизить — нет). **Стадия 5** (QC) тоже идёт по частям — прежнее усечение ТЗ первыми 200 000 символов убрано.

**Результат и статус каждой части** лежат в `analysis_segments` (part, раздел, диапазон блоков, размер, `status`, попытки, ошибка, находки). Отсюда два следствия: повтор стадии не переспрашивает модель про уже посчитанные части (сверка по `input_hash`), а упавшую часть можно **пересчитать точечно** — `POST /api/tenders/:id/stages/:n/segments/:idx/retry` (debug-страница `/tenders/:id/debug/segments`).

Каждое замечание дословно цитирует фрагмент ТЗ (`source_fragment`) и несёт `basis` (почему это проблема), `criticality`, `suggested_action` и `suggested_redaction` — инженер видит обоснование и может выбрать своё решение.

**Стадия 4 (типовые риски)** дополнительно фильтрует шум: у рисков есть `negative_triggers` (анти-триггеры — контексты, где упоминание не является риском), а каждая находка проходит quality scoring (`stage4Scoring.js`) — галлюцинированные ключи рисков, срабатывания анти-триггеров и слабые/необоснованные совпадения отсекаются ниже порога `STAGE4_MIN_SCORE`; `basis` обязан называть конкретное денежное/объёмное/срочное последствие для ГП.

> Прежний rule-based слой (файлы `stage*_*.js` без суффикса `_llm`, `shared/phrases.js`) удалён — стадии анализа полностью LLM-агентные. История доступна в git.

---

## Конвейер анализа (signals → draft_issues → critic → clustering → self-analysis)

Поверх 5 стадий работает **основной конвейер анализа** из 5 слоёв. Стадии 1–4 — это
**добытчики находок** (LLM-агенты по тексту ТЗ); конвейер — **сборка**: сводит находки
всех стадий в единый, отранжированный, сгруппированный и проверенный на полноту поток
замечаний. Каждый слой — отдельная таблица + сервис + контроллер + роут + debug-страница +
офлайн-тест чистых функций без БД.

```
  Стадии 1–4 (LLM-агенты по тексту ТЗ)
        │  issueRecords (+ таблица issues — backbone решений/экспорта)
        ▼
1. signals ─▶ 2. draft_issues ─▶ 3. critic ─▶ 4. clustering ─▶ 5. self-analysis
analysis_signals  draft_issues   issue_reviews  issue_clusters    self_analysis_results
                                                issue_cluster_items
```

| Слой | Таблица(ы) | Сервис | Что делает |
|------|-----------|--------|------------|
| **1. signals** | `analysis_signals` | `services/signals/signalWriter.js` | Best-effort писатель: после каждой стадии 1–4 складывает её находки в единый поток сигналов (`signal_type`: 1=coverage, 2=decision, 3=condition, 4=risk). Изолирован — сбой писателя не влияет на закоммиченные issues и статус стадии. |
| **2. draft_issues** | `draft_issues` | `services/unifiedAnalysis/unifiedIssueBuilder.js` | Единый анализатор: сводит сигналы одного места ТЗ в один черновой draft_issue (`buildDraftIssues`). |
| **3. critic** | `issue_reviews` | `services/critic/criticService.js` | Оценивает значимость draft_issue для генподрядчика, ставит `display_priority` (critical/high/medium/low) и `show_to_engineer` (мягкое скрытие low, без удаления) (`buildIssueReviews`). |
| **4. clustering** | `issue_clusters` + `issue_cluster_items` | `services/clustering/clusteringService.js` | Сводит ПОХОЖИЕ замечания одного места ТЗ в кластер по `placeKey` (tz_clause → абзац → фрагмент) × доминирующему измерению значимости (цена/срок/договор/ответственность) × семейству действия (remove/edit/note). Разные по смыслу проблемы одного пункта (открытый объём ≠ риск оплаты) дают РАЗНЫЕ кластеры — основание каждого сохраняется (`buildClusters`). |
| **5. self-analysis** | `self_analysis_results` | `services/selfAnalysis/selfAnalysisService.js` | **Стадия 5** в новой роли — QC/полнота над итогом (не второй поток issues). Проверяет готовые кластеры + исходный ТЗ: `missed_coverage` (что пропустили) · `weak_cluster` (слабое основание) · `cluster_contradiction` (конфликт кластеров одного места) · `needs_enrichment` (усилить важный кластер). Эвристики + best-effort LLM (`buildSelfAnalysis`). |

Слой 1 (signals) пишется **автоматически** движком после каждой стадии 1–4. Слои 2–5 идемпотентны
и запускаются явно (`POST …/build`); читаются с фильтром важности (`?mode=important|working|full`).
Стадия 5 (`POST …/self-analysis/build`, она же `runStage5SelfAnalysis` в движке) **сама достраивает
конвейер** через `ensureClusters` — если кластеров ещё нет, прогоняет draft_issues → critic →
clustering из сигналов, затем делает QC. Группировка/слияние/эвристики во всех слоях — чистые
функции, покрытые офлайн-тестами (`npm test`).

**Оркестратор конвейера** (`services/pipeline/analysisPipeline.js`) пересобирает слои 2–5 одним
вызовом — `POST /api/tenders/:id/pipeline/run` (тело `{ with_self_analysis: false }` — без
QC-шага, единственного с LLM). Порядок шагов фиксирован зависимостями; после сбоя шага оставшиеся
помечаются `skipped`, отчёт прогона предсказуем (`{ ok, failed_step, steps[] }` со статусом
`done|failed|skipped` и `summary` слоя на каждый шаг — как у отчёта экспорта, сбой шага не
превращается в HTTP-ошибку).

**Исход прогона хранится, а не выводится заново.** При завершении (активация /
закрытие без активации / провал) весь отчёт пишется в `analysis_runs.summary`:
`status` (`completed` | `completed_with_warnings` | `failed`), `warnings` и причины
частичного результата (`partial`), `failed_step`, `steps[]`, **manifest входных
stage-прогонов**, `started_at` / `finished_at`. Узкая колонка `analysis_runs.status`
знает только `completed|failed|running` и не различает частичный итог, поэтому
источник истины — сохранённый отчёт (`buildRunOutcome` / `parseRunOutcome`).
`GET /api/tenders/:id/pipeline/status` отдаёт: свежесть слоёв (счётчик + время
сборки + `stale` на слой, сводный `needs_rebuild`), `active_run` (прогон под
указателем), `last_run` (**последний прогон оркестратора, в т.ч. неуспешный** —
провалившийся указателем не становится, но его исход обязан быть виден) и верхним
уровнем `status` / `severity` / `warnings` / `partial` / `failed_step` /
`stage_inputs`. После перезагрузки страницы и рестарта процесса портал показывает
ТОТ ЖЕ исход, что был зафиксирован при завершении. Тесты —
`server/test/unit/pipeline.test.js` (успех / частичный / сбой + повторное чтение)
и `server/test/integration/pipelineOutcome.integration.test.js` (круг через Postgres).

**Debug-страницы** (по прямому URL, без пункта меню): `/tenders/:id/debug/signals|draft-issues|issue-reviews|clusters|self-analysis|pipeline` — зарегистрированы в `client/src/App.jsx`, методы API — в `client/src/services/api.js`.

> **Source of truth (этапы 6–7).** Главная цепочка результата:
> `signals → draft_issues → issue_reviews → issue_clusters → review_decisions(cluster_id) → export`.
> Инженер принимает **одно решение на кластер**; из кластерных решений собираются ВСЕ выгрузки:
> `.docx` с Track Changes, HTML-preview, review.md, CSV/JSON/summary.md и экраны «Рецензия»/«Итог».
> Issue-level путь (`issues` + `review_decisions.issue_id`) остаётся для пер-стадийной рецензии
> внутри стадий 1–4 (включая `tz_excluded_ranges`) и как **legacy-fallback** выгрузок — когда
> кластеров/кластерных решений нет или запрошен явный `?source=issues` (фактический источник —
> в заголовке `X-Export-Source`). Подробности потоков и source-of-truth — в
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Очередь фоновых задач (analysis_jobs → analysis_tasks)

Долгие прогоны (анализ стадии — до ~15 минут, пересборка конвейера) выполняются **не
внутри HTTP-запроса и не в памяти процесса**, а через устойчивую очередь в Postgres.
Redis не нужен: всё состояние — две таблицы и `FOR UPDATE SKIP LOCKED`.

```
POST …/stages/:n/run ──▶ analysis_jobs (ЗАДАНИЕ: идемпотентность, отмена, прогресс)
                             └── analysis_tasks (ЗАДАЧА: claim, аренда, попытки, чекпойнт)
                                        ▲
                       claim (SKIP LOCKED) │        ┌── worker #1 (в процессе сервера)
                                        └──────────┤── worker #2 (npm run worker)
                                                    └── worker #3 (другая машина)
```

| Свойство | Как обеспечено |
|----------|----------------|
| **Без дублей** | Задачу забирает ровно один воркер: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Параллельные воркеры не ждут друг друга и никогда не получают одну строку. |
| **Повторный запуск** | Ключ идемпотентности = тендер + область + ревизия документов + версия конфигурации. Пока задание живо, повторный POST возвращает то же задание. Гонку одновременных запросов разрешает частичный `UNIQUE`-индекс в БД, а не приложение. Клиент может прислать свой `Idempotency-Key`. |
| **Одна стадия — один прогон** | На время работы воркер держит session-level `pg_try_advisory_lock` по (тендер + область + ревизия). Занято — задача возвращается в очередь, попытка не расходуется. Работает между процессами и машинами; умер процесс — Postgres освободит замок сам. |
| **Heartbeat + аренда** | Воркер продлевает `lease_expires_at`; не продлил (упал/убит/потерял сеть) — задача считается осиротевшей. Воркер, потерявший аренду, не может закоммитить результат: все переходы условны по `locked_by`. |
| **Retry** | Временные сбои (5xx, обрыв LLM) — повтор с экспоненциальной задержкой. 4xx (гейт стадии, нет Q&A) не повторяются: результат тот же. |
| **Checkpoint** | Стадия сохраняет каждую посчитанную часть ТЗ дважды: в `analysis_tasks.checkpoint_json` (в пределах задачи) и в `analysis_segments` (переживает задание, сверка по `input_hash`). Повтор после падения **не переспрашивает LLM** про уже сделанное, а одну часть можно пересчитать точечно. Конвейер чекпойнтится шагами: успешный шаг не пересобирается. |
| **Cancel** | `POST /api/jobs/:jobId/cancel` — задачи в очереди снимаются сразу, бегущая прерывается кооперативно на ближайшем heartbeat. |
| **Прогресс** | `progress_total/progress_done` пишутся в БД (кольцо прогресса в портале переживает рестарт и видно из любого процесса). |
| **После рестарта** | Осиротевшие задачи либо **продолжаются** (возврат в очередь + чекпойнт), либо получают статус **`interrupted`**, когда попытки исчерпаны, — и задание, и стадия чинятся: `stageN_status` возвращается в `open`, в `analysis_runs` пишется терминальный прогон. |

Воркер по умолчанию поднимается **внутри** процесса сервера (`WORKER_MODE=embedded`) — как
и раньше, «запустил `npm run dev` — анализ работает». Для разнесения по процессам:

```bash
WORKER_MODE=external npm --prefix server start   # только API
npm run worker                                   # воркер (можно несколько)
```

Тесты: `server/test/unit/jobsModel.test.js` (правила), `jobsWorker.test.js` (цикл воркера
на фейковом сторе, офлайн) и `server/test/integration/jobs.integration.test.js` (живой
Postgres: два процесса-воркера, SKIP LOCKED, advisory-lock, рестарт, отсутствие дублей).

---

## Принятые инженерные решения

1. **LLM-агенты, не rule-based**: каждая стадия — отдельный системный промт (роль ГП) + общий каркас `shared/llmStage.js`. Три режима промта (`structural`/`strict`/`full`) переключаются env без правок кода.
2. **LLM через OpenAI-совместимый клиент**: в dev — локальный `claudeBridge.js` (Claude Agent SDK), в проде — любой OpenAI-совместимый эндпоинт через `OPENAI_BASE_URL`. Стадии не знают, кто за клиентом.
3. **Postgres / Supabase** (`pg`), не SQLite: единая обёртка `db/connection.js` с async API (`queryOne/queryAll/queryRun/exec/transaction`) и SQLite-style плейсхолдерами (`?` → `$1`).
4. **Анализ по `.md`-копии ТЗ**: Markdown даёт стабильные заголовки/абзацы для сегментации и точной локализации цитат; экспорт правок при этом идёт в исходный `.docx`.
5. **Tailwind**, не CSS modules: один источник правды, минимум boilerplate.
6. **Zustand**, не Context API/Redux: меньше шума.
7. **pizzip + @xmldom/xmldom**, не `docx` npm: модификация исходного .docx даёт настоящий «Word Review feel» (правки и комментарии в Word, исходное форматирование сохранено). `docx` npm генерирует с нуля и не подходит для главного юзкейса.
8. **Настоящий Track Changes**: `delete`/`remove_from_scope` → `w:del`, `edit` → `w:del`+`w:ins`, решение «Примечание» → Word-комментарий. Запасной путь при сбое track-change — Word-комментарий (`status='fallback'` в отчёте экспорта). (Раньше удаления показывались `<w:strike/>`; `strikeWriter.js` удалён.)
9. **«Исключение из активного текста»** = только Issue с действием `delete` / `remove_from_scope` исключает фрагмент для следующих стадий. Остальные принятые правки видимы и попадают в `.docx`.
10. **Каскадный сброс** при возврате к предыдущей стадии: гарантирует консистентность экспорта.
11. **Q&A через xlsx**: упрощает текущую итерацию, отдельный UI на портале — следующая задача.

---

## REST API

```
POST   /api/tenders                                  create
GET    /api/tenders                                  list (search, status, type)
GET    /api/tenders/:id                              full payload + stage_state
PATCH  /api/tenders/:id
DELETE /api/tenders/:id

POST   /api/tenders/:id/documents                    multer upload
GET    /api/tenders/:id/documents
GET    /api/documents/:id/download
GET    /api/documents/:id/text
DELETE /api/documents/:id

GET    /api/tenders/:id/checklist
POST   /api/tenders/:id/checklist
PATCH  /api/tenders/:id/checklist/:itemId
DELETE /api/tenders/:id/checklist/:itemId

GET/POST/PATCH/DELETE /api/tenders/:id/conditions[/:itemId]
GET/POST/PATCH/DELETE /api/tenders/:id/risks[/:itemId]
GET    /api/risks/global
GET/PATCH             /api/tenders/:id/setup/params          — параметры тендера (тип договора, аванс, эскалация, сроки)
GET/PATCH             /api/tenders/:id/setup/locks           — блокировки шагов настройки

POST   /api/tenders/:id/qa/import                    multer .xlsx
GET    /api/tenders/:id/qa
GET    /api/tenders/:id/characteristics
PATCH  /api/characteristics/:charId

GET    /api/tenders/:id/stages
POST   /api/tenders/:id/stages/:n/run                в очередь: сразу {status:'running', job_id}, статус через GET /stages
                                                     (заголовок Idempotency-Key — повторный запрос не создаёт дубль)
POST   /api/tenders/:id/stages/:n/finish
POST   /api/tenders/:id/stages/:n/reset
GET    /api/tenders/:id/stages/:n/issues             ?criticality=&review_status=&problem_type=
GET    /api/tenders/:id/stages/:n/segments           части ТЗ стадии: статус/попытки/находки каждой
POST   /api/tenders/:id/stages/:n/segments/:idx/retry пересчитать ОДНУ часть (остальные — из сохранённых)

PATCH  /api/issues/:id                               review_status, edited_redaction, selected_for_export
POST   /api/issues/:id/decision                      {decision, edited_redaction, final_comment}

# Финальная рецензия (этапы 6–7): одно решение на кластер
POST   /api/tenders/:id/review/clusters/build        достроить конвейер до кластеров (?force=1 — пересобрать)
GET    /api/tenders/:id/review/clusters              кластеры + решения + draft_issues + self-analysis
POST   /api/tenders/:id/review/clusters/:cid/decision {decision, edited_redaction, final_comment, target_text}

# Выгрузки: cluster-primary, issue-fallback (?source=issues — принудительно legacy;
# фактический источник — заголовок X-Export-Source)
GET    /api/tenders/:id/review/preview               HTML-preview рецензии
GET    /api/tenders/:id/export/docx                  ТЗ.docx с Track Changes
GET    /api/tenders/:id/export/docx/report           отчёт экспорта (applied/fallback/failed/skipped, source)
GET    /api/tenders/:id/export/issues.csv            CSV-реестр (от кластеров; legacy — реестр issues)
GET    /api/tenders/:id/export/issues.json
GET    /api/tenders/:id/export/summary.md
GET    /api/tenders/:id/export/review.md             review.md со всеми правками
GET    /api/tenders/:id/review/consolidated          legacy-итог по issues (fallback/back-compat)

# Конвейер анализа (signals → draft_issues → critic → clustering → self-analysis)
GET    /api/tenders/:id/signals                      поток сигналов стадий 1–4 (?signal_type=)
POST   /api/tenders/:id/unified/build                собрать draft_issues из сигналов
GET    /api/tenders/:id/draft-issues
POST   /api/tenders/:id/critic/build                 оценить значимость draft_issues
GET    /api/tenders/:id/issue-reviews                ?mode=important|working|full
POST   /api/tenders/:id/clustering/build             сгруппировать похожие замечания
GET    /api/tenders/:id/issue-clusters               ?mode=important|working|full
POST   /api/tenders/:id/self-analysis/build          QC/полнота над кластерами (Стадия 5)
GET    /api/tenders/:id/self-analysis                ?finding_type=missed_coverage|weak_cluster|cluster_contradiction|needs_enrichment
POST   /api/tenders/:id/pipeline/run                  пересобрать слои 2–5 одним вызовом ({with_self_analysis:false} — без QC-шага;
                                                      {async:true} — не ждать, задание уходит в очередь → 202 {job})
GET    /api/tenders/:id/pipeline/status               свежесть слоёв + сохранённый исход прогона (active_run/last_run, status/warnings/partial/failed_step/stage_inputs)

# Очередь фоновых задач (analysis_jobs / analysis_tasks)
GET    /api/tenders/:id/jobs                          задания тендера (?status=&limit=) с задачами и прогрессом
POST   /api/tenders/:id/jobs                          поставить задание вручную ({type:'stage_analysis'|'pipeline', ...})
GET    /api/jobs/:jobId                               задание + задачи (статус, попытки, аренда, прогресс, чекпойнт)
POST   /api/jobs/:jobId/cancel                        отменить (очередь — сразу, бегущая задача — на heartbeat)
GET    /api/jobs/queue/stats                          сводка очереди по статусам задач
```

> `:n` — номер стадии 1..5. Прогон стадии асинхронный: `POST …/run` возвращает `{status:'running'}` и анализ идёт в фоне; клиент опрашивает `GET …/stages` (поле `stageN_status`: `open`/`running`/`reviewing`/`finished`).

---

## Демо-данные

`server/db/seed.js` создаёт:
- 2 тендера: «ЖК Северный — Корпус 5 (монолит + кладка)» (тип `shell`) и «ЖК Заречный — генподряд полного цикла» (тип `general_contract`).
- Для «Северного»: ТЗ.docx + ВОР.xlsx + ПД.txt + чек-лист (часть позиций «в объёме», часть — нет) + параметры тендера/условия + 5 записей Q&A.
- Для «Заречного»: ТЗ.docx + незаполненный чек-лист + параметры тендера.

Демо-данные подгружаются автоматически при первом запуске на пустой БД. Принудительный пересеев:
```bash
npm run seed   # выполняет: node server/db/seed.js -f
```

---

## Тест-сценарий end-to-end

1. Настроить `.env` (`DATABASE_URL` + LLM), затем `npm run install:all && npm run dev` → открыть `http://localhost:5173`.
2. Видны 2 demo-тендера → открыть «ЖК Северный».
3. Таб **Документы**: загруженные файлы, статус «текст извлечён». Для анализа должна быть `.md`-копия ТЗ в слоте «ТЗ → Markdown».
4. Табы **Состав работ / Условия / Риски / Таблица характеристик** — данные заполнены.
5. Таб **Стадии**:
   - Стадия 1 → «Запустить анализ» → дождаться (прогон фоновый) → принять/отредактировать/удалить из ТЗ → «Завершить стадию».
   - Стадия 2: загрузить Q&A `.xlsx` (или использовать данные сида) → «Запустить анализ» → решения → «Завершить».
   - Стадия 3 (условия компании) → запустить → решения → завершить.
   - Стадия 4 (типовые риски) → запустить → решения → завершить.
   - Стадия 5 (самоанализ) → запустить → решения → завершить.
6. Проверить **каскадный сброс**: вернуться к Стадии 2 → подтвердить → стадии 3–5 очищаются.
7. Таб **Экспорт** → «Скачать ТЗ.docx с правками» → открыть в Word: удаления/правки видны как Track Changes (область рецензирования), «Примечания» — как Word-комментарии.
8. «Открыть HTML-preview» → корректно отрисовывается в браузере.
9. CSV / JSON / Markdown — скачиваются, открываются.

---

## Ограничения MVP

- LLM-анализ требует настроенного доступа к модели (`OPENAI_*` либо локальный bridge). Без ключа/bridge стадии не запускаются (понятная 400).
- Подписочный путь через Claude-bridge не держит параллель (троттлинг/таймауты) — стадии идут последовательно, дефолт `STAGE_LLM_CONCURRENCY=1`; крупные ТЗ обрабатываются фоново.
- Анализ ведётся по `.md`-копии ТЗ; главный экспорт `.docx` работает, если оригинал ТЗ загружен в `.docx`. Если ТЗ только в PDF — используйте HTML-preview/CSV/JSON.
- Q&A форма принимается только через xlsx-загрузку. UI прямо в портале — следующая задача.
- Нет аутентификации/авторизации — это локальный инструмент инженера, не SaaS.
- Адаптивность desktop-first; на мобильных таблицы прокручиваются.
