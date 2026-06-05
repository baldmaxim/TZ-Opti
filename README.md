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

Требуется Node.js ≥ 18.

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
| `npm test` | регресс-тесты экспорта в Word (`node --test`, без БД и LLM) |

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
    ├── app.js                                        — миграция + авто-сид на старте
    ├── routes/            tenders, documents, checklist, conditions, risks, qa,
    │                      stages, decisions, review, export, setupLocks, setupParams
    ├── controllers/       тонкие контроллеры под каждый route
    ├── devtools/
    │   ├── claudeBridge.js                           — локальный OpenAI-совместимый прокси к Claude (dev)
    │   └── README.md                                 — настройка bridge и тюнинг стадий
    ├── services/
    │   ├── textExtractionService.js
    │   ├── tzActiveTextService.js                     — ТЗ за вычетом исключённых фрагментов (.md)
    │   ├── stageAnalysis/
    │   │   ├── stageAnalysisEngine.js                 — оркестратор 5 стадий (фоновый прогон + статусы)
    │   │   ├── stage1_llm.js … stage5_llm.js          — LLM-агенты стадий (логика + схема находки)
    │   │   ├── stage1Prompts.js … stage5Prompts.js    — системные промты (SHARED + 3 режима)
    │   │   ├── stage4Scoring.js                       — quality scoring + анти-триггеры Стадии 4
    │   │   ├── llm/openaiClient.js                    — OpenAI-совместимый клиент (chatJson)
    │   │   ├── shared/llmStage.js                     — общий каркас (сегментация/локализация/дедуп/раннер)
    │   │   ├── shared/fragmentMatcher.js
    │   │   └── (stage*_*.js без _llm — legacy rule-based, superseded, не импортируются)
    │   ├── qaImportService.js                         — парсер Q&A xlsx
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
    │   │   ├── strikeWriter.js                        — legacy fallback (не вызывается)
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
| 5-стадийный LLM-пайплайн (Чек-лист+ВОР, Q&A+характеристики, Условия компании, Риски, Самоанализ) | ✅ Реализовано |
| Фоновый прогон стадии + опрос статуса (снимает таймауты на долгих ТЗ) | ✅ Реализовано |
| 3 режима системного промта на стадию (`structural`/`strict`/`full`) через env | ✅ Реализовано |
| Реестр Issue + рецензия по стадиям + сквозной reviewer | ✅ Реализовано |
| Зоны ответственности агентов (реестр `problem_type` на стадию) + гард домена | ✅ Реализовано |
| Слой сборки итога: находки 5 стадий по одному месту ТЗ → группы (primary/конфликты) + экран «Итог» | ✅ Реализовано |
| Каскадный сброс стадий, исключение фрагментов из активного текста | ✅ Реализовано |
| Экспорт `.docx` с **настоящими Track Changes** (`w:ins`/`w:del`) + Word-комментарии | ✅ Реализовано |
| Единый «вид решения» в preview / таблице / docx (delete vs «вынести из объёма» различаются) | ✅ Реализовано |
| Пер-issue отчёт экспорта (`applied`/`fallback`/`failed`/`skipped`) + fallback на комментарий | ✅ Реализовано |
| Устойчивое сопоставление `.md↔.docx` при экспорте (терпимо к пробелам → таблицы по ячейкам → нечёткий → комментарий-фолбэк) | ✅ Реализовано |
| Стадия 4: анти-триггеры рисков + quality scoring (порог `STAGE4_MIN_SCORE`) — меньше ложных совпадений | ✅ Реализовано |
| Регресс-набор: экспорт (абзац / список / таблица / мультиформат / повтор) + scoring Стадии 4 — `npm test` | ✅ Реализовано |
| HTML-preview рецензии | ✅ Реализовано |
| CSV / JSON / Markdown summary экспорты | ✅ Реализовано |
| Q&A форма прямо в портале (вместо xlsx-загрузки) | ⚙️ Контракт `qaImportService` совместим. Следующая задача — UI-страница ввода. |
| A/B-тюнинг промтов стадий и калибровка режимов на реальных ТЗ | ⚙️ Инфраструктура (3 режима + env) готова; нужен прогон на корпусе ТЗ. |

### Как устроен анализатор

Все 5 стадий — **LLM-агенты**. Каждая стадия = пара файлов в `server/services/stageAnalysis/`:
`stageN_llm.js` (логика стадии + JSON-схема находки) и `stageNPrompts.js` (системный промт: общий блок `SHARED` + блок режима `structural`/`strict`/`full`, переключатель `STAGE{N}_PROMPT_VARIANT`, дефолт `structural`). Общий каркас (фильтр boilerplate → сегментация ТЗ под бюджет контекста → вызов LLM по сегментам → дедуп → локализация фрагмента в `.docx`-абзацах) — в `shared/llmStage.js`. LLM-вызов идёт через `llm/openaiClient.js` (OpenAI-совместимый, structured output по JSON Schema); в dev — через локальный Claude-bridge.

Каждое замечание дословно цитирует фрагмент ТЗ (`source_fragment`) и несёт `basis` (почему это проблема), `criticality`, `suggested_action` и `suggested_redaction` — инженер видит обоснование и может выбрать своё решение.

**Стадия 4 (типовые риски)** дополнительно фильтрует шум: у рисков есть `negative_triggers` (анти-триггеры — контексты, где упоминание не является риском), а каждая находка проходит quality scoring (`stage4Scoring.js`) — галлюцинированные ключи рисков, срабатывания анти-триггеров и слабые/необоснованные совпадения отсекаются ниже порога `STAGE4_MIN_SCORE`; `basis` обязан называть конкретное денежное/объёмное/срочное последствие для ГП.

> Прежний rule-based слой (файлы `stage*_*.js` без суффикса `_llm`, `shared/phrases.js`) оставлен в репозитории как superseded-история и движком не вызывается.

---

## Параллельная архитектура анализа (экспериментальная)

Поверх 5-стадийного пайплайна строится **новый параллельный конвейер** из 4 слоёв. Он **не трогает** `issues` / `review` / `export` — у каждого слоя своя таблица, свой сервис/контроллер/роут, debug-страница (по прямому URL) и офлайн-тест чистых функций без БД (как `review/consolidation.js`). Цель — собрать находки всех стадий в единый, отранжированный и сгруппированный поток замечаний для инженера.

```
   5 стадий (existing)
        │  issueRecords
        ▼
1. signals ──▶ 2. draft_issues ──▶ 3. critic ──▶ 4. clustering
 analysis_signals   draft_issues    issue_reviews   issue_clusters
                                                    issue_cluster_items
```

| Слой | Таблица(ы) | Сервис | Что делает |
|------|-----------|--------|------------|
| **1. signals** | `analysis_signals` | `services/signals/signalWriter.js` | Best-effort писатель: после каждой стадии складывает её находки в единый поток сигналов (`signal_type` по стадии: 1=coverage, 2=decision, 3=condition, 4=risk). Сбой писателя не влияет на закоммиченные issues и статус стадии. |
| **2. draft_issues** | `draft_issues` | `services/unifiedAnalysis/unifiedIssueBuilder.js` | Единый анализатор: сводит сигналы одного места ТЗ в один черновой draft_issue. |
| **3. critic** | `issue_reviews` | `services/critic/criticService.js` | Оценивает значимость draft_issue для генподрядчика по 10 критериям, ставит `display_priority` (critical/high/medium/low) и `show_to_engineer` (мягкое скрытие low, без удаления). |
| **4. clustering** | `issue_clusters` + `issue_cluster_items` | `services/clustering/clusteringService.js` | Сводит ПОХОЖИЕ замечания одного места ТЗ в кластер по `placeKey` (tz_clause → абзац → фрагмент) × доминирующему измерению значимости (цена/срок/договор/ответственность) × семейству действия (remove/edit/note). Разные по смыслу проблемы одного пункта (открытый объём ≠ риск оплаты) дают РАЗНЫЕ кластеры — основание каждого сохраняется. |

Слои 2–4 запускаются явно (`POST …/build`) и читаются с фильтром важности (`?mode=important|working|full`). Группировка/слияние во всех слоях — чистые функции, покрытые офлайн-тестами (`npm test`).

**Debug-страницы** (без пункта меню, по прямому URL): `/tenders/:id/debug/signals|draft-issues|issue-reviews|clusters` — зарегистрированы в `client/src/App.jsx`, методы API — в `client/src/services/api.js`.

> Статус: экспериментальный слой на ветке `sandbox/experiments`. Не подключён к основному потоку инженера (экспорт по-прежнему берёт решения из `issues`/consolidation).

---

## Принятые инженерные решения

1. **LLM-агенты, не rule-based**: каждая стадия — отдельный системный промт (роль ГП) + общий каркас `shared/llmStage.js`. Три режима промта (`structural`/`strict`/`full`) переключаются env без правок кода.
2. **LLM через OpenAI-совместимый клиент**: в dev — локальный `claudeBridge.js` (Claude Agent SDK), в проде — любой OpenAI-совместимый эндпоинт через `OPENAI_BASE_URL`. Стадии не знают, кто за клиентом.
3. **Postgres / Supabase** (`pg`), не SQLite: единая обёртка `db/connection.js` с async API (`queryOne/queryAll/queryRun/exec/transaction`) и SQLite-style плейсхолдерами (`?` → `$1`).
4. **Анализ по `.md`-копии ТЗ**: Markdown даёт стабильные заголовки/абзацы для сегментации и точной локализации цитат; экспорт правок при этом идёт в исходный `.docx`.
5. **Tailwind**, не CSS modules: один источник правды, минимум boilerplate.
6. **Zustand**, не Context API/Redux: меньше шума.
7. **pizzip + @xmldom/xmldom**, не `docx` npm: модификация исходного .docx даёт настоящий «Word Review feel» (правки и комментарии в Word, исходное форматирование сохранено). `docx` npm генерирует с нуля и не подходит для главного юзкейса.
8. **Настоящий Track Changes**: `delete`/`remove_from_scope` → `w:del`, `edit` → `w:del`+`w:ins`, решение «Примечание» → Word-комментарий. (Раньше удаления показывались `<w:strike/>` — `strikeWriter.js` оставлен как fallback.)
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
POST   /api/tenders/:id/stages/:n/run                фоновый: сразу {status:'running'}, статус через GET /stages
POST   /api/tenders/:id/stages/:n/finish
POST   /api/tenders/:id/stages/:n/reset
GET    /api/tenders/:id/stages/:n/issues             ?criticality=&review_status=&problem_type=

PATCH  /api/issues/:id                               review_status, edited_redaction, selected_for_export
POST   /api/issues/:id/decision                      {decision, edited_redaction, final_comment}

GET    /api/tenders/:id/review/preview               HTML-preview рецензии
GET    /api/tenders/:id/review/consolidated          экран «Итог» (группы по месту ТЗ)
GET    /api/tenders/:id/export/docx                  ТЗ.docx с Track Changes
GET    /api/tenders/:id/export/docx/report           пер-issue отчёт экспорта (applied/fallback/failed/skipped)
GET    /api/tenders/:id/export/issues.csv
GET    /api/tenders/:id/export/issues.json
GET    /api/tenders/:id/export/summary.md
GET    /api/tenders/:id/export/review.md             review.md со всеми правками

# Параллельная архитектура (экспериментальная, debug)
GET    /api/tenders/:id/signals                      поток сигналов всех стадий
POST   /api/tenders/:id/unified/build                собрать draft_issues из сигналов
GET    /api/tenders/:id/draft-issues
POST   /api/tenders/:id/critic/build                 оценить значимость draft_issues
GET    /api/tenders/:id/issue-reviews                ?mode=important|working|full
POST   /api/tenders/:id/clustering/build             сгруппировать похожие замечания
GET    /api/tenders/:id/issue-clusters               ?mode=important|working|full
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
