'use strict';

// Карта сопоставления «требование ТЗ ↔ позиции ВОР» (vor/requirementMatchModel)
// + устойчивое сведение пакетов ВОР (stage1_llm.intersectPasses).
// Защищаемые свойства:
//   • числа и единицы в карте — ФАКТ ведомости, а не слова модели;
//   • лексическое совпадение не превращается в «учтено»: частичное покрытие
//     видно операциями operations_missing;
//   • изменение длины цитаты моделью между пакетами не теряет находку;
//   • covered-записи сводятся объединением (покрытие подтверждает пакет,
//     который позицию ВИДЕЛ), пробелы — пересечением.
// Запуск: npm run test:unit.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchKeyOf,
  normalizeVorMatch,
  resolvePositions,
  buildMatchRow,
  mergeMatchRows,
} = require('../../services/vor/requirementMatchModel');
const { intersectPasses } = require('../../services/stageAnalysis/stage1_llm');

// Каталог ведомости (vorCatalog.buildCatalog форма): агрегированная позиция.
const ENTRIES = [
  { name: 'Устройство перегородок из ПГП', unit: 'м2', quantity: 12000, positions: ['14'], refs: [] },
  { name: 'Кладка стен', unit: 'м3', quantity: 800, positions: ['15'], refs: [] },
];

const RAW_MATCH = {
  status: 'partial',
  positions: [
    { position_no: '14', name: 'Устройство перегородок из ПГП', quantity: 11000, unit: 'м3' },
    { name: 'Усиление проёмов металлом', quantity: 5, unit: 'т' },
  ],
  operations_included: ['устройство перегородок'],
  operations_missing: ['усиление проёмов', 'закладные', 'заделка примыканий'],
  exclusions: [],
  unit_note: 'ТЗ описывает работы комплексом, позиция — в м²',
  quantity_note: 'объём агрегирован по всем корпусам',
};

test('normalizeVorMatch: чистит и нормализует заявленное моделью сопоставление', () => {
  const m = normalizeVorMatch(RAW_MATCH);
  assert.equal(m.status, 'partial');
  assert.equal(m.positions.length, 2);
  assert.deepEqual(m.operations_missing, ['усиление проёмов', 'закладные', 'заделка примыканий']);
  assert.equal(normalizeVorMatch(null), null);
  assert.equal(normalizeVorMatch({}), null, 'пустой объект — сопоставление не заявлено');
  assert.equal(normalizeVorMatch({ status: 'covered' }).status, 'covered');
});

test('resolvePositions: количество и единица — ФАКТ ведомости, расхождения модели помечаются', () => {
  const resolved = resolvePositions(normalizeVorMatch(RAW_MATCH), ENTRIES);
  const found = resolved[0];
  assert.equal(found.verified, true);
  assert.equal(found.quantity, 12000, 'число из ведомости, а не 11000 со слов модели');
  assert.equal(found.unit, 'м2', 'единица из ведомости');
  assert.equal(found.claimed_quantity, 11000, 'заявленное моделью расхождение видно');
  assert.equal(found.unit_mismatch, true);
  assert.equal(found.claimed_unit, 'м3');

  const ghost = resolved[1];
  assert.equal(ghost.verified, false, 'позиции «усиление проёмов» в ведомости нет — связь не доказана');
});

test('resolvePositions: несколько ВОР — catalog_entry_id решает, одинаковый номер позиции без ID не приписывается произвольному документу', () => {
  const entries = [
    {
      entry_id: 'vc_aaaaaaaaaa', document_id: 'doc-k1', document_name: 'ВОР-К1.xlsx',
      applicability: 'корпус 1', name: 'Устройство перегородок из ПГП', unit: 'м2',
      quantity: 5000, positions: ['1'], refs: [],
    },
    {
      entry_id: 'vc_bbbbbbbbbb', document_id: 'doc-k2', document_name: 'ВОР-К2.xlsx',
      applicability: 'корпус 2', name: 'Устройство перегородок из ПГП', unit: 'м2',
      quantity: 7000, positions: ['1'], refs: [],
    },
  ];

  // Модель сослалась на ID записи корпуса 1 → количество берётся ЕГО, а не сумма.
  const byId = resolvePositions(normalizeVorMatch({
    status: 'partial',
    positions: [{ catalog_entry_id: 'vc_aaaaaaaaaa', position_no: '1', name: 'Устройство перегородок из ПГП' }],
  }), entries);
  assert.equal(byId[0].verified, true);
  assert.equal(byId[0].quantity, 5000, 'объём корпуса 1, а не 12 000 «на весь тендер»');
  assert.equal(byId[0].document_id, 'doc-k1');
  assert.equal(byId[0].applicability, 'корпус 1');
  assert.equal(byId[0].catalog_entry_id, 'vc_aaaaaaaaaa');

  // Без ID: «позиция 1» есть в обоих корпусах, наименование одинаковое —
  // связь неоднозначна и НЕ доказана ведомостью.
  const noId = resolvePositions(normalizeVorMatch({
    status: 'covered',
    positions: [{ position_no: '1', name: 'Устройство перегородок из ПГП' }],
  }), entries);
  assert.equal(noId[0].verified, false, 'произвольный документ не подставлен');
  assert.equal(noId[0].ambiguous, true);
});

test('matchKeyOf стабилен к пробелам/регистру — подтверждение инженера переживает прогоны', () => {
  assert.equal(
    matchKeyOf('Устройство перегородок,  усиление проёмов'),
    matchKeyOf('устройство перегородок, усиление проёмов'),
  );
  assert.notEqual(matchKeyOf('a'), matchKeyOf('b'));
});

test('mergeMatchRows: одно требование из разных частей — одна строка, статус тревожнее, позиции объединяются', () => {
  const match = normalizeVorMatch(RAW_MATCH);
  const rowA = buildMatchRow({
    fragment: 'устройство перегородок, усиление проёмов',
    match: { ...match, status: 'covered' },
    resolvedPositions: resolvePositions(match, ENTRIES).slice(0, 1),
    confidence: 0.9,
  });
  const rowB = buildMatchRow({
    fragment: 'Устройство перегородок, усиление проёмов',
    match,
    resolvedPositions: resolvePositions(match, ENTRIES),
    confidence: 0.7,
    problemType: 'учтено_частично',
  });
  const merged = mergeMatchRows([rowA, rowB]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].coverage_status, 'partial', 'partial тревожнее covered');
  assert.equal(merged[0].problem_type, 'учтено_частично');
  assert.equal(merged[0].positions.length, 2);
  assert.equal(merged[0].confidence, 0.7, 'уверенность — минимальная');
});

// --- intersectPasses: хрупкость сведения пакетов -------------------------------

const f = (fragment, extra = {}) => ({ fragment, criticality: 'medium', confidence: 0.8, ...extra });

test('цитата разной длины в двух пакетах — та же находка (контейнмент), а не потеря', () => {
  const merged = intersectPasses([
    [f('вынос и перекладка наружных сетей водоснабжения')],
    [f('перекладка наружных сетей водоснабжения')], // модель укоротила цитату
  ]);
  assert.equal(merged.length, 1, 'находка выжила несмотря на разную длину цитаты');
  assert.equal(merged[0].vor_batches_confirmed, 2);
});

test('covered-записи сводятся объединением: покрытие подтверждает пакет, видевший позицию', () => {
  const covered = f('устройство перегородок', { vor_match: { status: 'covered', positions: [] } });
  const merged = intersectPasses([
    [covered, f('вынос сетей')],
    [f('вынос сетей')], // второй пакет перегородок не видел — это НЕ отменяет покрытие
  ]);
  const frags = merged.map((x) => x.fragment).sort();
  assert.deepEqual(frags, ['вынос сетей', 'устройство перегородок']);
  const cov = merged.find((x) => x.fragment === 'устройство перегородок');
  assert.equal(cov.vor_match.status, 'covered');
});

test('РЕГРЕСС: прежняя семантика пересечения пробелов сохранена', () => {
  const merged = intersectPasses([
    [f('вынос сетей'), f('монтаж лифтового оборудования', { criticality: 'low' })],
    [f('вынос сетей', { criticality: 'high', confidence: 0.6 })],
  ]);
  assert.deepEqual(merged.map((x) => x.fragment), ['вынос сетей']);
  assert.equal(merged[0].criticality, 'high');
  assert.equal(merged[0].confidence, 0.6);
});
