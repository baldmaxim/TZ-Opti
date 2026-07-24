'use strict';

// Каталог ВОР, ПАКЕТЫ под токенный бюджет и структурированный вход
// сопоставления ТЗ ↔ ВОР ↔ чек-лист (services/vor), плюс прогон Стадии 1 на
// большом ВОР офлайн (LLM подменён fakeLlm).
//
// Ключевой сценарий: ведомость, которая НЕ влезает в один запрос. Раньше такой
// ВОР выбрасывался целиком («ВОР пропущен»), и стадия сверялась только с
// чек-листом. Теперь он идёт пакетами, а «нет в ВОР» засчитывается лишь по
// пересечению всех пакетов — это здесь и зафиксировано.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCatalog,
  buildCatalogFromText,
  packCatalog,
  renderCatalog,
  renderBatch,
  catalogStats,
} = require('../../services/vor/vorCatalog');
const {
  buildMatchIndex,
  selectCandidates,
  crossReference,
  stems,
} = require('../../services/vor/vorMatchIndex');
const { runStage1Llm, intersectPasses, prepareVorCatalog } = require('../../services/stageAnalysis/stage1_llm');
const { installFakeLlm } = require('../helpers/fakeLlm');

// ── Данные ───────────────────────────────────────────────────────────────────
let seq = 0;
function item(name, unit, quantity, extra = {}) {
  seq += 1;
  return {
    order_idx: seq,
    sheet_name: 'ВОР',
    sheet_index: 0,
    row_index: seq + 1,
    position_no: String(seq),
    code: '',
    section: '',
    name,
    name_key: name.toLowerCase(),
    unit,
    unit_raw: unit,
    unit_known: true,
    quantity,
    quantity_raw: String(quantity),
    note: '',
    row_kind: 'item',
    cells: { name: `B${seq + 1}`, quantity: `D${seq + 1}` },
    merged_cells: {},
    ...extra,
  };
}

// ── Каталог ──────────────────────────────────────────────────────────────────

test('каталог: одинаковые позиции сворачиваются, количества суммируются, координаты сохраняются', () => {
  const items = [
    item('Кладка стен из газоблока', 'м3', 100, { section: 'Каменные работы' }),
    item('Кладка стен из газоблока', 'м3', 250, { section: 'Каменные работы' }),
    item('Кладка стен из газоблока', 'м2', 40), // другая единица — другая запись
    item('Окраска стен', 'м2', 900),
  ];
  const entries = buildCatalog(items);

  assert.equal(entries.length, 3);
  const kladka = entries.find((e) => e.unit === 'м3');
  assert.equal(kladka.quantity, 350, 'объёмы одинаковых позиций складываются');
  assert.equal(kladka.count, 2);
  assert.deepEqual(kladka.positions, ['1', '2']);
  assert.equal(kladka.refs[0].cell, 'B2', 'координата ячейки наименования сохранена');
  assert.equal(kladka.section, 'Каменные работы');

  const table = renderCatalog(entries);
  assert.match(table, /Кладка стен из газоблока/);
  assert.match(table, /м3/);
  assert.match(table, /350/, 'в промт уходит количество, а не только наименование');
  assert.match(table, /Раздел ВОР: Каменные работы/);
});

test('каталог из текстового ВОР (не таблица): строки как есть, без выдумывания колонок', () => {
  const entries = buildCatalogFromText([
    'Ведомость объёмов работ',
    '',
    'Разработка грунта экскаватором',
    'Разработка грунта экскаватором', // дубль
    '12',                              // строка без букв
    'ок',                              // слишком короткая
  ].join('\n'));
  assert.deepEqual(entries.map((e) => e.name), ['Ведомость объёмов работ', 'Разработка грунта экскаватором']);
  assert.equal(entries[0].unit, '');
  assert.equal(entries[0].quantity, null);
});

// ── Пакеты ───────────────────────────────────────────────────────────────────

test('большой ВОР режется на пакеты: бюджет соблюдён, ни одна позиция не потеряна', () => {
  const items = Array.from({ length: 400 }, (_, i) =>
    item(`Позиция ведомости номер ${i} с достаточно длинным наименованием работ`, 'м2', i + 1));
  const entries = buildCatalog(items);
  const stats = catalogStats(entries);
  const budgetTokens = 800;
  assert.ok(stats.tokens > budgetTokens * 3, 'каталог должен заведомо не влезать в один пакет');

  const batches = packCatalog(entries, { budgetTokens });
  assert.ok(batches.length > 3, `ожидали несколько пакетов, получено ${batches.length}`);
  for (const b of batches) {
    assert.ok(b.tokens <= budgetTokens || b.entries.length === 1, `пакет ${b.index}: ${b.tokens}т > бюджета`);
    assert.equal(b.total, batches.length);
  }
  const names = batches.flatMap((b) => b.entries.map((e) => e.name));
  assert.equal(names.length, entries.length, 'позиции не потерялись при пакетировании');
  assert.equal(new Set(names).size, entries.length, 'позиции не продублировались');

  const text = renderBatch(batches[0], { totalPositions: items.length, totalEntries: entries.length });
  assert.match(text, /часть 1\//, 'модель предупреждена, что видит часть ведомости');
  assert.match(text, /не делай вывода «работы нет в ВОР» по одной части/);
});

test('маленький ВОР — один пакет без предупреждений о частях', () => {
  const entries = buildCatalog([item('Устройство кровли', 'м2', 500)]);
  const batches = packCatalog(entries, { budgetTokens: 5000 });
  assert.equal(batches.length, 1);
  const text = renderBatch(batches[0], { totalPositions: 1, totalEntries: 1 });
  assert.doesNotMatch(text, /часть 1\//);
});

// ── Сопоставление ТЗ ↔ ВОР ↔ чек-лист ────────────────────────────────────────

test('stems: словоформы одной работы дают общие основы, служебные слова отбрасываются', () => {
  const a = new Set(stems('Кладка наружных стен из газоблока'));
  const b = new Set(stems('кладке наружной стены газоблоком'));
  const shared = [...a].filter((s) => b.has(s));
  assert.ok(shared.length >= 3, `ожидали общие основы, получено ${JSON.stringify(shared)}`);
  assert.equal(stems('и в на для работы').length, 0, 'служебные слова не попадают в индекс');
});

test('кандидаты под кусок ТЗ: релевантные позиции ВОР отбираются, посторонние — нет', () => {
  const items = [
    item('Кладка наружных стен из газоблока толщиной 200 мм', 'м3', 500),
    item('Устройство кровли из ПВХ-мембраны', 'м2', 1200),
    item('Монтаж лифтового оборудования', 'компл', 2),
  ];
  const checklist = [
    { id: 'c1', work_name: 'Кладка стен из газоблока', in_calc: 1 },
    { id: 'c2', work_name: 'Монтаж лифтов', in_calc: 0 },
  ];
  const index = buildMatchIndex({ vorEntries: buildCatalog(items), checklist });
  const tz = 'Подрядчик выполняет кладку наружных стен из газоблока толщиной 200 мм с армированием.';
  const cand = selectCandidates(index, tz);

  assert.equal(cand.vor.length, 1);
  assert.match(cand.vor[0].entry.name, /Кладка наружных стен/);
  assert.equal(cand.checklist.length, 1);
  assert.equal(cand.checklist[0].name, 'Кладка стен из газоблока');
});

test('сверка чек-лист ↔ ВОР: работа в объёме ГП, но не посчитанная в ведомости, видна как факт', () => {
  const items = [
    item('Кладка наружных стен из газоблока', 'м3', 500),
    item('Штукатурка стен цементным раствором', 'м2', 3000),
  ];
  const checklist = [
    { id: 'c1', work_name: 'Кладка наружных стен из газоблока', in_calc: 1 },
    { id: 'c2', work_name: 'Вынос наружных инженерных сетей', in_calc: 1 },
    { id: 'c3', work_name: 'Монтаж лифтового оборудования', in_calc: 0 },
  ];
  const cross = crossReference(buildMatchIndex({ vorEntries: buildCatalog(items), checklist }));

  assert.equal(cross.matched, 1);
  assert.deepEqual(cross.in_calc_without_vor, ['Вынос наружных инженерных сетей']);
  assert.equal(cross.links[0].vor.quantity, 500);
  assert.equal(cross.links[0].vor.unit, 'м3');
  assert.equal(cross.vor_without_checklist, 1, 'штукатурки нет в чек-листе');
});

// ── Пересечение проходов (пакеты ВОР) ────────────────────────────────────────

test('пересечение проходов: находка засчитывается, только если её дали ВСЕ пакеты ВОР', () => {
  const f = (fragment, extra = {}) => ({ fragment, criticality: 'medium', confidence: 0.8, ...extra });
  const merged = intersectPasses([
    [f('вынос сетей'), f('монтаж лифтов', { criticality: 'low' })],
    [f('вынос сетей', { criticality: 'high', confidence: 0.6 })],
  ]);
  assert.deepEqual(merged.map((x) => x.fragment), ['вынос сетей'],
    'работа, найденная во втором пакете ВОР, не считается пропущенной');
  assert.equal(merged[0].criticality, 'high', 'критичность берётся максимальная');
  assert.equal(merged[0].confidence, 0.6, 'уверенность — минимальная из проходов');
  assert.equal(merged[0].vor_batches_confirmed, 2);

  assert.deepEqual(intersectPasses([[f('a')]]).map((x) => x.fragment), ['a'], 'один проход — без изменений');
  assert.deepEqual(intersectPasses([[f('a')], []]), [], 'пустой проход обнуляет пересечение');
  assert.deepEqual(intersectPasses([]), []);
});

test('prepareVorCatalog: структурные позиции важнее текста, текст — фолбэк', () => {
  const structured = prepareVorCatalog({ vorItems: [item('Кладка стен', 'м3', 10)], vorText: 'мусор' });
  assert.equal(structured.source, 'structured');
  assert.equal(structured.entries[0].unit, 'м3');

  const textual = prepareVorCatalog({ vorItems: [], vorText: 'Кладка стен\nОкраска стен' });
  assert.equal(textual.source, 'text');
  assert.equal(textual.entries.length, 2);
  assert.match(textual.sourceNote, /не таблицей/);

  assert.equal(prepareVorCatalog({}).source, 'none');
});

// ── Стадия 1 на большом ВОР (офлайн) ─────────────────────────────────────────

function tzBlocks(clauses) {
  return clauses.map((text, index) => ({
    index,
    type: 'paragraph',
    text,
    section_path: ['1. Объём работ'],
  }));
}

test('Стадия 1: большой ВОР идёт ПАКЕТАМИ, а не выбрасывается по лимиту', async (t) => {
  // Ведомость по той же теме, что и ТЗ (все позиции релевантны этой части ТЗ),
  // и заведомо больше одного пакета — бюджет пакета сжат через env.
  const items = Array.from({ length: 50 }, (_, i) =>
    item(`Окраска стен в помещении ${i} водоэмульсионным составом`, 'м2', i + 1));
  items.push(item('Штукатурка стен цементным раствором', 'м2', 3000));

  const blocks = tzBlocks([
    'Подрядчик обеспечивает вынос наружных инженерных сетей из пятна застройки за свой счёт.',
    'Подрядчик выполняет отделочные работы: штукатурку стен цементным раствором и окраску стен в помещениях.',
  ]);

  const prevBudget = process.env.STAGE1_VOR_BATCH_TOKENS;
  process.env.STAGE1_VOR_BATCH_TOKENS = '400';
  delete require.cache[require.resolve('../../services/stageAnalysis/stage1_llm')];
  // eslint-disable-next-line global-require
  const stage1 = require('../../services/stageAnalysis/stage1_llm');
  t.after(() => {
    if (prevBudget === undefined) delete process.env.STAGE1_VOR_BATCH_TOKENS;
    else process.env.STAGE1_VOR_BATCH_TOKENS = prevBudget;
    delete require.cache[require.resolve('../../services/stageAnalysis/stage1_llm')];
  });

  // Каждый проход «находит» вынос сетей (его в ВОР нет вообще) и штукатурку
  // (она есть в ведомости — но только в одном из пакетов).
  const llm = installFakeLlm(t, (call) => {
    const sawShtukaturka = call.user.includes('Штукатурка стен цементным раствором');
    return {
      findings: [
        { fragment: 'вынос наружных инженерных сетей', criticality: 'high', confidence: 0.9 },
        ...(sawShtukaturka ? [] : [{ fragment: 'штукатурку стен цементным раствором', criticality: 'medium' }]),
      ],
    };
  });

  const issues = await stage1.runStage1Llm({
    blocks,
    sourceDocumentId: 'doc-1',
    vorItems: items,
    checklist: [{ id: 'c1', work_name: 'Вынос наружных сетей', in_calc: 1 }],
  });

  assert.ok(llm.callCount > 1, `ВОР должен показываться пакетами, вызовов: ${llm.callCount}`);
  const batchLabels = llm.calls.filter((c) => /ВОР приведён ЧАСТЯМИ/.test(c.user));
  assert.ok(batchLabels.length > 1, 'в промт ушла пометка о частях ведомости');
  assert.ok(
    llm.calls.every((c) => !/ВОР пропущен/.test(c.user)),
    'запасного режима «ВОР пропущен» больше нет',
  );

  const fragments = issues.map((i) => i.source_fragment);
  assert.ok(
    fragments.some((f) => /вынос наружных инженерных сетей/i.test(f)),
    'работа, которой нет ни в одном пакете ВОР, остаётся замечанием',
  );
  assert.ok(
    !fragments.some((f) => /штукатурк/i.test(f)),
    'работа, найденная в одном из пакетов ВОР, замечанием не становится',
  );
  assert.equal(issues.vor.source, 'structured');
  assert.ok(issues.vor.max_batches_per_part > 1);
  assert.match(issues.analysisNote || '', /пакетами/);
});

test('Стадия 1: ВОР целиком влезает — один проход на часть ТЗ, единицы и объёмы в промте', async (t) => {
  const items = [item('Кладка наружных стен из газоблока', 'м3', 1250.5)];
  const blocks = tzBlocks([
    'Подрядчик выполняет кладку наружных стен из газоблока и устройство лифтовых шахт.',
  ]);
  const llm = installFakeLlm(t, [{ findings: [{ fragment: 'устройство лифтовых шахт', criticality: 'high' }] }]);

  const issues = await runStage1Llm({
    blocks,
    sourceDocumentId: 'doc-1',
    vorItems: items,
    checklist: [{ id: 'c1', work_name: 'Кладка наружных стен из газоблока', in_calc: 1 }],
  });

  assert.equal(llm.callCount, 1, 'маленький ВОР — один проход');
  const user = llm.calls[0].user;
  assert.match(user, /Кладка наружных стен из газоблока/);
  assert.match(user, /1250\.5/, 'количество ушло в промт');
  assert.match(user, /м3/, 'единица измерения ушла в промт');
  assert.match(user, /Машинная сверка чек-лист ↔ ВОР/, 'детерминированная сверка приложена к промту');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source_fragment, 'устройство лифтовых шахт');
  assert.equal(issues.vor.cross_reference.matched, 1);
});

test('Стадия 1 без ВОР: анализ идёт по чек-листу и честно помечает это в отчёте', async (t) => {
  const blocks = tzBlocks(['Подрядчик выполняет устройство временных дорог и городка строителей.']);
  const llm = installFakeLlm(t, [{ findings: [{ fragment: 'устройство временных дорог', criticality: 'medium' }] }]);

  const issues = await runStage1Llm({
    blocks,
    sourceDocumentId: 'doc-1',
    vorItems: [],
    vorText: '',
    checklist: [{ id: 'c1', work_name: 'Временные дороги', in_calc: 0 }],
  });

  assert.equal(llm.callCount, 1);
  assert.match(llm.calls[0].user, /\(ВОР не загружен или пуст\)/);
  assert.equal(issues.length, 1);
  assert.match(issues.analysisNote, /ВОР не загружен/);
  assert.equal(issues.vor.source, 'none');
});
