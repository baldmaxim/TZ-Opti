# Benchmark-контур оценки качества ИИ-анализа ТЗ

Независимый офлайн-контур для воспроизводимого сравнения текущего и будущего
алгоритма анализа на эталонном наборе документов. Контур **не касается
production**: не подключается к БД, не читает и не переводит active pointers,
не запускает LLM. Вход и выход — только файлы.

## Структура

```
benchmark/
├── datasets/synthetic/   эталонный синтетический набор (в git)
│   ├── <doc>.md          исходный Markdown документа
│   └── <doc>.gold.json   эталон: ожидаемые и запрещённые замечания
├── runs/sample-agent/    демо-результаты агента (в git, пример формата)
│   └── <doc>.findings.json
├── local/                РЕАЛЬНЫЕ наборы и результаты — НЕ в git (.gitignore)
└── results/              отчёты прогонов — НЕ в git (.gitignore)
```

Реальные тендерные документы в репозиторий не попадают: кладите их в
`benchmark/local/` (например `benchmark/local/datasets/…` и
`benchmark/local/runs/…`) и указывайте пути флагами CLI.

## Запуск

```bash
npm run benchmark                                   # синтетический набор + sample-agent
npm run benchmark -- --dataset benchmark/local/datasets/real \
                     --findings benchmark/local/runs/candidate-v2
npm run benchmark -- --no-write                     # только консоль, без файлов отчёта
```

Отчёт (`report.json` + `report.md`) сохраняется в `benchmark/results/<алгоритм>-<время>/`.
Сравнение алгоритмов = два прогона с разными `--findings` на одном `--dataset`.

## Формат эталона (`*.gold.json`)

```json
{
  "document_id": "synt-001-unaccounted-volume",
  "source": "synt-001-unaccounted-volume.md",
  "description": "что проверяет документ",
  "expected": [
    {
      "id": "exp-001-demolition",
      "kind": "critical",                      // critical | working
      "quote": "точная цитата из source (проверяется дословно)",
      "tz_clause": "п. 3.2",
      "risk_category": "покрытие_расчёта",
      "problem_type": "не_учтено_в_вор",
      "expected_impact": "critical",           // critical|high|medium|low
      "required_action": "recalculate",        // словарь materiality.REQUIRED_ACTIONS
      "accepted_phrasings": ["допустимые формулировки замечания", "…"],
      "required_basis": "обязательное основание: чем доказывается замечание",
      "engineer_comment": "комментарий инженера — зачем этот эталон в наборе"
    }
  ],
  "forbidden": [
    {
      "id": "forb-003-sp",
      "quote": "точная цитата места, о котором нельзя публиковать замечание",
      "reason": "standard_requirement",        // словарь materiality.SUPPRESSION_FLAGS
      "accepted_phrasings": ["как обычно формулируют такую ложную находку"],
      "engineer_comment": "почему это не должно публиковаться"
    }
  ]
}
```

Валидация при загрузке: цитаты обязаны находиться в `source` дословно, словари
(`expected_impact`, `required_action`, `reason`) — из `services/review/materiality.js`.

## Формат результатов агента (`*.findings.json`)

Файл на документ (или один файл с массивом объектов):

```json
{
  "document_id": "synt-001-unaccounted-volume",
  "algorithm": "имя алгоритма (попадает в отчёт)",
  "findings": [
    {
      "id": "s1-f1", "stage": 1, "rank": 1,
      "quote": "цитата места (или source_fragment)",
      "tz_clause": "п. 3.2",
      "problem_type": "не_учтено_в_вор", "risk_category": "покрытие_расчёта",
      "impact_level": "critical", "impact_dimensions": ["price", "scope"],
      "required_action": "recalculate",
      "summary": "формулировка замечания", "basis": "основание",
      "verdict": "publish"                    // publish|verify|suppress; или published: true|false
    }
  ]
}
```

В метрики входят только ОПУБЛИКОВАННЫЕ находки (`verdict==='publish'` или
`published:true`; поле не задано — считается опубликованной). Неопубликованные
участвуют в диагностике пропусков («нашёл, но не опубликовал»).

## Сопоставление и метрики

Находка закрывает эталон по четырём осям (place / meaning / category / action —
`server/services/benchmark/matcher.js`), полное текстовое совпадение
формулировок не требуется. Метрики (`metrics.js`): precision, recall,
precision@10, precision@20, recall критических, duplicate rate, informational
leakage, unsupported rate, число замечаний без конкретного последствия.
Отчёт (`reporter.js`) перечисляет TP/FP/FN/дубли/утечки/находки без опоры
с причинами несовпадения по осям.

Тесты контура: `server/test/unit/benchmark/` (офлайн, без БД и LLM).
