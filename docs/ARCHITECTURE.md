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
| **Показывать ли замечание инженеру** (материальность) | `review/materiality.js` (матрица `impact_level` × `evidence_level` → `verdict`), считает `critic/criticScoring.js`; свёртка на кластер — `clustering/clusteringService.js` | `criticality` агента и `confidence` модели — легаси-сортировка (`score`, `display_priority`), на публикацию НЕ влияют |
| **Последнее слово о публикации** (фильтрация draft_issues) | `critic/precision/` — precision-критик: уровень 1 детерминированные жёсткие фильтры (`hardFilters.js`), уровень 2 отдельная LLM-проверка спорных (`llmCritic.js`). Исход в `issue_reviews.critic_outcome`, карта из 9 измерений в `critic_assessment` | оценка материальности — только ВХОД критика; при сбое критика спорные medium/low не публикуются (`verdict='verify'`) |
| Названия стадий | сервер `STAGE_LABELS` (`stageAnalysisEngine.js`), клиент `STAGE_META` (`client/src/utils/labels.js`) — тексты должны совпадать | не хардкодить в других местах |
| Зоны ответственности агентов (`problem_type` по стадии) | `review/stageDomains.js` | — |
| «Вид решения» (delete vs вынести vs правка vs примечание) в docx/preview/md | `review/decisionModel.js` (`decisionVisual` + `resolveRedaction`) | — |

> **Этапы 6–7 — рецензия и ВСЕ выгрузки переведены на кластеры.** Финальный шаг мастера
> «Рецензия», экспорт `.docx`, HTML-preview, review.md и CSV/JSON/summary.md работают от
> `issue_clusters` через `review/clusterReviewService.js`: одно решение на кластер
> (`review_decisions.cluster_id`), выгрузки собираются из primary draft_issue кластера
> (docx/preview/md локализуют место по тексту `source_fragment`, поэтому переписывать
> `reviewDocx` не понадобилось). id кластера **run-scoped** (`analysisRuns.clusterRunId`
> от `tenderId + analysis_run_id + cluster_key`): каждый анализ — неизменяемый снимок, кластеры
> разных прогонов не сталкиваются по id, повторный запуск не смешивает результаты, а перенос
> решений на новый прогон — только явный (`listCarryOverProposals` → `confirmCarryOvers`).
> **Backward-compat:** issue-level путь (`review_decisions.issue_id`,
> `consolidation.js`, пер-стадийная рецензия внутри стадий 1–4) сохранён как fallback; каждая
> выгрузка авто-падает на него, когда кластеров/кластерных решений нет, и принудительно — по
> `?source=issues` (фактический источник виден в `X-Export-Source`). Старые
> `issues`/`review_decisions(issue_id)` не удалялись.

> **Инженер по умолчанию видит только МАТЕРИАЛЬНЫЕ коммерческие и договорные риски.**
> Публикацию решает модель материальности (`review/materiality.js`): `impact_level`
> (`critical|high|medium|low|none`, считается по материальным критериям компании) ×
> `evidence_level` (`strong|medium|weak`, считается по структуре находки) → `verdict`
> (`publish|verify|suppress`). `low`/`none` не публикуются никогда; `critical|high` со
> слабыми доказательствами уходят в `verify`; редактура, дубли, стандартные требования и
> неподтверждённые предположения — в `suppress` с причиной. Поля живут на всех трёх слоях
> (`draft_issues` — мнение агентов, `issue_reviews` — авторитетный вердикт, `issue_clusters` —
> свёртка на объект рецензии) вместе с `impact_dimensions`, `publication_reason`,
> `suppression_reason` и `required_action`. Ничего не удаляется: режимы выборки
> `working` (publish) / `verify` / `important` / `full` — это SQL по `verdict`.

> **Публикацию решает PRECISION-КРИТИК — независимая двухуровневая проверка**
> (`critic/precision/`). Уровень 1: детерминированные жёсткие фильтры (редактура,
> повтор, нет последствия, пробел покрытия ВОР, расширение объёма) — решают большинство
> случаев без модели. Уровень 2: отдельная LLM-проверка ТОЛЬКО спорных, с установкой
> «искать основания НЕ показывать»; ей не показывают ни `confidence`, ни `criticality`
> агента, и она может лишь ужесточить решение (`low`/`none` не публикуются, повтор не
> отменяется). Исходы `publish_critical` / `publish_working` / `hide_informational` /
> `reject_invalid` ложатся в `issue_reviews.critic_outcome`, оценка по 9 измерениям — в
> `critic_assessment`. При сбое или выключении критика спорные medium/low НЕ публикуются
> автоматически: `verdict='verify'`, полка «На проверку».

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
2. Прогоняет чистые эвристики (пропуски/слабые/противоречия/обогащение) + LLM-QC по
   ЧАСТЯМ ТЗ (`stage5_llm.js`), пишет `self_analysis_results`.
3. **Не пишет issues** (`runStage5SelfAnalysis` возвращает `issues=[]`).
4. **Исход слоя явный** (`resolveSelfAnalysisOutcome`, чистая, fail-closed):
   `completed` (все части) · `completed_with_warnings` + `failed_parts` (часть упала) ·
   `failed` — 0 из N частей: `buildSelfAnalysis` БРОСАЕТ, эвристики успехом не выдаются.
   «QC не запускался» — отдельные исходы, не сбой: `not_applicable` (кластеров нет) и
   `skipped` (нет `OPENAI_API_KEY`) — оба видны в `summary.llm_status`, второй помечает
   прогон warning. Исход шага/стадии — `summary.status` (контракт `analysis/resultStatus`).

> Слои 2–4 можно собрать и явно/раньше: `POST …/unified/build` → `POST …/critic/build` →
> `POST …/clustering/build`, либо все слои 2–5 одним вызовом через оркестратор
> `POST …/pipeline/run` (`services/pipeline/analysisPipeline.js`; тело
> `{with_self_analysis:false}` — без QC-шага, единственного с LLM). Порядок шагов фиксирован
> зависимостями; после сбоя шага остальные `skipped`, отчёт `{ok, failed_step, steps[]}`
> предсказуем (сбой шага ≠ HTTP-ошибка). Отчёт прогона ЦЕЛИКОМ сохраняется в
> `analysis_runs.summary` (`status`/`warnings`/`partial`/`failed_step`/`steps[]`/manifest
> входов/`started_at`/`finished_at`), поэтому исход переживает перезагрузку страницы и
> рестарт процесса. `GET …/pipeline/status` = свежесть слоёв (count/built_at/`stale` на
> слой: пуст при непустом родителе или собран раньше родителя; сводный `needs_rebuild`)
> + `active_run` (под указателем) + `last_run` (последний прогон оркестратора, в т.ч.
> неуспешный) + верхнеуровневые `status`/`severity`/`warnings`/`partial`/`failed_step`/
> `stage_inputs`. Чтение каждого слоя — с фильтром важности
> `?mode=important|working|full`. Debug-страницы (по прямому URL):
> `/tenders/:id/debug/signals|draft-issues|issue-reviews|clusters|self-analysis|pipeline`.

**C1. Неизменяемость снимков.** Писать слой можно ТОЛЬКО в свой прогон-кандидат:
`analysisRuns.beginCandidateRun` (пустой прогон `running`, указатель не переведён) +
`assertRunWritable` внутри транзакции build (`SELECT … FOR UPDATE` по строке прогона) →
`completed`/`superseded`/чужой тендер/без runId дают 409 `RUN_NOT_WRITABLE`. Функция
`ensurePipelineRun` удалена (она отдавала активный прогон, и build без runId перезаписывал
действующий снимок). Одиночные `…/build` — отладочные: пишут в новый кандидат, возвращают
`run_id` + `activated:false`, читаются через `?run_id=`; указатель переводит только
оркестратор по полному успеху. Стадия 5 и `ensureReviewPipeline` заказывают снимок у
оркестратора, а не правят действующий.

**C1a. resetStage и admin-purge.** Сброс стадии — операция указателей и workflow-состояния:
снимает указатели стадий ≥ N (+ архивирует их прогоны), снимает указатель pipeline,
возвращает статусы стадий и пишет `stage.reset` в `audit_log`; `analysis_runs`, `issues`,
`analysis_signals`, `review_decisions`, `analysis_run_segments` (история выполнения частей)
НЕ удаляются — чистятся только проекции: `tz_excluded_ranges` и `analysis_segments` (кэш частей). Физическое удаление — единственная точка:
`services/admin/purgeService.js` (CLI `npm run purge`, `GET|POST
/api/admin/tenders/:id/analysis-history/purge`, право `admin.system`); dry-run по умолчанию,
удаление по `confirm === tenderId`, актуальный и `running` прогон неудаляемы, `keep_last`
сохраняет последние архивы, событие идёт в аудит.

**C2. Атомарность сборки: manifest входов.** Конвейер собирается не «из того, что лежит в БД»,
а из ТОЧНОГО набора stage-прогонов, зафиксированного на старте (`services/pipeline/pipelineManifest.js`,
хранится в `analysis_runs.inputs_manifest` — сборка идёт задачами очереди и может менять процесс):
на каждую стадию 1–4 `stage` + `analysis_run_id` + `documents_revision_id` + `config_version` +
`status`. Набор проверяется дважды — ДО шагов и ПЕРЕД АКТИВАЦИЕЙ (`verifyPipelineInputs`):

| нарушение | смысл |
| --- | --- |
| `stage_run_missing` | у обязательной стадии нет снимка (не гонялась / указатель снят `resetStage`) |
| `stage_run_not_completed` | снимок стадии не `completed` (failed / cancelled / interrupted / running) |
| `stage_pointer_stale` | у стадии есть БОЛЕЕ НОВЫЙ прогон, а актуальным остался прежний: старый успешный снимок не подставляется вместо нового неуспешного |
| `stage_revision_mismatch` / `stage_revision_unknown` | стадия посчитана по другой (или неизвестной) ревизии документов |
| `stage_pointer_moved` / `stage_run_superseded` / `documents_revision_changed` | входы изменились ВО ВРЕМЯ сборки → снимок stale |

Негодные входы → прогон не начинается: `{ok:false, blocked:'inputs', violations[]}` (не HTTP-ошибка).
Сдвиг во время сборки → `{ok:false, stale_inputs:true, activated:false}`, `failRun`, указатель цел.
Режимы: **production** (дефолт; только точное `mode:'debug'` переключает — fail-closed) требует
полный валидный набор и переводит указатель; **debug** — явная частичная сборка:
`completeRunWithoutActivation` (прогон `completed` + сразу `superseded_at`) — слои доступны по
своему `analysis_run_id`, но основной указатель НЕ двигается и чтения портала их не видят.
Клиент после `failed`/`cancelled`/`interrupted` стадии production-сборку не запускает
(`checkProductionPipeline` в `client/src/utils/analysisResult.js`).

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
собрало. **Прогон стадии создаётся ПРИ ПОСТАНОВКЕ задания в очередь**, до запуска
LLM-оркестратора (`engine.startStageBackground` → `beginStageRun`): `status='running'`,
реальные `started_at` / `documents_revision_id` / `config_version`. Один прогон на
задание — повторная попытка задачи продолжает его (части ТЗ поднимаются из кэша), а не
заводит второй снимок; активируется он только по успеху, поэтому повтор после сбоя не
«дописывает» в уже опубликованный снимок.

**Терминальный исход пишется в ТОТ ЖЕ прогон.** Успех — `activateRun` (`completed` +
перевод указателя). Неуспех — `engine.finalizeStageRun`: `failed` | `cancelled` |
`interrupted` (исходы не схлопываются в общий failed), реальный `finished_at`, а в
`summary` — `error` и `failed_segment_index` (часть ТЗ, на которой встал прогон).
Отдельной «фиктивной» failed-строки не создаётся: прежний `recordFailedRun` вставлял
вторую строку с `started_at = finished_at`, без ревизии и версии конфигурации, а
настоящий прогон навсегда оставался `running`. Владелец финализации — тот, кто прогон
создал: задание завершает `handlers/stageAnalysisJob.onJobSettled`, синхронный вызов —
сам движок. Прогон, оставшийся `running` без единого живого задания (процесс умер),
закрывается как `interrupted` на старте сервера и воркера
(`engine.recoverOrphanedStageRuns`; прогон, который ведёт другой воркер, защищён живым
заданием), а начало нового прогона стадии закрывает прежний `running` этой же стадии.

**Части ТЗ: кэш ↔ история.** `analysis_segments` — кэш результата части, скоупленный
ревизией документов (переиспользование при совпадении `input_hash` + `config_version`);
`analysis_run_segments` — неизменяемая история выполнения, одна строка на
`(analysis_run_id, segment_index)`, пишет только прогон-владелец и только пока он
`running`. Поэтому два последовательных прогона видны рядом: где встал первый и что
переиспользовал второй (`source` = `llm` | `cache` | `checkpoint`). Точечный retry гасит
кэш ОДНОЙ части и историю не трогает. Сценарии — `server/test/integration/
stageRunLifecycle.integration.test.js` (сбой в середине документа, рестарт воркера,
пересчёт одной части, история двух прогонов).

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
