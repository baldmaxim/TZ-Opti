# Архитектура анализа — developer doc

Краткий справочник для разработчика: какие сущности идут по этапам, что является
source of truth, и как один тендер проходит весь pipeline. Пользовательский обзор —
в [../README.md](../README.md), инструкция для Claude Code — в [../CLAUDE.md](../CLAUDE.md).

**Главная цепочка (этапы 6–7) — source of truth всего результата:**

```
signals → draft_issues → issue_reviews → issue_clusters → review_decisions(cluster_id) → export
```

Стадии 1–4 добывают находки; конвейер сводит их в кластеры; инженер принимает **одно
решение на кластер** (`review_decisions.cluster_id`); из решений по кластерам собираются
ВСЕ выгрузки: `.docx` с Track Changes, HTML-preview, review.md, CSV/JSON/summary.md и
экраны «Рецензия»/«Итог».

В системе при этом **два сцепленных слоя**, и важно их не путать:

- **Конвейер анализа + cluster-review** (основной путь) — `signals → draft_issues →
  critic → clustering (→ self-analysis QC)` и поверх него `review/clusterReviewService.js`:
  решения инженера по кластерам и все выгрузки.
- **Issue-level backbone (legacy-fallback)** — таблица `issues` + `review_decisions(issue_id)`.
  Здесь живут находки стадий 1–4 как редактируемые записи и пер-стадийная рецензия
  внутри стадий (она же управляет `tz_excluded_ranges`). Как путь финальной рецензии и
  выгрузок используется только fallback-ом: когда кластеров/кластерных решений нет
  (конвейер не собран, старый тендер) или запрошен явный `?source=issues`.

```
        ┌──────────────────── ISSUE-LEVEL BACKBONE (legacy-fallback) ─────────────────────────┐
        │                                                                                     │
Стадии 1–4 ──▶ issues ──▶ review_decisions(issue_id) ──▶ пер-стадийная рецензия,             │
(LLM-агенты)     │         tz_excluded_ranges; consolidation ──▶ fallback выгрузок            │
        │        │                                                                            │
        └────────┼────────────────────────────────────────────────────────────────────────-─┘
                 │ writeSignalsForStage (авто, best-effort)
                 ▼
        ┌──────────────────────── ОСНОВНОЙ ПУТЬ (этапы 6–7) ──────────────────────────────────┐
        │ 1. signals ─▶ 2. draft_issues ─▶ 3. critic ─▶ 4. clustering ─▶ 5. self-analysis      │
        │ analysis_signals  draft_issues   issue_reviews  issue_clusters    self_analysis_…    │
        │                                                 issue_cluster_items                  │
        │                                                       │                              │
        │                        review_decisions(cluster_id) ◀─┴── инженер («Рецензия»)       │
        │                                     │                                                │
        │     .docx (Track Changes) · HTML-preview · review.md · CSV/JSON/summary.md · «Итог» │
        └─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Сущности по этапам

Каждая строка — что появляется на этапе, в какой таблице, кто пишет, из чего читает.

| # | Этап | Таблица | Пишет (сервис · функция) | Вход | Идемпотентность |
|---|------|---------|--------------------------|------|------------------|
| — | Импорт ВОР | `vor_items` | `vor/vorImportService.js` · `importVorFile` | xls/xlsx в слоте `vor` (при загрузке документа) | позиции тендера заменяются целиком в одной транзакции |
| — | Стадии 1–4 (добыча) | `issues`, `analysis_runs` | `stageAnalysis/stageAnalysisEngine.js` · `runStageInner` → `stageN_llm.js` | ТЗ.md + справочники стадии (чек-лист/**`vor_items`**, Q&A/характеристики, условия, риски) | при ре-ране удаляются `pending`-issues стадии |
| 1 | signals | `analysis_signals` | `signals/signalWriter.js` · `writeSignalsForStage` | `issueRecords` стадии (авто, после коммита issues) | удаляет старые сигналы `(tender, stage)` перед записью |
| 2 | draft_issues | `draft_issues` | `unifiedAnalysis/unifiedIssueBuilder.js` · `buildDraftIssues` | `analysis_signals` | пересобирает все draft_issues тендера |
| 3 | critic | `issue_reviews` | `critic/criticService.js` · `buildIssueReviews` | `draft_issues` + `analysis_signals` | пересобирает все reviews тендера |
| 4 | clustering | `issue_clusters` + `issue_cluster_items` | `clustering/clusteringService.js` · `buildClusters` | `draft_issues` + `issue_reviews` | пересобирает все кластеры тендера |
| 5 | self-analysis (Стадия 5) | `self_analysis_results` | `selfAnalysis/selfAnalysisService.js` · `buildSelfAnalysis` | `issue_clusters` + `issue_reviews` + `analysis_signals` + ТЗ.md | пересобирает все QC-замечания тендера |

**Что несёт каждая сущность (ключевые поля):**

- **`vor_items`** — позиция ведомости: `position_no`, `code`, `section`, `name` (+ `name_key` для сопоставления), `unit`/`unit_raw`/`unit_known`, `quantity` (число) / `quantity_raw` (как в файле), `note`, `sheet_name`, `row_index` (строка Excel), `cells` и `merged_cells` (адреса ячеек — «где именно в ВОР»). Стадия 1 читает **их**, а не `extracted_text`.

- **`issues`** — `analysis_stage`, локализация (`paragraph_index`/`char_start`/`char_end` или `source_fragment`), `problem_type`, `criticality`, `basis`, `suggested_action`, `suggested_redaction`, `review_status` (`pending|accepted|rejected|edited`), `selected_for_export`. Это **редактируемая** запись.
- **`review_decisions`** — решение инженера по issue: `decision` (`accept|reject|edit|delete|remove_from_scope`), `edited_redaction`, `final_comment`, `target_text` (выбранная подчасть фрагмента).
- **`analysis_signals`** — `signal_type` (`coverage|decision|condition|risk` ← стадия 1–4), `source_entity_id` (= id issue), локализация + `weight` (из `confidence`), `signal_payload_json`.
- **`draft_issues`** — сводный черновик по одному месту ТЗ: `created_from_signal_ids` (JSON), `category` (свод signal_type), `basis`/`suggested_action`/`suggested_redaction`, `confidence`.
- **`issue_reviews`** — оценка значимости draft_issue: `business_impact`, `{price,schedule,contract,responsibility}_impact`, `display_priority` (`critical|high|medium|low`), `show_to_engineer` (0=мягко скрыт), `score`, `criteria_json`.
- **`issue_clusters`** / **`issue_cluster_items`** — кластер похожих замечаний одного места: `cluster_title`, `merged_basis`, `merged_recommendation`, `overall_criticality`, `semantic_bucket`, `show_to_engineer`; items связывают кластер с `draft_issue` ролью `primary|related`.
- **`self_analysis_results`** — QC-замечание о РАЗБОРЕ: `finding_type` (`missed_coverage|weak_cluster|cluster_contradiction|needs_enrichment`), `cluster_id` (адресат, NULL = про весь ТЗ), `comment`, `suggested_improvement`, `source` (`heuristic|llm`).

---

## 2. Source of truth (кто чем владеет)

| Вопрос | Source of truth | Не здесь |
|--------|-----------------|----------|
| Сырые находки стадий 1–4 | `issues` | — |
| Содержимое ВОР (позиции, объёмы, единицы, координаты) | `vor_items` (структурный импорт `vor/vorImportService.js`) | `documents.extracted_text` — только просмотр и фолбэк для ВОР не таблицей |
| **Решение инженера** по находке (этап 6) | `review_decisions.cluster_id` → `issue_clusters` (финальная рецензия). Legacy `review_decisions.issue_id` — пер-стадийная рецензия внутри стадий 1–4 | — |
| Что попадёт в `.docx` (Track Changes) | **primary:** `issue_clusters` + `review_decisions.cluster_id` (`clusterReviewService.loadClusterDecisions`). **fallback:** `issues` + `review_decisions.issue_id` (когда кластерных решений нет или `?source=issues`) | — |
| HTML-preview / review.md / CSV / JSON / summary.md (этап 7) | **primary:** те же кластерные решения (`loadClusterReviewRows` / `loadClusterDecisions`); фактический источник — в `X-Export-Source` и шапке файла. **fallback:** issue-level, когда кластеров нет или `?source=issues` | — |
| Экран «Итог» / финальная «Рецензия» | `review/clusterReviewService.js` `listReviewClusters(tenderId)` поверх `issue_clusters` | consolidation.js — legacy-fallback |
| Исключение фрагментов из активного текста для следующих стадий | `tz_excluded_ranges` (пишется в `finishStage` по `delete`/`remove_from_scope` issue-level решений стадий 1–4) | — |
| Ранжирование/группировка/полнота находок (аналитика) | конвейер: `analysis_signals` → … → `self_analysis_results` | — |
| Названия стадий | сервер `STAGE_LABELS` (`stageAnalysisEngine.js`), клиент `STAGE_META` (`client/src/utils/labels.js`) — тексты должны совпадать | не хардкодить в других местах |
| Зоны ответственности агентов (`problem_type` по стадии) | `review/stageDomains.js` | — |
| «Вид решения» (delete vs вынести vs правка vs примечание) в docx/preview/md | `review/decisionModel.js` (`decisionVisual` + `resolveRedaction`) | — |

> **Этапы 6–7 — рецензия и ВСЕ выгрузки переведены на кластеры.** Финальный шаг мастера
> «Рецензия», экспорт `.docx`, HTML-preview, review.md и CSV/JSON/summary.md работают от
> `issue_clusters` через `review/clusterReviewService.js`: одно решение на кластер
> (`review_decisions.cluster_id`), выгрузки собираются из primary draft_issue кластера
> (docx/preview/md локализуют место по тексту `source_fragment`, поэтому переписывать
> `reviewDocx` не понадобилось). id кластера **детерминирован** (`clusteringService.clusterId`
> от `tenderId + cluster_key`) — решение по `cluster_id` переживает идемпотентную пересборку
> конвейера. **Backward-compat:** issue-level путь (`review_decisions.issue_id`,
> `consolidation.js`, пер-стадийная рецензия внутри стадий 1–4) сохранён как fallback; каждая
> выгрузка авто-падает на него, когда кластеров/кластерных решений нет, и принудительно — по
> `?source=issues` (фактический источник виден в `X-Export-Source`). Старые
> `issues`/`review_decisions(issue_id)` не удалялись.

---

## 3. Как один тендер проходит pipeline (end-to-end)

**A. Подготовка (инженер).** Создать тендер → загрузить ТЗ (`.docx`/`.pdf`) и **`.md`-копию ТЗ**
(анализ идёт только по `.md`), ВОР.xlsx, заполнить чек-лист / условия / риски / характеристики /
Q&A. Эндпоинты: `documents`, `checklist`, `conditions`, `risks`, `qa`, `setupParams`.

> **ВОР загружается СТРУКТУРНО.** При загрузке документа с `doc_type='vor'` таблица
> разбирается в `vor_items` (`services/vor/`): номер позиции, шифр, раздел, наименование,
> единица (сырая и нормализованная), количество (сырое и числом), примечание, лист,
> строка Excel и адреса ячеек. Объединённые ячейки раскрываются, шапка ищется в т.ч.
> двух-трёхэтажная, разделы/итоги/пустые строки позициями не становятся. Ошибка разбора
> не роняет загрузку: остаётся `extracted_text`, причина пишется в `documents.import_report`.
> API: `GET /api/tenders/:id/vor` (позиции), `…/vor/summary`, `…/vor/matching`
> (вход сопоставления ТЗ ↔ ВОР ↔ чек-лист), `…/vor/preview` (каталог глазами модели),
> `POST …/vor/reimport`.

**B. Стадии 1–4 (добыча находок).** Для каждой стадии:
1. `POST /api/tenders/:id/stages/:n/run` — движок (`startStageBackground`) проверяет доступность
   и запускает прогон **в фоне**, сразу отвечая `{status:'running'}`. Гард: один прогон на
   `(tender,stage)`.
2. `runStageInner` собирает контекст (`buildContextForStage`), зовёт `stageN_llm.js`, в одной
   транзакции пишет `analysis_runs` + `issues` (`review_status='pending'`), ставит стадию
   `reviewing`.
3. Сразу после коммита — `writeSignalsForStage` (best-effort, своя транзакция): находки стадии
   копируются в `analysis_signals`. Сбой этого писателя не роняет стадию.
4. Клиент опрашивает `GET /api/tenders/:id/stages` (`stageN_status`: `open|running|reviewing|finished`).
5. Инженер проходит таблицу: `PATCH /api/issues/:id` и `POST /api/issues/:id/decision`
   (пишет `review_decisions`). `POST …/stages/:n/finish` фиксирует стадию, применяет
   `tz_excluded_ranges` для `delete`/`remove_from_scope` и разлочивает следующую стадию.
   Возврат назад — `POST …/stages/:n/reset` (каскадный сброс стадий ≥ N).

**C. Стадия 5 — QC над итогом (новая роль).** `POST /api/tenders/:id/self-analysis/build`
(она же `runStage5SelfAnalysis` в движке). `buildSelfAnalysis`:
1. `ensureClusters(tenderId)` — если кластеров ещё нет, **сам достраивает конвейер** из сигналов:
   `buildDraftIssues` → `buildIssueReviews` → `buildClusters`.
2. Прогоняет чистые эвристики (пропуски/слабые/противоречия/обогащение) + best-effort
   LLM-обогащение (`stage5_llm.js`), пишет `self_analysis_results`.
3. **Не пишет issues** (`runStage5SelfAnalysis` возвращает `issues=[]`).

> Слои 2–4 можно собрать и явно/раньше: `POST …/unified/build` → `POST …/critic/build` →
> `POST …/clustering/build`, либо все слои 2–5 одним вызовом через оркестратор
> `POST …/pipeline/run` (`services/pipeline/analysisPipeline.js`; тело
> `{with_self_analysis:false}` — без QC-шага, единственного с LLM). Порядок шагов фиксирован
> зависимостями; после сбоя шага остальные `skipped`, отчёт `{ok, failed_step, steps[]}`
> предсказуем (сбой шага ≠ HTTP-ошибка). Свежесть слоёв — `GET …/pipeline/status`
> (count/built_at/`stale` на слой: пуст при непустом родителе или собран раньше родителя;
> сводный `needs_rebuild`). Чтение каждого слоя — с фильтром важности
> `?mode=important|working|full`. Debug-страницы (по прямому URL):
> `/tenders/:id/debug/signals|draft-issues|issue-reviews|clusters|self-analysis|pipeline`.

**D. Рецензия, итог и выгрузки (cluster-primary).**
- `POST /api/tenders/:id/review/clusters/build` (+`?force=1`) → достроить конвейер до
  кластеров; `GET …/review/clusters` → шаг «Рецензия»: кластер + дочерние draft_issues +
  заметки self-analysis. Решение инженера: `POST …/review/clusters/:clusterId/decision`
  → `review_decisions.cluster_id` (одно активное решение на кластер).
- `GET /api/tenders/:id/export/docx` → `clusterReviewService.loadClusterDecisions` →
  `exportReviewedDocx`: кластер = единица дедупа, `delete/remove_from_scope` → `w:del`,
  `edit` → `w:del`+`w:ins`, «Примечание» → Word-комментарий. Отчёт: `GET …/export/docx/report`
  (`applied|fallback|failed|skipped`, `source`).
- `GET …/review/preview` (HTML), `GET …/export/review.md`, `GET …/export/issues.csv`,
  `GET …/export/issues.json`, `GET …/export/summary.md` — те же кластерные решения
  (`loadClusterReviewRows`); фактический источник — в `X-Export-Source` / шапке файла.
- **Legacy-fallback:** каждая выгрузка авто-падает на issue-level
  (`issues` + `review_decisions.issue_id`; `?source=issues` — принудительно);
  `GET …/review/consolidated` (`consolidate` по issues) сохранён для back-compat.

---

## 4. Слой исполнения: очередь задач (analysis_jobs / analysis_tasks)

Сущности выше отвечают на вопрос «что за данные и кто ими владеет». Очередь
отвечает на другой — «как долгая работа доводится до конца». Она ортогональна
цепочке результата: снимки (`analysis_runs`) и слои конвейера не знают, кто их
считает, а очередь не знает, что именно считается.

```
HTTP POST …/stages/:n/run          analysis_jobs        analysis_tasks           worker
      │ гейт стадии (400 сразу)   ┌─────────────┐   ┌───────────────────┐   ┌──────────────┐
      └──── enqueue ─────────────▶│ идемпот.ключ│──▶│ claim (SKIP LOCKED)│──▶│ advisory-lock│
                                  │ отмена      │   │ аренда + heartbeat│   │ handler      │
            GET /api/jobs/:id ◀───│ прогресс    │◀──│ попытки, чекпойнт │◀──│ commit/retry │
                                  └─────────────┘   └───────────────────┘   └──────────────┘
```

| Вопрос | Ответ |
|--------|-------|
| Кто владеет статусом прогона | `analysis_jobs.status` (задание) и `analysis_tasks.status` (задача). Производные состояния — `tender_stage_state.stageN_status` и `analysis_runs.status` — чинит финализатор задания (`jobs/handlers/*.onJobSettled`) |
| Кто владеет прогрессом | `analysis_tasks.progress_*` → свод в `analysis_jobs.progress_*`. Портал читает его через `jobs/jobService.stageProgress` (форма ответа `{total, done, startedAt}` не менялась) |
| Единица идемпотентности | задание: тендер + область (`stage:N` / `pipeline`) + ревизия документов + версия конфигурации. Та же тройка — ключ advisory-lock |
| Единица повтора | задача. Стадия = одна задача с чекпойнтом по сегментам ТЗ; конвейер = задача на шаг + финализатор (`always_run`) |
| Где правила | `jobs/jobModel.js` — чистые функции (готовность задачи, порядок выборки, retry/recovery, свод статуса). Их же использует офлайн-стор тестов, поэтому SQL и тесты проверяют ОДНИ правила |

Связь со снимками: задание хранит `analysis_run_id` — прогон, который оно
собрало. Каждая попытка стадии начинает свой `analysis_runs`-прогон и
активирует его только по успеху, поэтому повтор после сбоя не «дописывает» в
уже опубликованный снимок.

---

## 5. Конвенции конвейера

- **Чистые функции тестируются без БД.** Группировка/слияние/скоринг/эвристики каждого слоя —
  отдельные экспортируемые функции, покрытые офлайн-тестами (`server/test/*.test.js`, `npm test`):
  `consolidation.test.js`, `critic.test.js`, `clustering.test.js`, `selfAnalysis.test.js`,
  `clusterReview.test.js`, `clusterExports.test.js`, `pipeline.test.js`,
  `stage4Scoring.test.js`, `reviewExport.test.js`. БД и LLM в тестах не нужны.
- **Идемпотентность.** Каждый `build*` пересобирает свой слой целиком по тендеру; повторный
  вызов безопасен. Каскад FK (`ON DELETE CASCADE`) чистит зависимые слои при пересборке
  родителя — после `unified/build` нужно перезапустить `critic/build` → `clustering/build`.
- **Изоляция от backbone.** Слой signals — best-effort: его сбой не влияет на `issues`/статус
  стадии. Остальные слои конвейера запускаются отдельными эндпоинтами и не пишут в `issues`.
- **Один файл ≤ 600 строк**, UI на русском, код/имена — на английском (см. CLAUDE.md).
