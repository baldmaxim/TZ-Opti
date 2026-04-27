# TZ-Opti

MVP-портал для инженера тендерного отдела строительной компании. Анализ ТЗ на СМР по 4-стадийному последовательному пайплайну с экспортом исходного `.docx` с правками и комментариями в логике Word Review.

---

## Что это и для кого

Инженер тендерного отдела участвует в тендерах на ЖК в Москве (генподряд + коробка). Каждый тендер требует:
- сверки ТЗ с ПД/РД и ВОР,
- сверки ТЗ с принятыми бизнес-решениями (Q&A форма),
- проверки против типовых рисков,
- поиска скрытых работ, двусмыслий, влияния на срок,
- формирования итогового файла с замечаниями.

Портал собирает все материалы в одной карточке тендера и проводит инженера через 4 стадии анализа. Результат — исходный ТЗ.docx, в который встроены комментарии Word и визуальные пометки по принятым решениям.

---

## Архитектура

```
┌─────────────────┐         REST JSON         ┌──────────────────────┐
│  client (Vite)  │ ◀────────────────────────▶│  server (Express)    │
│  React + JS     │                            │  better-sqlite3      │
│  Tailwind +     │                            │  Multer • Mammoth    │
│  Zustand        │                            │  XLSX • pdf-parse    │
│  React Router   │                            │  pizzip + xmldom     │
└─────────────────┘                            └──────────┬───────────┘
                                                          │
                                                          ▼
                                            ┌──────────────────────────┐
                                            │ SQLite (server/db/)      │
                                            │ uploads/  (Multer files) │
                                            └──────────────────────────┘
```

---

## Стек

- **Frontend**: Vite, React 18, JS (без TypeScript), React Router, Tailwind CSS, Zustand
- **Backend**: Node.js, Express, better-sqlite3, Multer
- **Извлечение текста**: mammoth (.docx), pdf-parse (.pdf), xlsx (.xlsx), нативный fs (.txt/.md/.csv)
- **Экспорт .docx**: pizzip + @xmldom/xmldom + xpath — модификация исходного `.docx` с вставкой комментариев Word и визуальным вычёркиванием

Никакого TypeScript на клиенте, Redux, MUI/AntD. UI на русском, код на английском.

---

## Запуск

Требуется Node.js ≥ 18.

```bash
# 1. Установить зависимости root + client + server
npm run install:all

# 2. Запустить dev-серверы (server :4000, client :5173)
npm run dev
```

Откроется `http://localhost:5173`. SQLite БД (`server/db/tender.db`) создаётся автоматически на старте, демо-данные (2 тендера) подгружаются при первом запуске.

Команды:

| Скрипт | Действие |
|--------|----------|
| `npm run install:all` | npm install в root, server, client |
| `npm run dev` | concurrently: server + client |
| `npm run dev:server` | только сервер |
| `npm run dev:client` | только клиент |
| `npm run seed` | принудительный сброс и пересоздание demo-данных (`node server/db/seed.js -f`) |
| `npm run build` | production-сборка клиента |

---

## Структура проекта

```
TZ-Opti/
├── client/    Vite + React + Tailwind + Zustand
│   └── src/
│       ├── pages/         DashboardPage, TenderPage + tabs/*
│       ├── components/    UI, layout, stages, tables, tender, ui
│       ├── store/         Zustand (tenders, активный тендер, тосты)
│       ├── services/api.js
│       └── utils/         labels, format
└── server/    Express + SQLite + Multer
    ├── app.js
    ├── routes/            tenders, documents, checklist, conditions, risks,
    │                      objectInfo, qa, stages, decisions, review, export
    ├── controllers/       тонкие контроллеры под каждый route
    ├── services/
    │   ├── textExtractionService.js
    │   ├── tzActiveTextService.js                 — ТЗ за вычетом исключённых фрагментов
    │   ├── stageAnalysis/
    │   │   ├── stageAnalysisEngine.js             — оркестратор 4 стадий
    │   │   ├── stage1_checklistVor.js
    │   │   ├── stage2_characteristics.js
    │   │   ├── stage3_risks.js
    │   │   ├── stage4_selfAnalysis.js
    │   │   └── shared/ (phrases, fragmentMatcher)
    │   ├── qaImportService.js                     — парсер Q&A xlsx
    │   ├── reviewDocx/                            — главный артефакт
    │   │   ├── index.js
    │   │   ├── docxPackage.js
    │   │   ├── quoteLocator.js
    │   │   ├── runSplitter.js
    │   │   ├── commentWriter.js
    │   │   ├── strikeWriter.js
    │   │   ├── trackChangesWriter.js              — STUB (см. ниже)
    │   │   └── manifestUpdater.js
    │   ├── reviewHtmlService.js                   — HTML-preview
    │   └── exportService.js                       — CSV / JSON / summary.md
    └── db/
        ├── schema.sql
        ├── migrate.js
        ├── seed.js
        └── fixtures/                              — ТЗ.docx, ВОР.xlsx, Q&A.xlsx генерируются программно
```

---

## Полный путь инженера

1. **Создать тендер** на дашборде («+ Создать тендер»).
2. **Документы**: загрузить ТЗ.docx, ПД/РД, ВОР.xlsx и сопутствующие материалы. Текст извлекается автоматически.
3. **Состав работ**, **Условия компании**, **База рисков**, **Доп. информация** — заполнить (или отредактировать готовое seed).
4. **Стадии анализа**:
   - **Стадия 1** (ТЗ + Чек-лист + ВОР): запустить → пройти таблицу решений (принять / редактировать / отклонить / удалить из ТЗ) → завершить стадию.
   - **Стадия 2** (ТЗ + Q&A форма + Таблица характеристик): загрузить `.xlsx` Q&A формы → запустить анализ → пройти таблицу → завершить.
   - **Стадия 3** (типовые риски): запустить → пройти таблицу → завершить.
   - **Стадия 4** (самоанализ ТЗ: скрытые работы, двусмыслия, влияние на срок): запустить → пройти таблицу → завершить.
5. **Рецензия** (опционально): сквозной режим прохода всех `pending`-замечаний по всем стадиям.
6. **Экспорт**: скачать ТЗ.docx с правками и комментариями. Дополнительно: HTML-preview, CSV/JSON/Markdown.

Каждое решение «удалить из ТЗ» / «вынести из объёма» **исключает фрагмент из активного текста** для следующих стадий. Возврат к предыдущей стадии **каскадно сбрасывает** все стадии после неё (с подтверждением).

---

## Q&A форма (Стадия 2): xlsx-формат

Один лист, первая строка — заголовки. Колонки:

| Вопрос | Ответ | Принятое решение | Источник характеристики | Значение |
|--------|-------|------------------|------------------------|----------|

Пример строки:
```
Бетон давальческий?  | Нет, поставка ГП  | Поставка ГП  | Бетон   | поставка генподрядчиком
```

При импорте: каждая строка → `qa_entries`, при наличии «Источник характеристики» создаётся запись в `characteristics` (вход для Стадии 2).

Готовая фикстура: `server/db/fixtures/QA_Severnyy.xlsx` (генерируется seed).

---

## Что работает / Что mock / Что следующая задача

| Возможность | Статус |
|-------------|--------|
| CRUD тендеров, документов, чек-листа, условий, рисков, доп. инфо, Q&A | ✅ Реализовано |
| Извлечение текста (.docx / .pdf / .xlsx / .txt) | ✅ Реализовано |
| Rule-based 4-стадийный пайплайн (Чек-лист+ВОР, Q&A, Риски, Самоанализ) | ✅ Реализовано — **mock** (см. ниже) |
| Реестр Issue + рецензия по стадиям + сквозной reviewer | ✅ Реализовано |
| Каскадный сброс стадий, исключение фрагментов из активного текста | ✅ Реализовано |
| Экспорт `.docx` с комментариями (Word Comments API) + визуальное strike для удалений | ✅ Реализовано |
| HTML-preview рецензии | ✅ Реализовано |
| CSV / JSON / Markdown summary экспорты | ✅ Реализовано |
| Настоящий Track Changes (`w:ins` / `w:del`) | ⚙️ Архитектура готова: `server/services/reviewDocx/trackChangesWriter.js` (stub), единый контракт операций. Реализация — следующая задача. |
| Q&A форма прямо в портале (вместо xlsx-загрузки) | ⚙️ Контракт `qaImportService` совместим. Следующая задача — UI-страница ввода. |
| LLM-анализатор | ⚙️ Интерфейс `stageAnalysisEngine.runStage(N, context)` стабилен. Mock легко заменить плагином к LLM. |

### «Mock» — что это значит для анализатора

Анализатор — rule-based. Использует:
- словари маркеров (см. `server/services/stageAnalysis/shared/phrases.js`),
- регулярные выражения и частичное совпадение фраз,
- сверку флагов чек-листа против факта присутствия в текстах,
- keyword-match шаблонов рисков и характеристик.

В UI каждая карточка Issue помечена бейджем «эвристика», у каждого замечания виден `basis` (что именно сработало). Это не «чёрный ящик» и не «AI-результат». Замена rule-based слоя на LLM — отдельная итерация.

---

## Принятые инженерные решения

1. **Без LLM** в первой версии: rule-based + heuristics. Интерфейс `stageAnalysisEngine.runStage(N, context)` стабилен, замена прозрачна.
2. **Tailwind**, не CSS modules: один источник правды, минимум boilerplate.
3. **Zustand**, не Context API/Redux: меньше шума.
4. **better-sqlite3**, не sqlite3: синхронный API → проще транзакции, нет колбэк-ада.
5. **pizzip + @xmldom/xmldom**, не `docx` npm: модификация исходного .docx даёт настоящий «Word Review feel» (комментарии в правой панели Word, исходное форматирование сохранено). `docx` npm генерирует с нуля и не подходит для главного юзкейса.
6. **«Вычеркнутый» фрагмент** = только Issue с действием `delete` / `remove_from_scope`. Остальные принятые правки видимы для следующих стадий и попадают в `.docx` как комментарии. Это решение, явно зафиксированное пользователем.
7. **Q&A через xlsx**: упрощает текущую итерацию, отдельный UI на портале — следующая задача.
8. **Каскадный сброс** при возврате к предыдущей стадии: гарантирует консистентность экспорта.
9. **Strike + комментарий** вместо настоящего `w:del`: ближайшая визуализация без полного OOXML Track Changes. Архитектура готова под swap (`trackChangesWriter.js`).

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

GET    /api/tenders/:id/object-info
PUT    /api/tenders/:id/object-info

POST   /api/tenders/:id/qa/import                    multer .xlsx
GET    /api/tenders/:id/qa
GET    /api/tenders/:id/characteristics
PATCH  /api/characteristics/:charId

GET    /api/tenders/:id/stages
POST   /api/tenders/:id/stages/:n/run
POST   /api/tenders/:id/stages/:n/finish
POST   /api/tenders/:id/stages/:n/reset
GET    /api/tenders/:id/stages/:n/issues             ?criticality=&review_status=

PATCH  /api/issues/:id                               review_status, edited_redaction, selected_for_export
POST   /api/issues/:id/decision                      {decision, edited_redaction, final_comment}

GET    /api/tenders/:id/review/preview               HTML
GET    /api/tenders/:id/export/docx
GET    /api/tenders/:id/export/issues.csv
GET    /api/tenders/:id/export/issues.json
GET    /api/tenders/:id/export/summary.md
```

---

## Демо-данные

`server/db/seed.js` создаёт:
- 2 тендера: «ЖК Северный — Корпус 5 (монолит + кладка)» и «ЖК Заречный — генподряд полного цикла».
- Для «Северного»: ТЗ.docx + ВОР.xlsx + ПД.txt + 12 строк чек-листа + 6 условий + 5 локальных + 1 глобальный риск + Q&A.xlsx.
- Для «Заречного»: ТЗ.docx + минимальный чек-лист + 2 условия.

Принудительный пересеев:
```bash
npm run seed   # выполняет: node server/db/seed.js -f
```

---

## Тест-сценарий end-to-end

1. `npm run install:all && npm run dev` → открыть `http://localhost:5173`.
2. Видны 2 demo-тендера → открыть «ЖК Северный».
3. Таб **Документы**: 4 файла (ТЗ.docx, ВОР.xlsx, ПД.txt, QA.xlsx), статус «текст извлечён».
4. Таб **Состав работ / Условия / Риски / Доп. инфо** — данные заполнены.
5. Таб **Стадии**:
   - Стадия 1 → «Запустить анализ» → 5–10 замечаний → принять/отредактировать/удалить из ТЗ → «Завершить стадию».
   - Стадия 2: загрузить `QA_Severnyy.xlsx` (можно через таб «Документы» или Stage2Card) → характеристики появляются → «Запустить анализ» → решения → «Завершить».
   - Стадия 3 → запустить → решения → завершить.
   - Стадия 4 → запустить → 10–20 замечаний (двусмыслия / скрытые / срок) → решения → завершить.
6. Проверить **каскадный сброс**: вернуться к Стадии 2 → подтвердить → стадии 3 и 4 очищаются.
7. Таб **Экспорт** → «Скачать ТЗ.docx с правками» → открыть в Word: видны Comments в правой панели, фрагменты с решением «Удалить из ТЗ» зачёркнуты красным.
8. «Открыть HTML-preview» → корректно отрисовывается в браузере.
9. CSV / JSON / Markdown — скачиваются, открываются.

---

## Ограничения MVP

- Анализатор — rule-based, не LLM. См. раздел «Mock».
- Track Changes (`w:ins` / `w:del`) — следующая задача. Сейчас «удаления» отображаются как `<w:strike/>` + красный цвет + комментарий. Для большинства бизнес-сценариев этого достаточно: рецензент видит зачёркнутый текст и комментарий рядом.
- Q&A форма принимается только через xlsx-загрузку. UI прямо в портале — следующая задача.
- Главный экспорт `.docx` работает только если оригинальный ТЗ загружен в формате `.docx`. Если ТЗ в PDF — используйте HTML-preview.
- Нет аутентификации/авторизации — это локальный инструмент инженера, не SaaS.
- Адаптивность desktop-first; на мобильных таблицы прокручиваются.
