# CLAUDE.md

Инструкция для Claude Code при работе с этим репозиторием.

## Обзор проекта

**TZ-Opti** — MVP-портал для инженера тендерного отдела строительной компании. Анализ ТЗ на СМР через 5-стадийный последовательный пайплайн (LLM-агенты) с экспортом исходного ТЗ в `.docx` с правками и комментариями в логике Word Review.

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
npm run worker        # ОТДЕЛЬНЫЙ процесс-воркер очереди (при WORKER_MODE=external)
npm run seed          # пересеять Postgres-БД демо-данными (--force чтобы перезаписать)
npm run purge -- --tender <id>              # ПЛАН удаления архивных снимков (dry-run)
npm run purge -- --tender <id> --confirm <id>  # физически удалить архивные снимки анализа
npm run benchmark     # офлайн-оценка качества анализа на эталонном наборе (без БД и LLM)
npm run build         # production-сборка клиента
npm run test:unit     # серверные юнит-тесты (без БД, без сети, без LLM)
npm run verify        # unit → integration (доступные) → сборка клиента
npm run verify:integration  # integration строго: нужен TEST_DATABASE_URL, иначе падает
```

Точка входа сервера — `server/server.js` (миграция, авто-сид, встроенный воркер
очереди, listen). Точка входа воркера — `server/worker.js` (только очередь, без
HTTP). `server/app.js` экспортирует только `createApp()` и при импорте ничего не
делает — приложение можно собрать в тесте офлайн. Матрица команд и переменные
тестовой БД — [docs/development.md](docs/development.md); инварианты —
[docs/safety-invariants.md](docs/safety-invariants.md).

## Архитектура

```
TZ-Opti/
├── client/    Vite + React + Tailwind + Zustand
├── server/    Express + pg (Supabase Postgres) + Multer
└── README.md  главный документ — содержит "что работает / что mock / что следующая задача"
```

Бизнес-логика — в `server/services/`. UI на русском, код на английском.

**Фоновые задачи — устойчивая очередь в Postgres, не память процесса.**
`server/services/jobs/`: `analysis_jobs` (ЗАДАНИЕ — идемпотентность, отмена,
прогресс) + `analysis_tasks` (ЗАДАЧА — claim, аренда, попытки, чекпойнт).
Задачу забирает ровно один воркер (`UPDATE … FOR UPDATE SKIP LOCKED`), на время
работы держится session-level `pg_try_advisory_lock` по (тендер + область +
ревизия документов) — одновременный анализ одной стадии одной ревизии
невозможен даже между процессами. Аренда продлевается heartbeat'ом; не
продлена — задача осиротела: возвращается в очередь (продолжение с чекпойнта)
либо получает `interrupted`. Воркер: встроенный в сервер (`WORKER_MODE=embedded`,
дефолт) или отдельный процесс (`npm run worker`). Redis не используется.
Чистые правила очереди — `jobs/jobModel.js` (офлайн-тесты), SQL — `jobs/jobQueue.js`.
Прогресс стадии читается из БД (`jobs/jobService.stageProgress`), in-memory
`progressRegistry` удалён.

**Безопасность — закрытый контур, а не набор советов.** Все `/api`-маршруты,
кроме `/api/health`, требуют Bearer-токен (OIDC/JWT, провайдер-независимо:
`server/security/` — `jwt.js` на `node:crypto`, `keyStore.js` discovery+JWKS,
`principal.js` клеймы→субъект). Права — роли `viewer|engineer|lead|manager|admin`
(`security/roles.js`), доступ к маршруту — таблица `security/policy.js`
с **default deny** (нет правила → 403; тест обходит все маршруты и требует
правило). Изоляция тенантов: тенант субъекта — только из токена, тенант ресурса —
только из БД (`security/tenantAccess.js`), межтенантное обращение → 403
`CROSS_TENANT_DENIED`; `tenders.tenant_id` — ключ, остальное наследует через
тендер. Журнал аудита — `audit_log` + `services/audit/auditService.js`
(чтения/изменения/анализ/решения/выгрузки/отказы, best-effort запись, чтение
только своего тенанта). Транспорт: `middleware/` — requestContext (X-Request-Id),
securityHeaders, corsPolicy (allowlist), rateLimit (в т.ч. антиподбор токена),
errorHandler (в production 5xx без внутренних деталей). Загрузки: карантин →
формат → магические байты → SHA-256 → **обязательный антивирус**
(`services/uploads/`), fail-closed. TLS до Postgres в production строгий
(`db/connectionTarget.js`). Dev-bypass (`AUTH_DEV_BYPASS=1`) — только вне
production; небезопасная production-конфигурация роняет старт
(`security/config.js` → `assertProductionSecurity` в `server.js`).
Новых зависимостей ради этого не добавлено. Полное описание —
[docs/security.md](docs/security.md), переменные — блок «БЕЗОПАСНОСТЬ» в
`.env.example`, тесты — `server/test/unit/security/**`.

## Конвенции

- Без TypeScript на клиенте
- Tailwind для стилей (один источник правды)
- Zustand вместо Redux
- Тексты UI — на русском
- Имена файлов / переменных / функций — английский
- Один файл ≤ 600 строк (разбивать)

## Главный артефакт

Экспорт `/api/tenders/:id/export/docx` собирает исходный ТЗ.docx с настоящими Word Track Changes и комментариями: `delete` → `w:del`, `remove_from_scope` → `w:del` + комментарий-тег «Вынесено из объёма ГП», `edit` → `w:del` + `w:ins`, «Примечание» (accept) → Word-комментарий (`server/services/reviewDocx/trackChangesWriter.js`, `commentWriter.js`). Запасной путь при сбое track-change — Word-комментарий (`status='fallback'` в отчёте).

**Единый «вид решения»** — `server/services/review/decisionModel.js` (`decisionVisual` + `resolveRedaction`): из него берут docx-экспорт, HTML-preview (`reviewHtmlService.js`) и md-рендер (`mdReview/renderer.js`) — одно решение видно одинаково в preview, таблице и Word.

**Предсказуемость экспорта.** `exportReviewedDocx` → `{ buffer, report }`, где `report.items[]` = `{ issueId, status: 'applied'|'fallback'|'failed'|'skipped', reason, ... }`. При сбое track-change — fallback на Word-комментарий (`status='fallback'`). Отчёт без скачивания: `GET /api/tenders/:id/export/docx/report` (показывается на странице «Экспорт»). Регресс-набор экспорта — `npm test` (`server/test/`, node:test; абзац/список/таблица/мультиформат/повтор; без БД и LLM).

## Анализатор

5 стадий (последовательно), LLM-агенты (OpenAI-совместимый клиент `stageAnalysis/llm/openaiClient.js`; в dev — bridge к Claude):
1. ТЗ + Чек-лист + ВОР
2. Q&A + Характеристики
3. Существенные условия компании
4. Типовые риски
5. Самоанализ ТЗ

**Названия стадий — единый источник.** Сервер: `STAGE_LABELS` в `stageAnalysisEngine.js` (идёт в `summary.label`). Клиент: `STAGE_META` в `client/src/utils/labels.js` (из него берут `stageConfig.jsx`, `wizardSteps.js`, `AnalysisOverview.jsx`, `ReviewPage.jsx` через хелперы `stageTitle/stageLabel/stageShort`). Тексты `title` на клиенте и сервере должны совпадать — не хардкодить названия в других местах.

Стадии 1–4 — пара файлов в `server/services/stageAnalysis/`: `stageN_llm.js` (логика стадии + схема находки) и `stageNPrompts.js` (системный промт: общий блок `SHARED` + 3 режима `structural` | `strict` | `full`, переключатель env `STAGE{N}_PROMPT_VARIANT`, дефолт `structural`). Общий каркас (сегментация / локализация фрагмента / сверка / раннер) — в `shared/llmStage.js`. Движок стадий — `stageAnalysisEngine.js`, статусы и гейты (`tender_stage_state`) — `stageState.js` (движок их реэкспортирует). Прежний rule-based слой (`stage*_*.js` без `_llm`, `shared/phrases.js`) удалён.

**Большое ТЗ — иерархическая token-aware сегментация, а не «весь документ одним куском».**
`shared/segmentation.js`: блок крупнее бюджета дробится по предложениям с перекрытием
(`paragraph_index` сохраняется — локализация цитаты работает); блоки собираются в пункты
(заголовок — граница, «3.4.1 …»/«а)»/«-» начинают новый, списки и строки таблиц прилипают);
пункты пакуются в части под ТОКЕННЫЙ бюджет (`STAGE_SEGMENT_TOKENS`, дефолт 20000) по границам
разделов, с перекрытием хвоста предыдущей части и с заголовочным контекстом в шапке.
**Ни одна стадия не требует весь ТЗ в одном контексте**: справочники (Q&A/характеристики,
условия, риски) повторяются в каждой части; `requireSingleSegment` удалён — не возвращать.
Стадия 5 тоже идёт по частям (усечение ТЗ по 200000 символов убрано).
После всех частей — **финальная межраздельная сверка** `shared/crossSegmentReview.js`:
детерминированный дедуп «швов» (обязателен) + LLM-шаг (best-effort, `STAGE_CROSS_SEGMENT_REVIEW=0`
выключает), который убирает повторы одного места ТЗ и помечает связи/противоречия разделов
(критичность может поднять, понизить — нет).
**Части ТЗ: КЭШ и ИСТОРИЯ — две таблицы, а не одна строка на обе роли**
(`segments/segmentStore.js`, best-effort: сбой хранилища не роняет анализ).
`analysis_segments` — **кэш результата, скоупленный ревизией документов**
(ключ `(тендер, стадия, document_revision_id, номер части)`, ключ `ux_segments_cache`
ставит миграция): переиспользование только при совпадении `input_hash` И `config_version`,
новая ревизия ТЗ больше не затирает кэш прошлой (хранятся последние 3 ревизии).
`analysis_run_segments` — **неизменяемая история выполнения**: одна строка на
`(analysis_run_id, segment_index)`, пишет ТОЛЬКО прогон-владелец и ТОЛЬКО пока он `running`;
статусы `pending|running|completed|failed|interrupted|skipped`, `source` = `llm` (реально
считалось) | `cache` | `checkpoint` (переиспользовано — расчётом не считается). Прежняя
единая строка перезаписывалась повтором стадии, и «на какой части упал вчерашний прогон»
восстановить было нечем. Одну часть можно пересчитать точечно — `engine.retryStageSegment` →
`POST /api/tenders/:id/stages/:n/segments/:idx/retry` (гасит КЭШ части, историю не трогает),
список — `GET …/segments[?run_id=]` (части конкретного прогона + `runs[]` со сводкой),
debug-страница `/tenders/:id/debug/segments`. `resetStage` чистит кэш, историю —
никогда. Офлайн-тесты — `server/test/unit/segmentation.test.js` (большое синтетическое ТЗ +
риск на границе двух сегментов), `stageRunLifecycle.test.js` (чистые правила),
БД-слой — `server/test/integration/segments.integration.test.js`.

**Жизненный цикл прогона стадии: прогон создаётся ДО работы и завершается САМ.**
`analysis_run` заводится при постановке стадии в очередь (`startStageBackground` →
`beginStageRun`) со `status='running'`, реальными `started_at` / `documents_revision_id` /
`config_version`; его id лежит в `analysis_jobs.analysis_run_id` и уходит в КАЖДУЮ часть ТЗ.
Одно задание = один прогон: повторная попытка задачи продолжает его (части поднимаются из
кэша), а не заводит второй снимок. Исход пишется В НЕГО ЖЕ: успех — `activateRun`
(`completed` + перевод указателя), неуспех — `finalizeStageRun` → `failed` | `cancelled` |
`interrupted` с реальным `finished_at` и `error`/`failed_segment_index` в `summary`.
**Отдельной «фиктивной» failed-строки после ошибки больше нет** (`recordFailedRun` удалён:
он вставлял вторую строку с `started_at = finished_at`, без ревизии и версии конфигурации,
а настоящий прогон навсегда оставался `running`). Владение: прогон задания завершает
финализатор задания (`handlers/stageAnalysisJob.onJobSettled`), синхронный прогон — сам
движок. Осиротевшие прогоны (процесс умер, живого задания нет) закрываются как `interrupted`
на старте сервера и воркера — `engine.recoverOrphanedStageRuns` (прогон, который ведёт
другой воркер, защищён живым заданием). Начало нового прогона стадии закрывает прежний
`running` этой же стадии (`interruptStaleStageRuns`). Тесты —
`server/test/integration/stageRunLifecycle.integration.test.js` (сбой в середине документа,
рестарт воркера, точечный retry, история двух последовательных прогонов).

**Манифест тендерного пакета — вход анализа выбирается по нему, а не «последний
загруженный файл побеждает».** У каждого документа (`documents`) манифест-поля:
`revision_label` (редакция), `actuality_status` (`actual`|`informational`|`superseded`),
`doc_date`, `conflict_priority` (приоритет при противоречии), `applicability`
(корпус/раздел), `supersedes_document_id` (цепочка замены). Чистое ядро —
`server/services/documents/manifestModel.js` (выбор актуальных: superseded исключён
всегда — в т.ч. по ОБРАТНОЙ ссылке замены, informational уступает actual, дальше
приоритет → дата документа → дата загрузки; валидация PATCH; циклы замены), DB-слой —
`manifestService.js`. API: `GET /api/tenders/:id/manifest` (группы по типам +
предупреждения разметки), `PATCH /api/documents/:id/manifest` (установка ссылки замены
авто-помечает заменённый документ superseded); UI — панель манифеста на странице
«Документация». Типы пакета расширены: `contract` | `schedule` | `specification`.
Выбор документов — только через `tzActiveTextService.getDocumentByType` /
`getDocumentsByType` (не писать прямые `ORDER BY uploaded_at LIMIT 1`). Манифест-поля
входят в `currentDocumentsRevision` (правка манифеста = новая ревизия набора; у
документов с дефолтной разметкой суффикс пустой — ревизии нетронутых тендеров не
меняются). ВОР может быть НЕСКОЛЬКО актуальных одновременно (по корпусам):
`vor_items` скоуплены `document_id`, импорт заменяет позиции только своего файла,
`loadVorItems` отдаёт позиции всех актуальных ВОР (superseded исключён вместе с
позициями), стадия 1 получает все актуальные ВОР (текстовый фолбэк размечается
заголовком документа). Тесты — `server/test/unit/documentManifest.test.js`,
`server/test/integration/documentManifest.integration.test.js`.

**ВОР — структурный импорт xls/xlsx, а не «самая длинная ячейка строки».**
`server/services/vor/`: `vorParser.js` (чистый разбор «сетки»: строка заголовков,
в т.ч. двух-трёхэтажная; раскрытие объединённых ячеек; синонимы колонок; классификация
строк позиция/раздел/итог/пустая) + `vorNormalize.js` (числа «1 234,56»/«1,234.56»/
Excel-number → number; единицы «кв.м»/«м²»/«куб.м»/«п.м.» → `м2`/`м3`/`м`) +
`vorReader.js` (единственное место, где ВОР касается библиотеки xlsx) +
`vorImportService.js` (позиции → таблица `vor_items`, идемпотентно; `ensureVorItems`
лениво импортирует ВОР, загруженный до появления импорта). Сохраняются **номер позиции,
шифр, раздел, наименование, единица (сырая и нормализованная), количество (сырое и
числом), примечание, лист, строка Excel и адреса ячеек** (`cells`, `merged_cells`).
Импорт запускается при загрузке документа (`doc_type='vor'`), API — `GET/POST
/api/tenders/:id/vor[...]` (`vorController.js`): позиции, сводка разбора, переимпорт,
`…/vor/matching` (вход сопоставления), `…/vor/preview` (каталог глазами модели).

**Сопоставление ТЗ↔ВОР — СТРУКТУРНАЯ СВЯЗЬ, а не ключевые слова.** Каждая
vor-находка Стадии 1 несёт `vor_match` (схема в `stage1_llm.js`): статус
`covered|partial|not_covered|unclear`, позиции ведомости, операции
included/missing, исключения, примечания по единицам и количеству. Лексическое
совпадение НЕ доказывает покрытие: агент обязан раскладывать требование на
ОПЕРАЦИИ («перегородки 12 000 м²» не закрывает усиления/закладные/заделку —
это `problem_type='учтено_частично'`, новый тип домена Стадии 1). Карта
сопоставления — `vor/requirementMatchModel.js` (чистое ядро) +
`requirementMatchService.js`: снимок прогона в `requirement_matches`
(количество/единица берутся ДЕТЕРМИНИРОВАННО из каталога ведомости —
`resolvePositions`; незнакомая позиция — `verified:false`, расхождение единиц —
`unit_mismatch`), подтверждение инженера — `requirement_match_confirmations`
(ключ `match_key` = хэш нормализованной цитаты, переживает прогоны:
`confirmed|rejected|adjusted`). API `GET/PATCH /api/tenders/:id/vor/requirements[...]`,
страница «Покрытие ВОР» (`/tenders/:id/vor-matching`). Сведение пакетов
(`intersectPasses`) устойчиво к длине цитаты: вложенная цитата того же места —
та же находка (контейнмент), covered-записи сводятся ОБЪЕДИНЕНИЕМ (покрытие
подтверждает пакет, видевший позицию), пробелы — по-прежнему пересечением.
Тесты — `server/test/unit/requirementMatch.test.js`,
`server/test/integration/requirementMatch.integration.test.js`.

**Большой ВОР — ПАКЕТЫ, а не отсечка по лимиту символов.** `vorCatalog.js` сворачивает
одинаковые позиции (объёмы суммируются), печатает каталог таблицей с единицами и
количествами и режет его на пакеты под токенный бюджет (`STAGE1_VOR_BATCH_TOKENS`).
`vorMatchIndex.js` — детерминированный слой сопоставления **ТЗ ↔ ВОР ↔ чек-лист**:
лексический индекс с лёгким стеммингом, кандидаты под конкретную часть ТЗ и
перекрёстная сверка чек-лист↔ВОР (работа в объёме ГП, но не посчитанная в ведомости,
уходит в промт готовым фактом). Прежний запасной режим «ВОР пропущен» удалён: если
каталог не влезает, стадия делает НЕСКОЛЬКО ПРОХОДОВ по одной части ТЗ
(`llmStage.buildUserMessage` может вернуть массив проходов, `combinePasses` их сводит),
и «работы нет в ВОР» засчитывается только по ПЕРЕСЕЧЕНИЮ всех пакетов
(`stage1_llm.intersectPasses`). Тесты — `server/test/unit/vorParser.test.js`,
`vorCatalog.test.js`, `server/test/integration/vorImport.integration.test.js`.

**Стадия 3 — не только противоречия, но и ПОКРЫТИЕ: отсутствие условия — тоже
находка.** У каждого существенного условия и каждой темы покрытия — статус:
`matches | contradicts | ambiguous | missing` (агент) + `other_document |
check_contract | not_applicable` (инженер). Чистое ядро —
`stageAnalysis/conditionCoverage.js`: реестр 24 договорных тем покрытия
(доп. работы, задержка РД, индексация при переносе, лимит ответственности,
приёмка по молчанию, приоритет документов, ПНР и ввод, страхование СМР,
расторжение, давальческие, BIM, права на документацию, …), агрегация по частям ТЗ
(«отсутствует» — ТОЛЬКО если тема не затронута ни в одной части; по одной части
судить нельзя), сборка находки `условие_отсутствует`. Такая находка БЕЗЪЯКОРНА
по определению (цитаты нет — в этом и проблема): критик её не убивает —
`no_anchor` не применяется к `signals.condition_gap`, evidence с обоснованием =
'medium' (доказательство — реестр + полная сверка), правило `condition_gap`
публикует high/critical последствие, medium уходит LLM-критику (fail-closed).
Для отсутствующего условия предлагается ДЕЙСТВИЕ, а не правка текста: запрос
Заказчику / тендерное допущение / исключение из цены / условие КП / проверка
проекта договора / резерв риска (полный словарь — в матрице покрытия;
`required_action` находки маплится на существующий реестр — НЕ расширять
REQUIRED_ACTIONS). Неоднозначная формулировка — находка `условие_неоднозначно`
(с цитатой). Матрица хранится снимком прогона (`condition_coverage`, скоуп
`analysis_run_id`) + знание инженера отдельно (`condition_coverage_overrides`,
переживает прогоны); сервис — `services/conditions/coverageService.js`; API
`GET/PATCH /api/tenders/:id/conditions/coverage[...]`; UI — панель «Покрытие
существенных условий» на странице условий. Тесты —
`server/test/unit/conditionCoverage.test.js`, `conditionGapCritic.test.js`,
`server/test/integration/conditionCoverage.integration.test.js`.

**Стадия 5 РАЗДЕЛЕНА на два механизма (прежнее противоречие «не ищи заново, но
найди пропущенное» снято).** (А) **QC** — контроль качества СУЩЕСТВУЮЩИХ
кластеров (`stage5_llm`/`stage5Prompts`/`selfAnalysisService`): слабое основание,
нет последствия, неконкретная рекомендация, дубли, конфликтующие рекомендации,
завышенная критичность (`LLM_FINDING_TYPES`); каждый вывод привязан к
ОБЯЗАТЕЛЬНОМУ `cluster_id` (вывод без валидного id отбрасывается — прежние
«глобальные» заметки без кластера не попадали в bundle и терялись);
`missed_coverage` остался только у детерминированной эвристики (потерянные при
сборке категории сигналов). Пропуски QC НЕ ищет. (Б) **CHALLENGER** —
независимый поиск пропущенного основными стадиями: опциональный шаг конвейера
МЕЖДУ clustering и self_analysis (`pipeline/challengerStep.js`, сканер
`stageAnalysis/stage5Challenger.js`, флаг `withChallenger`; контроллер конвейера
включает его вместе с `with_self_analysis` — основной поток «Анализ ТЗ» получает
оба механизма). Challenger читает ТЗ по частям против дайджеста СОБРАННЫХ
кластеров кандидата, цитатные находки (`пропущенный_риск` + типы домена стадии 5)
публикуются ШТАТНЫМ снимком стадии 5 — `SIGNAL_STAGES` включает 5, тип сигнала
`challenger` (signalWriter), пустой снимок = «независимая проверка пропусков не
нашла» — и при находках слои кандидата ПЕРЕСОБИРАЮТСЯ (draft → critic →
clustering): пропуск становится ОБЫЧНЫМ замечанием со статусом, вердиктом
критика, кластером и решением инженера. Дедуп двухслойный: промт получает список
покрытого + детерминированный `isCoveredByExisting` (пересечение цитат). Сбой
сканера — fail-loud (прогон стадии 5 failed, шаг конвейера failed, указатели
целы). Legacy-запуск стадии 5 как стадии challenger НЕ включает (его прогон
столкнулся бы с прогоном самой стадии). Тесты — `server/test/unit/challenger.test.js`,
`server/test/integration/challengerStep.integration.test.js`.

**QC-механизм Стадии 5 — не добытчик issues.** Legacy-запуск стадии 5 как стадии (`runStage5SelfAnalysis`) возвращает `issues=[]` и пишет QC-заметки в `self_analysis_results` через `selfAnalysis/selfAnalysisService.js` (5-й слой конвейера, см. ниже). Issues со `analysis_stage=5` теперь порождает ТОЛЬКО challenger-шаг конвейера (см. блок «Стадия 5 РАЗДЕЛЕНА» выше) — они публикуются его собственным stage-прогоном. `stage5_llm.js` — QC-агент над кластерами; ТЗ подаётся ему ЧАСТЯМИ (кластеры повторяются в каждой части), упавшая часть не обнуляет остальные — QC отдаёт то, что посчиталось, и пишет `failed_parts`.

**Исход self-analysis явный — ложного успеха на эвристиках нет.** `runSelfAnalysisLlm` НЕ бросает, а возвращает `{ status, findings, segmentation, reason }`; `selfAnalysisService.resolveSelfAnalysisOutcome` (чистая, fail-closed) сводит его в исход слоя: **N/N** частей → `completed`; **1..N-1/N** → `completed_with_warnings` + `failed_parts` (`partial:true`); **0/N** → `failed` и `buildSelfAnalysis` БРОСАЕТ (`code='SELF_ANALYSIS_FAILED'`) — прогон стадии становится failed, шаг конвейера — failed (страж в `runPipelineStep`: `summary.status==='failed'` роняет шаг). Два исхода «QC не запускался» — не сбой: `not_applicable` (кластеров нет, модель не зовём) и `skipped` (нет `OPENAI_API_KEY`; помечается warning, не зелёным). Клиент: `stageToast` в `client/src/utils/analysisResult.js` — success зелёный, warning ЖЁЛТЫЙ, сбой/обрыв красный (`_pollStage` в `useTenderStore`). Тесты — `server/test/unit/selfAnalysis.test.js` (0/N, 1/N, N/N, пустые кластеры, LLM не настроен), `clientAnalysisResult.test.js` (warning-toast), `pipeline.test.js`.

**Вход анализа НЕИЗМЕНЯЕМ.** Все стадии 1–5 читают один и тот же текст (`getTzText`,
`tzActiveTextService.js`) — решения инженера на него не влияют. Прежний механизм
`tz_excluded_ranges` (урезание активного текста между стадиями) демонтирован; таблица
осталась в БД как legacy-история, код её не пишет и не читает. Влияние решений —
только через **согласованную версию ТЗ** (см. ниже).

**Согласованная версия ТЗ (`tz_agreed_versions`, `server/services/agreedVersion/`).**
Решения кластерной рецензии материализуются в новый .md: чистый билдер
`agreedTextBuilder.js` правит СЫРУЮ md-строку по offset-якорям блоков
(`mdParser` отдаёт `md_start`/`md_end`), `delete`/`remove_from_scope` — ко ВСЕМ
вхождениям кластера (`evidence_fragments`), `edit` — ко всем при дословном совпадении
цели (иначе только representative, остальные в отчёт `skipped_occurrence`),
`accept`/`reject` текст не меняют; операции сливаются и применяются справа налево
(дрейф координат исключён), конфликты и ненайденные фрагменты — в `build_report`;
цель, найденная в области поиска больше одного раза, НЕ правится «по первому
вхождению» — `ambiguous_target` (счётчик `ambiguous`).
Версия создаётся draft (`POST /api/tenders/:id/agreed-versions`), активация
(`…/activate`, одна active на тендер) делает её ВХОДОМ следующего раунда анализа:
`getTzSourceDocument` отдаёт синтетический документ версии, `currentDocumentsRevision`
включает её в ревизию набора — manifest/кэш/carry-over реагируют штатной механикой
ревизий. **Активация — жёсткий гейт инвариантов** (`agreedVersion/activationGate.js`,
чистое ядро `assessActivation`): рецензия завершена и не устарела
(`unresolved_clusters=0`, `carryovers_pending=0`, `pipeline_stale=false`),
`failed=conflicts=ambiguous=0`, `skipped` только с явным подтверждением инженера
(`confirm_skipped`), база версии совпадает с текущей базой тендера
(`base_agreed_version_id`+`base_revision_id`); нарушение → 409
`AGREED_ACTIVATION_BLOCKED` (список в `details.violations`, отказ идёт в аудит).
Отклонение от инвариантов — ТОЛЬКО форс-режим `{force:true, reason}` (основание
обязательно) с ОТДЕЛЬНЫМ событием аудита `agreed_version.activate_forced`
(reason + нарушенные инварианты); UI панели версий показывает нарушения и
форс-форму. Снимок `applied_decisions` неизменяем и ПОЛНЫЙ — хранит ВСЕ решения
рецензии, ВКЛЮЧАЯ `reject` (доказательство, что инженер рассмотрел каждый
кластер); к тексту применяются только текст-меняющие, в экспорт `reject` не
попадает (`snapshotToExportRows`). Цепочка версий — `base_agreed_version_id`.
Экспорт конкретной версии — `?version_id=` в `/export/docx[/report]` (решения из
снимка ВСЕЙ цепочки, заголовок `X-Agreed-Version`; правки «по правкам» прошлого
раунда в оригинальном .docx ложатся fallback-комментарием). UI: панель версий на
ReviewPage, селектор источника на ExportPage.

**Селективный пересчёт.** Кэш частей переиспользуется МЕЖДУ ревизиями по
`input_hash` + `config_version` (`segmentStore.getCompletedByHash` + прогрев в текущую
ревизию): после активации версии заново считаются только изменённые части, нетронутые
поднимаются из кэша без LLM (в истории — `source='cache'`). Карта затронутого —
`GET /api/tenders/:id/pipeline/impact` (`agreedVersion/impactService.js`,
planOnly-режим `runLlmStage`: нарезка и хэши без LLM и записи) — ОЦЕНКА, не гарантия:
жадная упаковка частей может каскадно сдвинуть нарезку хвоста. «Незатронутая стадия»
всё равно перепрогоняется (новый снимок против новой ревизии), но целиком из кэша.
Carry-over: решения прошлого прогона, чья правка вошла в активную версию, отдаются
секцией `materialized` («учтено в тексте»), а не как потерянные.

**Зоны ответственности и сборка итога.** Каждый агент 1–4 пишет ТОЛЬКО в свой домен `problem_type` — единый реестр `server/services/review/stageDomains.js` (Stage1 покрытие расчёта; Stage2 Q&A+характеристики; Stage3 условия; Stage4 риски); движок логирует находки вне домена (`off_domain` в summary). Слой сборки `server/services/review/consolidation.js` (`consolidate(tenderId)`) сводит находки разных стадий, указывающие на одно место ТЗ (абзац + перекрытие char-диапазонов; фолбэк — цитата), в группы: **primary** по критичности (тай-брейк — порядок стадий), прочие — `related`, конфликты помечаются (решает инженер). Один итог: `GET /api/tenders/:id/review/consolidated` → экран «Итог» (`client/src/pages/result/SummaryPage.jsx`). Экспорт берёт **одно** решение на место (primary; дубли попадают в отчёт экспорта как `skipped`) через `dedupeExportDecisions`. Тесты слоя — `server/test/consolidation.test.js`.

**Повторённое требование — ОДНО замечание, а не карточка на каждый абзац.**
Кластеризация двухъярусная. **Ярус 1** (`clusteringService`, `placeKey × semanticBucket`) —
одно МЕСТО ТЗ. **Ярус 2** (`clustering/topicModel.js`, чистый) — одна ТЕМА: группы яруса 1
сливаются, если совпали **тип риска** (`riskTypeOf` — семейства поверх свободного
`problem_type`), **объект работ** (`detectWorkObject` — таксономия обязанностей ГП: уборка,
исполнительная документация, временные сети, поставка материалов, охрана, ОТ и ТБ,
гарантия, оплата, …), **бизнес-последствие** (`dominantDimension` от critic),
**рекомендуемое действие** (`required_action`, при пустом — из семейства `suggested_action`)
и тексты прошли **смысловую сверку**. Порог сверки зависит от того, распознан ли объект
работ: распознан → лексическая близость не требуется (её уже подтвердила таксономия, а
формулировки одной обязанности пересекаются словами плохо: «ежедневная уборка площадки» vs
«вывоз строительного мусора»); НЕ распознан (`other`) → опора только текст, порог высокий
(Жаккар ≥ 0.45). **Ярус 2 НИКОГДА не сливает группы одного места** — разные самостоятельные
риски одного абзаца (открытый объём ≠ риск оплаты) остаются разными замечаниями.
Вхождения хранятся ПРИ кластере (снимок неизменяем, пересчитывать на чтении нельзя):
`occurrence_count` (число РАЗНЫХ мест; `item_count` — число draft_issues),
`evidence_fragments` (JSON: цитата + пункт + раздел + абзац), `affected_sections`,
`representative_fragment` (цитата первичного вхождения — её показывает карточка и по ней
docx-экспорт находит место), плюс `work_object`/`topic_key` для аудита слияния. Заголовок
кластера называет ПРЕДМЕТ («Уборка и вывоз мусора»), если объект работ распознан. UI
(`ReviewPage`, `ClusterList`, `SummaryPage` через `occurrenceNote`/`otherOccurrences` в
`client/src/utils/format.js`) показывает ОДНО замечание и подпись
«Обнаружено ещё в N местах» со свёрнутым списком остальных вхождений. Тесты —
`server/test/unit/clusteringTopics.test.js` (уборка / исполнительная документация /
временные сети / поставка материалов + границы слияния) и
`server/test/integration/clusterOccurrences.integration.test.js` (круг через Postgres).

**Конвейер анализа (signals → draft_issues → critic → clustering → self-analysis).** Поверх стадий работает основной аналитический конвейер: стадии 1–4 добывают находки → движок пишет их сигналами (`signals/signalWriter.js`, авто, best-effort) → `unifiedAnalysis/unifiedIssueBuilder.js` (draft_issues) → `critic/criticService.js` (значимость) → `clustering/clusteringService.js` (кластеры) → `selfAnalysis/selfAnalysisService.js` (QC, Стадия 5). Каждый слой — таблица + сервис + контроллер + роут + debug-страница + офлайн-тест чистых функций. Оркестратор `pipeline/analysisPipeline.js` пересобирает слои 2–5 одним вызовом (`POST /api/tenders/:id/pipeline/run`, `{with_self_analysis:false}` — без LLM-шага; после сбоя шага остальные `skipped`, отчёт `{ok, failed_step, steps[]}` — сбой ≠ HTTP-ошибка); debug-страница `/tenders/:id/debug/pipeline`, тест `server/test/unit/pipeline.test.js`.

**Публикацию замечания решают impact × evidence, а НЕ criticality/confidence.**
Единый источник модели — `server/services/review/materiality.js` (чистый, без БД).
Две независимые оси: **`impact_level`** (`critical|high|medium|low|none` — насколько дорого
ГП) и **`evidence_level`** (`strong|medium|weak` — насколько подтверждено). Их пересечение
даёт **`verdict`** (`publish|verify|suppress`, `VERDICT_MATRIX`): `low`/`none` не публикуются
НИКОГДА (даже при strong evidence и confidence 0.99), `critical|high` + `weak` уходят в
`verify`, `medium` публикуется только при `strong`. Жёсткие причины подавления (редактура,
дубль, стандартное требование, нет влияния, неподтверждённое предположение) перебивают
матрицу; если агент пометил нематериальным то, что материально по критериям компании, —
это `contested`: не скрываем, а отправляем в `verify`. Ещё поля: `impact_dimensions`
(`price|schedule|payment|contract|responsibility|scope`), `publication_reason`,
`suppression_reason`, `required_action`
(`amend_tz|exclude_scope|ask_customer|add_assumption|recalculate|none`).
**Где что считается:** агент стадии 1–4 ЗАЯВЛЯЕТ оценку (общий блок схемы и промта —
`stageAnalysis/shared/materialityFields.js`, поля необязательные) → сигнал несёт её в
payload → `draft_issues` хранит мнение агентов (`impact_level=NULL` = «агент не оценил», это
НЕ «влияния нет», вердикт тогда `verify`) → **авторитетный вердикт считает critic**:
`impact_level` — ТОЛЬКО по весам материальных критериев компании (`CRITERIA`),
`evidence_level` — по структуре находки (привязка к тексту ТЗ + обоснование + число
независимых типов сигналов); заявленное агентом может лишь ПОНИЗИТЬ доказательность
(fail-closed) → `issue_clusters` получает свёртку (вердикт — сильнейший по элементам,
влияние/доказательность — максимум, измерения — объединение, причины и `required_action` —
от решающего элемента). `criticality` и `confidence` в новый расчёт не входят вовсе и
остались легаси-полями сортировки (`score`, `display_priority`, `overall_criticality`).
Режимы выборки (critic и clustering): `working` = `publish` (**по умолчанию — инженер видит
только материальные коммерческие и договорные риски**), `verify`, `important` (publish +
влияние critical|high), `full` = всё. Ничего не удаляется: `verify` и `suppress` лежат в БД
с причиной, `show_to_engineer` = `verdict === 'publish'`. Старые строки миграция переносит
ТОЙ ЖЕ матрицей (`fromLegacyPriority` + `backfillMateriality` в `db/migrate.js`, только
`WHERE verdict IS NULL`, идемпотентно): прежние critical/high → `publish`, medium →
`verify`, low/скрытое → `suppress`, в причине — пометка о переносе. Тесты —
`server/test/unit/materiality.test.js` (все 15 клеток матрицы + правила 1–7) и
`server/test/integration/materiality.integration.test.js` (матрица через Postgres, режимы
выборки, свёртка на кластер, безопасность переноса).

**PRECISION-КРИТИК: публикацию решает НЕЗАВИСИМАЯ двухуровневая проверка, а не
эвристические баллы.** `server/services/critic/precision/` — последнее слово о том,
увидит ли инженер замечание. Прежний critic начислял баллы и публиковал почти всё, что
набрало «medium»; теперь оценка разложена на **9 измерений** (`precision/assessment.js`):
`evidence_strength` (strong|medium|weak|none), `business_consequence`
(critical|high|medium|low|none), `actionability` (actionable|conditional|none),
`novelty` (novel|partial_duplicate|duplicate) и пять каналов влияния —
`scope_impact` / `cost_impact` / `schedule_impact` / `contract_impact` /
`responsibility_impact`. Каждая ось может САМА заблокировать публикацию.
**Уровень 1 — детерминированные жёсткие фильтры** (`precision/hardFilters.js`, чистые,
одно правило = одна названная причина, порядок значим): `no_anchor` / `duplicate` /
`no_evidence` → `reject_invalid`; `editorial` / `standard_requirement` / `no_consequence` /
`weak_assumption` / `not_actionable` / `low_consequence` → `hide_informational`;
`coverage_conflict` (пробел покрытия ВОР/КП — машинный факт) / `scope_expansion` /
`strong_critical` / `strong_high` → публикация. Не решённое правилами — **спорное**.
**Уровень 2 — отдельная LLM-проверка ТОЛЬКО спорных** (`precision/llmCritic.js`): промт
требует ИСКАТЬ ОСНОВАНИЯ НЕ ПОКАЗЫВАТЬ, сомнение трактуется в пользу скрытия, модель
обязана вернуть `reasons_against`. Критику НЕ показывают confidence и criticality агента —
высокая уверенность нашедшего не является основанием публикации. Решение модели
СОГЛАСУЕТСЯ с инвариантами (`reconcile`): она может только ужесточить — не опубликует
`low`/`none`, не отменит детерминированный повтор, не поднимет доказательность выше
структурной. Исходы: **`publish_critical` | `publish_working` | `hide_informational` |
`reject_invalid`** → `issue_reviews.critic_outcome` (+ `critic_source`
hard_filter|llm|escalation|unresolved и полная карта в `critic_assessment`), а
`mergePrecisionDecision` превращает их в `verdict` (publish / suppress). **FAIL-CLOSED:**
при полном сбое или выключенном критике (`PRECISION_CRITIC=0`) спорные замечания НЕ
публикуются автоматически — `critic_outcome=NULL`, `verdict='verify'` (полка «На
проверку», ничего не потеряно). Единственное исключение — эскалация: спорное со
`strong`-доказательствами и последствием critical/high показывается с пометкой «критик
недоступен» (цена пропуска дорогого риска выше цены лишней строки); medium/low в
эскалацию не попадают никогда. Предел спорных на прогон — `PRECISION_CRITIC_MAX`,
остаток НЕ маскируется (`summary.precision.over_limit`). Скоринг материальности вынесен в
`critic/criticScoring.js` (конвенция ≤600 строк): «как считаем» отдельно от «как
сохраняем и фильтруем». Тесты — `server/test/unit/precisionCritic.test.js` (стилистическая
правка / нет последствия / противоречие ВОР / расширение объёма / дубликат / слабое
предположение + fail-closed + границы полномочий модели) и
`server/test/integration/materiality.integration.test.js` (исходы и карта в колонках).

**Исход прогона конвейера ХРАНИТСЯ в `analysis_runs.summary`, а не выводится заново.**
`buildRunOutcome` (чистая) собирает ОДИН отчёт и для ответа API, и для записи в БД:
`status` (контракт `resultStatus`), `warnings`, причины частичного результата (`partial`),
`failed_step`, `steps[]`, **manifest входных stage-прогонов**, `started_at`/`finished_at`.
Пишется при ЛЮБОМ завершении — `activateRun` / `completeRunWithoutActivation` / `failRun`
(и `onJobSettled` для оборванного задания: `cancelled`/`interrupted` вместо голого failed).
Узкая колонка `analysis_runs.status` (`completed|failed|running`) не различает частичный
итог, поэтому источник истины — сохранённый отчёт (`parseRunOutcome`; чужой summary
(backfill/кандидат) отчётом не считается, статус тогда выводится из колонки, fail-closed).
`GET …/pipeline/status` отдаёт свежесть слоёв (`stale` + `needs_rebuild`), `active_run`
(прогон под указателем), **`last_run`** (последний прогон оркестратора, в т.ч. НЕуспешный —
провалившийся указателем не становится, но исход обязан быть виден) и верхним уровнем
`status`/`severity`/`warnings`/`partial`/`failed_step`/`stage_inputs`. После перезагрузки
страницы и рестарта процесса портал показывает ТОТ ЖЕ `completed` /
`completed_with_warnings` / `failed`. Тесты — `server/test/unit/pipeline.test.js`
(успех/частичный/сбой + повторное чтение) и
`server/test/integration/pipelineOutcome.integration.test.js` (круг через Postgres).

**Снимок НЕИЗМЕНЯЕМ: писать можно только в свой прогон-кандидат.**
`analysisRuns.beginCandidateRun` — единственный законный адресат записи слоя (пустой
прогон `status='running'`, указатель НЕ переведён); `assertRunWritable(tenderId, runId,
{kind}, tx)` — страж уровня сервиса: `completed`/`superseded`/чужой тендер/без runId →
409 `RUN_NOT_WRITABLE`. Вызывается ВНУТРИ транзакции каждого build (`SELECT … FOR UPDATE`
по строке прогона), поэтому активация не может проскочить между проверкой и записью.
`ensurePipelineRun` УДАЛЁН и возвращать его нельзя: он отдавал АКТИВНЫЙ прогон, и
`buildDraftIssues/buildIssueReviews/buildClusters/buildSelfAnalysis` без runId делали
DELETE+INSERT в уже выданном инженеру снимке. Теперь без runId каждый build пишет в НОВЫЙ
кандидат и НЕ активирует его (в ответе `run_id` + `activated:false`); одиночные
`POST …/unified|critic|clustering|self-analysis/build` — отладочные, production-снимок не
меняют, а debug-страницы читают кандидата явным `?run_id=` (плашка `CandidateRunBanner`).
Указатель переводит ТОЛЬКО оркестратор после полного успеха. **Стадия 5** не мутирует
действующий pipeline: `runStage5SelfAnalysis` заказывает у оркестратора новый снимок
(`runPipeline({withSelfAnalysis:true})`), решения прошлого снимка переносятся явно.
`ensureReviewPipeline` тоже делегирует оркестратору (свой жизненный цикл не дублирует).

**resetStage не удаляет историю.** Снимает указатели стадий ≥ N, архивирует их прогоны
(`archiveStageRunsFrom`), снимает указатель pipeline (`clearPipelinePointer` — входы
производного снимка отозваны), возвращает workflow-состояние и пишет событие
`stage.reset` в `audit_log` (что снято / что сохранено). `analysis_runs`, `issues`,
`analysis_signals` и `review_decisions` остаются в БД; **кэш частей
(`analysis_segments`) тоже НЕ чистится** — он скоуплен ревизией и гейтится
`input_hash`+`config_version` (рассинхрон невозможен), на нём держится селективный
пересчёт. **Физическое удаление — только admin-purge:** `services/admin/purgeService.js`
(чистое ядро `selectRunsToPurge`), CLI `npm run purge -- --tender <id> [--confirm <id>]
[--keep-last N] [--older-than ISO]` и `GET|POST /api/admin/tenders/:id/analysis-history/purge`
(право `admin.system`). Инварианты purge: актуальный (по указателю) и `running` прогон не
удаляются никогда, по умолчанию dry-run, удаление требует `confirm === tenderId`,
`keep_last` сохраняет последние архивы (основа переноса решений), событие идёт в аудит.
Тесты — `server/test/integration/snapshotImmutability.integration.test.js`,
`server/test/unit/adminPurge.test.js`.

**Сборка атомарна и привязана к ТОЧНОМУ набору stage-прогонов.** На старте фиксируется
**manifest входов** (`pipeline/pipelineManifest.js`, чистое ядро; хранится в
`analysis_runs.inputs_manifest`, потому что сборка идёт задачами очереди и может менять процесс):
на каждую обязательную стадию 1–4 — `stage` + `analysis_run_id` + `documents_revision_id` +
`config_version` + `status`, плюс ревизия и версия конфигурации прогона. Проверок ДВЕ:
до шагов (набор годен) и **перед активацией** (набор не изменился) — `verifyPipelineInputs`.
Нарушения (`VIOLATION.*`): `stage_run_missing`, `stage_run_not_completed`,
**`stage_pointer_stale`** (у стадии есть НОВЕЕ прогон, а актуальным остался прежний — старый
успешный снимок НЕ подставляется вместо нового упавшего), `stage_revision_mismatch`,
`stage_revision_unknown` (легаси-прогон без ревизии — стадию надо пересчитать),
`stage_pointer_moved` / `stage_run_superseded` / `documents_revision_changed` (сдвиг во время
сборки → **stale pipeline не активируется**, `report.stale_inputs`, указатель цел).
Негодные входы = отчёт `{ok:false, blocked:'inputs', violations[]}`, прогон даже не начинается
(не HTTP-ошибка). Режимы: **production** (дефолт, fail-closed — только точное `mode:'debug'`
включает другой) требует полный валидный набор и переводит указатель; **debug** — явная
ЧАСТИЧНАЯ сборка: слои считаются, но `completeRunWithoutActivation` закрывает прогон
**без перевода указателя** (`report.activated:false`). Клиент: `checkProductionPipeline`
(`utils/analysisResult.js`) — после `failed`/`cancelled`/`interrupted` стадии `runAnalysis`
production-сборку **не запускает вовсе**; debug-сборка — кнопка на debug-странице конвейера.

**Этапы 6–7 — рецензия и ВСЕ выгрузки работают от кластеров.** Source of truth: `signals → draft_issues → issue_reviews → issue_clusters → review_decisions(cluster_id) → export`. Финальный шаг «Рецензия» (`ReviewPage`), экран «Итог» (`SummaryPage`), экспорт `.docx`, HTML-preview (`reviewHtmlService.js`), review.md (`mdReview/renderer.js`) и CSV/JSON/summary.md (`exportService.js`) основным путём идут от `issue_clusters` через `server/services/review/clusterReviewService.js` (`loadClusterDecisions` — решённые, `loadClusterReviewRows` — все кластеры): одно решение на кластер пишется в `review_decisions.cluster_id`, выгрузки собираются из primary draft_issue кластера (место локализуется по тексту `source_fragment` — `reviewDocx` не переписывался). **Каждый анализ — неизменяемый снимок с `analysis_run_id`** (`analysisRuns/analysisRunsService.js`): id кластера **run-scoped** (`clusterRunId` от `tenderId + analysis_run_id + cluster_key`), поэтому кластеры разных прогонов НЕ сталкиваются по id и решения прошлого прогона НЕ приклеиваются автоматически к новому — повторный запуск не смешивает старые и новые результаты. Перенос решений между прогонами — только ЯВНЫЙ (`listCarryOverProposals` предлагает по `cluster_key`/месту/тексту, `confirmCarryOvers` подтверждает). Эндпоинты: `POST/GET /api/tenders/:id/review/clusters[...]`. **Backward-compat (fallback):** issue-level путь (`review_decisions.issue_id`, `consolidation.js` `/review/consolidated`, пер-стадийная рецензия внутри стадий 1–4) сохранён, но включается ТОЛЬКО ЯВНО — `?source=issues` (или пер-стадийный `?stage=`); авто-fallback «кластерных решений нет → issue-путь» УБРАН (пустой массив решений — не признак legacy-тендера). Фактический источник — заголовок `X-Export-Source`. Старые `issues`/`review_decisions(issue_id)` не удалялись. Полное описание сущностей, source-of-truth и end-to-end — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Экспорт незавершённой рецензии ЗАПРЕЩЁН — жёсткий серверный гейт.**
`server/services/review/reviewReadinessService.js`: `getReadiness(tenderId)` →
`{ pipeline_run_id, document_revision_id, total_clusters, decided_clusters,
rejected_clusters, accepted_clusters, unresolved_clusters, carryovers_pending,
pipeline_stale, export_allowed, reasons[] }` (чистое ядро `computeReadiness` —
офлайн-тесты). «Готово» = есть активный pipeline-снимок, он не устарел (ревизия
документов не менялась после сборки), у КАЖДОГО кластера рабочего списка
(`show_to_engineer=1`) есть решение (в т.ч. reject — «отклонить всё» тоже
завершённая рецензия), carry-over разобран. `assertReviewReady` (409
`REVIEW_NOT_READY`, отчёт в `details`) ОБЯЗАТЕЛЬНО вызывают: docx-экспорт (и его
dry-run отчёт), CSV/JSON/summary.md/review.md и `createAgreedVersion`;
`activateVersion` идёт через БОЛЕЕ СТРОГИЙ гейт `agreedVersion/activationGate.js`
(включает те же readiness-проверки + инварианты сборки и базы, см. блок
«Согласованная версия ТЗ»). Исключения из гейта: экспорт от снимка согласованной версии
(`?version_id=` — снимок создавался через тот же гейт), HTML-preview (просмотр,
не выгрузка) и явный legacy (`?source=issues`/`?stage=`). API для UI —
`GET /api/tenders/:id/review/readiness`; ExportPage показывает причины блокировки
и дизейблит кнопки. Решения в readiness фильтруются и по `analysis_run_id`
(cluster_id run-scoped, но фильтр защищает от коллизий id). Тесты —
`server/test/unit/reviewReadiness.test.js`,
`server/test/integration/reviewReadiness.integration.test.js`.

## Benchmark качества анализа

Независимый офлайн-контур `server/services/benchmark/` (matcher / evaluator /
metrics / reporter / benchmarkRunner — чистые, без БД, сети и LLM) сравнивает
результат любого алгоритма с эталонным набором: `npm run benchmark`
(`server/scripts/runBenchmark.js`, production active pointers недостижимы —
скрипт не импортирует db/connection). Набор: `benchmark/datasets/synthetic`
(`*.md` + `*.gold.json`: ожидаемые critical|working и запрещённые к публикации
замечания, точные цитаты, допустимые формулировки, обязательное основание);
результаты агента — `benchmark/runs/<имя>/*.findings.json`. Сопоставление —
4 оси (место/смысл/категория/направление действия), без требования текстового
совпадения. Метрики: precision, recall, precision@10/20, recall критических,
duplicate rate, informational leakage, unsupported rate, замечания без
последствия. **Реальные тендерные документы — только в `benchmark/local/`
(в .gitignore), в репозиторий не коммитятся**; отчёты — `benchmark/results/`
(тоже игнорируется). Формат — `benchmark/README.md`, тесты —
`server/test/unit/benchmark/`.

## .env

Один `.env` в корне репозитория. Шаблон рядом — `.env.example`. Сервер подгружает из корня через `dotenv.config({ path: '../../.env' })` (относительно `server/app.js` и `server/db/seed.js`).
