# TZ-Opti

MVP-портал для инженера тендерного отдела строительной компании. Анализирует техническое
задание (ТЗ) на строительно-монтажные работы (СМР) через последовательный пайплайн из **5 стадий**
на LLM-агентах и экспортирует исходный `.docx` с настоящими правками Word (Track Changes) и
комментариями в логике Word Review.

---

## Что это и для кого

Инженер тендерного отдела участвует в тендерах на жилые комплексы (генподряд / «коробка»). По
каждому тендеру нужно сверить ТЗ с собственными данными компании и подготовить итоговый файл с
замечаниями. Портал собирает все материалы в одной карточке тендера и проводит инженера через
5 стадий анализа. Результат — исходный ТЗ.docx, в который встроены правки Word и комментарии по
принятым инженером решениям.

---

## Стек

- **Frontend** (`client/`): Vite, React 18, JavaScript (без TypeScript), React Router, Tailwind CSS,
  Zustand.
- **Backend** (`server/`): Node.js, Express, **PostgreSQL через `pg`** (подключение по `DATABASE_URL`,
  совместимо с Supabase), Multer (загрузка файлов).
- **LLM**: OpenAI-совместимый клиент (`server/services/stageAnalysis/llm/openaiClient.js`),
  structured output по JSON Schema. В dev — локальный Claude-bridge
  (`server/devtools/claudeBridge.js`), в проде — любой OpenAI-совместимый эндпоинт через
  `OPENAI_BASE_URL`.
- **Извлечение текста**: mammoth (`.docx`), pdf-parse (`.pdf`), xlsx (`.xlsx`), нативный fs
  (`.txt` / `.md` / `.csv`).
- **Экспорт `.docx`**: pizzip + @xmldom/xmldom + xpath — модификация исходного `.docx` с настоящими
  Word Track Changes (`w:ins` / `w:del`) и Word-комментариями.

Хранилище — только **PostgreSQL**. Единая обёртка `server/db/connection.js` даёт асинхронный API
(`queryOne` / `queryAll` / `queryRun` / `exec` / `transaction`) с `?`-плейсхолдерами, которые
конвертер автоматически превращает в `$1, $2, …`.

---

## Архитектура

```
┌─────────────────┐         REST JSON          ┌──────────────────────┐
│  client (Vite)  │ ◀─────────────────────────▶│  server (Express)    │
│  :5173          │                             │  :4000               │
│  React + JS     │                             │  pg → PostgreSQL     │
│  Tailwind +     │                             │  Multer • mammoth    │
│  Zustand        │                             │  xlsx • pdf-parse    │
│  React Router   │                             │  pizzip + xmldom     │
└─────────────────┘                             └─────┬───────────┬────┘
                                                      │           │
                              OpenAI-совместимый ▼    │           ▼
                          ┌──────────────────────────┐    ┌──────────────────────┐
                          │ LLM bridge (dev) :4010   │    │ PostgreSQL / Supabase│
                          │ claudeBridge.js → Claude │    │ (DATABASE_URL)       │
                          │ Agent SDK                │    │ server/uploads/      │
                          └──────────────────────────┘    └──────────────────────┘
```

Клиент общается с сервером по REST JSON (Vite-прокси `/api` → `:4000`). Сервер хранит всё в
PostgreSQL и вызывает LLM через OpenAI-совместимый клиент. В dev LLM-вызовы идут в локальный
`claudeBridge.js`; в проде `OPENAI_BASE_URL` направляется на нужный эндпоинт.

---

## Запуск

Требуется Node.js ≥ 18.

```bash
# 1. Установить зависимости root + server + client
npm run install:all

# 2. Создать .env в корне репозитория (шаблон — .env.example).
#    Обязательно: DATABASE_URL (PostgreSQL/Supabase) и доступ к LLM.

# 3. Запустить dev: server :4000, client :5173, LLM-bridge :4010
npm run dev
```

Откроется `http://localhost:5173`. **На старте сервер сам применяет миграцию и при пустой БД
подгружает демо-данные** (см. ниже «Миграции и seed»).

### Скрипты

| Скрипт | Действие |
|--------|----------|
| `npm run install:all` | `npm install` в root, server и client |
| `npm run dev` | concurrently: server + client + bridge (3 процесса) |
| `npm run dev:server` | только сервер (`:4000`) |
| `npm run dev:client` | только клиент (`:5173`) |
| `npm run bridge` | только LLM-bridge (`node server/devtools/claudeBridge.js`) |
| `npm run seed` | принудительный пересев демо-данных (`server/db/seed.js -f`) |
| `npm run build` | production-сборка клиента |
| `npm test` | регресс-тесты сервера (`node --test`, без БД и LLM) |

---

## Конфигурация (`.env`)

Один `.env` в корне репозитория (шаблон — `.env.example`). Сервер грузит его из корня через
`dotenv` (относительно `server/app.js`).

| Переменная | Назначение |
|------------|------------|
| `DATABASE_URL` | Строка подключения PostgreSQL. **Без неё сервер не стартует.** Для Supabase рекомендуется pooler `*.pooler.supabase.com:6543` (прямой `db.<ref>.supabase.co` работает только по IPv6). |
| `PORT` | Порт сервера (дефолт `4000`). |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | Каталог и лимит загрузок Multer. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Доступ к LLM (реальный OpenAI). |
| `OPENAI_BASE_URL` | Опционально: OpenAI-совместимый эндпоинт. Для dev-bridge — `http://127.0.0.1:4010/v1`. |
| `STAGE{1..5}_PROMPT_VARIANT` | Режим системного промта стадии: `structural` (дефолт) \| `strict` \| `full`. |
| `STAGE4_MIN_SCORE` | Порог отсева слабых находок quality-scoring в Стадии 4 (дефолт `0.45`). |
| `STAGE_LLM_*`, `BRIDGE_*` | Тюнинг сегментации/таймаутов и bridge — подробности в `server/devtools/README.md`. |

Для локального dev без реального OpenAI: оставить `OPENAI_BASE_URL` на bridge (`:4010`),
`OPENAI_API_KEY` — любая непустая строка.

---

## Миграции и seed

Миграция и сид выполняются **автоматически при старте сервера** (`server/app.js`):

1. `runMigration()` — приводит схему БД к актуальной (`server/db/migrate.js`, базовая
   `server/db/schema.sql`; идемпотентно — досоздаёт недостающие таблицы/колонки).
2. `runSeedIfEmpty()` — на пустой БД заливает демо-данные (`server/db/seed.js`).
3. `recoverOrphanedRunningStages()` — сбрасывает «зомби»-статусы `running` от прогонов, погибших
   при прошлом рестарте сервера.

Принудительный пересев (сброс и повторная заливка демо-данных):

```bash
npm run seed   # → node server/db/seed.js -f
```

Демо: 2 тендера с загруженными ТЗ.docx / ВОР / чек-листом / условиями / записями Q&A — анализ
можно запускать сразу.

---

## Структура проекта

```
TZ-Opti/
├── client/                         Vite + React + Tailwind + Zustand
│   └── src/
│       ├── App.jsx                 роутер
│       ├── pages/                  DashboardPage, TenderOverview, setup/, stages/, analysis/, result/
│       ├── components/             ui, layout, stages, tables, tender, conditions, documents, issues, review, wizard
│       ├── hooks/                  wizard-состояние и пр.
│       ├── store/                  Zustand (тендеры, активный тендер, тосты)
│       ├── services/api.js         REST-клиент
│       └── utils/                  labels (единые названия стадий), format
└── server/                         Express + pg (PostgreSQL) + Multer
    ├── app.js                      миграция + авто-сид + recover на старте, монтаж роутов
    ├── routes/                     tenders, documents, checklist, conditions, risks, qa, stages,
    │                               decisions, review, export, setupLocks, setupParams
    ├── controllers/                тонкие контроллеры под каждый route
    ├── middleware/                 errorHandler, async-errors
    ├── devtools/
    │   ├── claudeBridge.js         локальный OpenAI-совместимый прокси к Claude (dev)
    │   └── README.md               настройка bridge и тюнинг стадий
    ├── services/
    │   ├── textExtractionService.js   извлечение текста (.docx/.pdf/.xlsx/.txt/.md)
    │   ├── tzActiveTextService.js     активный текст ТЗ (.md) за вычетом исключённых фрагментов
    │   ├── mdParser.js                markdown → блоки (заголовки/абзацы/списки/таблицы)
    │   ├── stageAnalysis/
    │   │   ├── stageAnalysisEngine.js   оркестратор 5 стадий (фоновый прогон + статусы + STAGE_LABELS)
    │   │   ├── stage1_llm.js … stage5_llm.js     LLM-агенты стадий (логика + JSON-схема находки)
    │   │   ├── stage1Prompts.js … stage5Prompts.js  системные промты (SHARED + 3 режима)
    │   │   ├── stage4Scoring.js         quality scoring + анти-триггеры Стадии 4
    │   │   ├── llm/openaiClient.js      OpenAI-совместимый клиент (chatJson)
    │   │   └── shared/                  llmStage.js (общий каркас), fragmentMatcher.js
    │   ├── qaImportService.js          парсер Q&A xlsx
    │   ├── qaTzLinkService.js          привязка Q&A к местам ТЗ
    │   ├── risksService.js             библиотека типовых рисков (стандартные + кастомные, overlay)
    │   ├── conditionsRenderer.js       рендер существенных условий компании
    │   ├── characteristicsTemplate.js  стандартный шаблон характеристик
    │   ├── reviewDocx/                 экспорт в .docx (главный артефакт)
    │   │   ├── index.js                оркестратор: решения → правки в .docx + отчёт
    │   │   ├── docxPackage.js          распаковка/сборка .docx (pizzip + xmldom)
    │   │   ├── quoteLocator.js         поиск фрагмента в абзацах (строгий + терпимый матчинг)
    │   │   ├── runSplitter.js          расщепление w:r по границам диапазона
    │   │   ├── trackChangesWriter.js   настоящий Track Changes (w:ins / w:del)
    │   │   ├── commentWriter.js        Word-комментарии (решение «Примечание»)
    │   │   └── manifestUpdater.js      регистрация comments-части в пакете
    │   ├── reviewHtmlService.js        HTML-preview рецензии
    │   ├── exportService.js            CSV / JSON / summary.md
    │   ├── mdReview/renderer.js        review.md со всеми правками
    │   └── review/
    │       ├── decisionModel.js        единый «вид решения» (docx / preview / md)
    │       ├── stageDomains.js         реестр зон ответственности (стадия → свои problem_type)
    │       └── consolidation.js        сборка итога (группы по месту ТЗ / primary / конфликты)
    ├── test/                        node:test — регресс экспорта + scoring Стадии 4
    └── db/
        ├── connection.js           pg-обёртка (async queryOne/queryAll/queryRun/exec/transaction)
        ├── schema.sql              базовая схема
        ├── migrate.js              идемпотентная миграция (старт сервера)
        ├── seed.js                 демо-данные (авто-сид при пустой БД)
        ├── standardRisks.js        15 стандартных типовых рисков (+ анти-триггеры)
        ├── standardChecklist.js    стандартный чек-лист
        ├── conditionsTemplate.js   шаблон существенных условий
        └── fixtures/               ТЗ.docx / ВОР.xlsx генерируются программно
```

---

## 5 стадий анализа

Последовательный пайплайн; названия — единый источник `STAGE_LABELS` в `stageAnalysisEngine.js`
(и `STAGE_META` на клиенте, `client/src/utils/labels.js`):

1. **ТЗ + Чек-лист + ВОР** — покрытие расчёта: что из ТЗ не отражено в чек-листе работ и ВОР
   (входит ли работа в объём генподрядчика).
2. **Q&A** — сверка ТЗ с принятыми бизнес-решениями из Q&A-формы и таблицей характеристик.
3. **Существенные условия** — места ТЗ, противоречащие существенным договорным условиям компании.
4. **Типовые риски** — прямые и косвенные упоминания типовых рисков ТЗ с экономическими
   последствиями для генподрядчика (сверка с библиотекой рисков).
5. **Самоанализ ТЗ** — скрытые работы, двусмысленные формулировки, влияние на срок (по самому ТЗ).

### Как устроен анализатор

Все 5 стадий — **LLM-агенты**. Каждая стадия — пара файлов в `server/services/stageAnalysis/`:
`stageN_llm.js` (логика стадии + JSON-схема находки) и `stageNPrompts.js` (системный промт: общий
блок `SHARED` + один из 3 режимов `structural` / `strict` / `full`, выбор через
`STAGE{N}_PROMPT_VARIANT`, дефолт `structural`). Общий каркас — `shared/llmStage.js`: фильтр
boilerplate-разделов → сегментация ТЗ под бюджет контекста → вызов LLM по сегментам → дедуп →
локализация цитаты в блоках ТЗ. LLM-вызов идёт через `llm/openaiClient.js` (structured output по
JSON Schema); в dev — через локальный Claude-bridge.

Анализ ведётся по **`.md`-копии ТЗ** (слот «ТЗ → Markdown»): markdown даёт стабильные
заголовки/абзацы/таблицы для сегментации и точной локализации цитат. Каждое замечание дословно
цитирует фрагмент ТЗ (`source_fragment`) и несёт `basis` (почему это проблема), `criticality`,
`suggested_action` и `suggested_redaction` — инженер видит обоснование и выбирает своё решение.

**Зоны ответственности.** Каждый агент пишет только в свой домен `problem_type` — реестр
`server/services/review/stageDomains.js`. Решения `delete` / `remove_from_scope` исключают фрагмент
из активного текста для следующих стадий. Возврат к предыдущей стадии каскадно сбрасывает все
стадии после неё.

**Стадия 4 (типовые риски)** дополнительно фильтрует шум: у рисков есть `negative_triggers`
(анти-триггеры — контексты, где упоминание не является риском), а каждая находка проходит quality
scoring (`stage4Scoring.js`) — галлюцинированные ключи рисков, срабатывания анти-триггеров и
слабые/необоснованные совпадения отсекаются ниже порога `STAGE4_MIN_SCORE`.

**Итог.** Слой `review/consolidation.js` сводит находки разных стадий, указывающие на одно место ТЗ,
в группы (primary по критичности + конфликты) — один сводный результат вместо пяти разрозненных.

---

## Рецензия и экспорт

После стадий инженер проходит замечания и принимает решения; решения сохраняются и раскладываются
по документу.

**Решения** (единый «вид решения» — `review/decisionModel.js`, одинаков в docx / preview / md):
- `accept` (Примечание) → Word-комментарий;
- `edit` (Изменить) → `w:del` старого + `w:ins` нового;
- `delete` (Удалить) → `w:del`;
- `remove_from_scope` (Вынести из объёма) → `w:del` + комментарий-метка «Вынесено из объёма»;
- `reject` (Отклонить) → не экспортируется.

**Экспорт `.docx`** (`server/services/reviewDocx/`) — главный артефакт: берётся исходный ТЗ.docx, в
него вносятся настоящие Word Track Changes и комментарии. Исходное форматирование сохраняется.

**Честно о сопоставлении.** `.md` (источник цитат) и `.docx` (цель экспорта) — разные представления
и побайтно не совпадают. Поэтому место правки ищется каскадом с понижением точности:
точное совпадение → терпимое к пробелам/неразрывным пробелам → по ячейкам таблиц → нечёткое
(token-overlap). Если место не нашлось или правка не может лечь как track-change, она **не теряется
молча** — на её месте остаётся Word-комментарий с сутью правки. Это видно в пер-issue отчёте:
`GET …/export/docx/report` со статусами `applied` / `fallback` (через комментарий) / `failed` /
`skipped` (дубликат места — экспортируется одно решение на место).

**Прочие выгрузки:** HTML-preview рецензии, `review.md` со всеми правками, CSV-реестр замечаний
(Excel), JSON-дамп, краткая сводка `summary.md`.

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

GET/POST/PATCH/DELETE /api/tenders/:id/checklist[/:itemId]
GET/POST/PATCH/DELETE /api/tenders/:id/conditions[/:itemId]
GET/POST/PATCH/DELETE /api/tenders/:id/risks[/:itemId]
GET    /api/risks/global
GET/PATCH             /api/tenders/:id/setup/params
GET/PATCH             /api/tenders/:id/setup/locks

POST   /api/tenders/:id/qa/import                    multer .xlsx
GET    /api/tenders/:id/qa
GET    /api/tenders/:id/characteristics
PATCH  /api/characteristics/:charId

GET    /api/tenders/:id/stages
POST   /api/tenders/:id/stages/:n/run                фоновый: сразу {status:'running'}
POST   /api/tenders/:id/stages/:n/finish
POST   /api/tenders/:id/stages/:n/reset
GET    /api/tenders/:id/stages/:n/issues             ?criticality=&review_status=&problem_type=

PATCH  /api/issues/:id                               review_status, edited_redaction, selected_for_export
POST   /api/issues/:id/decision                      {decision, edited_redaction, final_comment}

GET    /api/tenders/:id/review/preview               HTML-preview рецензии
GET    /api/tenders/:id/review/consolidated          экран «Итог» (группы по месту ТЗ)
GET    /api/tenders/:id/export/docx                  ТЗ.docx с Track Changes
GET    /api/tenders/:id/export/docx/report           пер-issue отчёт (applied/fallback/failed/skipped)
GET    /api/tenders/:id/export/issues.csv
GET    /api/tenders/:id/export/issues.json
GET    /api/tenders/:id/export/summary.md
GET    /api/tenders/:id/export/review.md
```

`:n` — номер стадии 1..5. Прогон стадии асинхронный: `POST …/run` возвращает `{status:'running'}` и
анализ идёт в фоне; клиент опрашивает `GET …/stages` (поле `stageN_status`:
`open` / `running` / `reviewing` / `finished`, плюс `locked` для недоступных).

---

## Тесты

```bash
npm test     # node --test, без БД и LLM
```

Покрывают: экспорт в Word на разных структурах (абзац / список / таблица / мультиформат / повтор
текста), устойчивое сопоставление `.md↔.docx` (терпимый матчинг / таблицы по ячейкам / нечёткий /
комментарий-фолбэк), пер-issue отчёт, и quality scoring Стадии 4 (анти-триггеры, порог отсева).

---

## Ограничения MVP

- LLM-анализ требует настроенного доступа к модели (`OPENAI_*` либо локальный bridge). Без него
  стадии не запускаются (понятная ошибка 400).
- Анализ ведётся по `.md`-копии ТЗ; экспорт правок идёт в исходный `.docx`. Если оригинал ТЗ только
  в PDF — используйте HTML-preview / CSV / JSON.
- Q&A-форма принимается через xlsx-загрузку (UI ввода прямо в портале — следующая задача).
- Нет аутентификации/авторизации — это локальный инструмент инженера, не SaaS.
- Адаптивность desktop-first; на мобильных таблицы прокручиваются.
