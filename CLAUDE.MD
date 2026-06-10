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

Экспорт `/api/tenders/:id/export/docx` собирает исходный ТЗ.docx с настоящими Word Track Changes и комментариями: `delete` → `w:del`, `remove_from_scope` → `w:del` + комментарий-тег «Вынесено из объёма», `edit` → `w:del` + `w:ins`, «Примечание» (accept) → Word-комментарий (`server/services/reviewDocx/trackChangesWriter.js`, `commentWriter.js`). Запасной путь при сбое track-change — Word-комментарий (`status='fallback'` в отчёте).

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

Стадии 1–4 — пара файлов в `server/services/stageAnalysis/`: `stageN_llm.js` (логика стадии + схема находки) и `stageNPrompts.js` (системный промт: общий блок `SHARED` + 3 режима `structural` | `strict` | `full`, переключатель env `STAGE{N}_PROMPT_VARIANT`, дефолт `structural`). Общий каркас (сегментация / локализация фрагмента / дедуп / раннер) — в `shared/llmStage.js`. Движок и статусы стадий — в `stageAnalysisEngine.js`. Прежний rule-based слой (`stage*_*.js` без `_llm`, `shared/phrases.js`) удалён.

**Стадия 5 — QC, не добытчик issues.** `runStage5SelfAnalysis` в движке возвращает `issues=[]` (после прогона `SELECT COUNT(*) FROM issues WHERE analysis_stage=5` = 0) и вместо этого пишет в `self_analysis_results` через `selfAnalysis/selfAnalysisService.js` (5-й слой конвейера, см. ниже). `stage5_llm.js` — QC-агент над кластерами (без сегментации текста).

После стадий 1–4 решения с действием `delete` / `remove_from_scope` исключают фрагменты из активного текста для следующих стадий.

**Зоны ответственности и сборка итога.** Каждый агент 1–4 пишет ТОЛЬКО в свой домен `problem_type` — единый реестр `server/services/review/stageDomains.js` (Stage1 покрытие расчёта; Stage2 Q&A+характеристики; Stage3 условия; Stage4 риски); движок логирует находки вне домена (`off_domain` в summary). Слой сборки `server/services/review/consolidation.js` (`consolidate(tenderId)`) сводит находки разных стадий, указывающие на одно место ТЗ (абзац + перекрытие char-диапазонов; фолбэк — цитата), в группы: **primary** по критичности (тай-брейк — порядок стадий), прочие — `related`, конфликты помечаются (решает инженер). Один итог: `GET /api/tenders/:id/review/consolidated` → экран «Итог» (`client/src/pages/result/SummaryPage.jsx`). Экспорт берёт **одно** решение на место (primary; дубли попадают в отчёт экспорта как `skipped`) через `dedupeExportDecisions`. Тесты слоя — `server/test/consolidation.test.js`.

**Конвейер анализа (signals → draft_issues → critic → clustering → self-analysis).** Поверх стадий работает основной аналитический конвейер: стадии 1–4 добывают находки → движок пишет их сигналами (`signals/signalWriter.js`, авто, best-effort) → `unifiedAnalysis/unifiedIssueBuilder.js` (draft_issues) → `critic/criticService.js` (значимость) → `clustering/clusteringService.js` (кластеры) → `selfAnalysis/selfAnalysisService.js` (QC, Стадия 5). Каждый слой — таблица + сервис + контроллер + роут + debug-страница + офлайн-тест чистых функций.

**Этап 6 — финальная рецензия и экспорт работают от кластеров.** Финальный шаг «Рецензия» (`ReviewPage`), экран «Итог» (`SummaryPage`) и экспорт `.docx` основным путём идут от `issue_clusters` через `server/services/review/clusterReviewService.js`: одно решение на кластер пишется в `review_decisions.cluster_id`, экспорт собирается из primary draft_issue кластера (docx локализует место по тексту `source_fragment` — `reviewDocx` не переписывался). id кластера **детерминирован** (`clusteringService.clusterId` от `tenderId + cluster_key`), поэтому решение по `cluster_id` переживает идемпотентную пересборку конвейера. Эндпоинты: `POST/GET /api/tenders/:id/review/clusters[...]`. **Backward-compat (fallback):** issue-level путь (`review_decisions.issue_id`, `consolidation.js` `/review/consolidated`, пер-стадийная рецензия внутри стадий 1–4) сохранён; экспорт авто-падает на него (`?source=issues` или когда кластерных решений нет). Старые `issues`/`review_decisions(issue_id)` не удалялись. Полное описание сущностей, source-of-truth и end-to-end — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## .env

Один `.env` в корне репозитория. Шаблон рядом — `.env.example`. Сервер подгружает из корня через `dotenv.config({ path: '../../.env' })` (относительно `server/app.js` и `server/db/seed.js`).
