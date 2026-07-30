'use strict';

// Integration: манифест тендерного пакета на живом PostgreSQL.
//   npm run test:integration    — без TEST_DATABASE_URL тесты SKIP
//   npm run verify:integration  — без TEST_DATABASE_URL тесты ПАДАЮТ
//
// Проверяем то, ради чего заведён манифест:
//   • PATCH манифест-полей + авто-разметка заменённого документа (superseded);
//   • выбор входа анализа идёт по манифесту (superseded исключён);
//   • два актуальных ВОР сосуществуют, переимпорт одного не стирает другой;
//   • ревизия набора документов меняется от правки манифеста.

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { dbTestOptions, getDb, closeDb } = require('../helpers/testDb');
const { makeTmpDir } = require('../helpers/tmpDir');
const { importVorFile, loadVorItems } = require('../../services/vor/vorImportService');
const manifestService = require('../../services/documents/manifestService');
const { getDocumentsByType, getDocumentByType } = require('../../services/tzActiveTextService');
const { currentDocumentsRevision } = require('../../services/analysisRuns/analysisRunsService');

const OPTS = dbTestOptions();
const TENDER_ID = 'manifest-int-tender';
const VOR_K1 = 'manifest-int-vor-k1';
const VOR_K2 = 'manifest-int-vor-k2';

function writeVorXlsx(dir, name, positions) {
  const rows = [
    ['№ п/п', 'Наименование работ', 'Ед. изм.', 'Кол-во'],
    ...positions.map((p, i) => [i + 1, p, 'куб.м', 10 + i]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'ВОР');
  const fp = `${dir}/${name}`;
  XLSX.writeFile(wb, fp);
  return fp;
}

async function insertDoc(db, id, over = {}) {
  const cols = {
    id, tender_id: TENDER_ID, doc_type: 'vor', name: `${id}.xlsx`,
    file_path: `/nonexistent/${id}.xlsx`, mime_type: null,
    uploaded_at: new Date().toISOString(), processing_status: 'extracted',
    ...over,
  };
  const keys = Object.keys(cols);
  await db.queryRun(
    `INSERT INTO documents (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => cols[k]),
  );
}

before(async () => {
  if (OPTS.skip) return;
  const { runMigration } = require('../../db/migrate');
  await runMigration();
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID);
  await db.queryRun(
    'INSERT INTO tenders (id, title, status, created_at) VALUES (?, ?, ?, ?)',
    TENDER_ID, 'Манифест: integration-тест', 'draft', new Date().toISOString(),
  );
});

after(async () => {
  if (OPTS.skip) return;
  const db = getDb();
  await db.queryRun('DELETE FROM tenders WHERE id = ?', TENDER_ID).catch(() => {});
  await closeDb();
});

test('два актуальных ВОР сосуществуют: импорт одного не стирает позиции другого', OPTS, async (t) => {
  const dir = makeTmpDir(t);
  const db = getDb();
  const fp1 = writeVorXlsx(dir, 'k1.xlsx', ['Бетонирование стен корпуса 1']);
  const fp2 = writeVorXlsx(dir, 'k2.xlsx', ['Кровля корпуса 2', 'Фасад корпуса 2']);
  await insertDoc(db, VOR_K1, { file_path: fp1, applicability: 'корпус 1' });
  await insertDoc(db, VOR_K2, { file_path: fp2, applicability: 'корпус 2' });

  await importVorFile(TENDER_ID, { documentId: VOR_K1, filePath: fp1 });
  await importVorFile(TENDER_ID, { documentId: VOR_K2, filePath: fp2 });

  let items = await loadVorItems(TENDER_ID);
  assert.equal(items.length, 3, 'позиции обоих корпусов вместе');

  // Переимпорт корпуса 2 не трогает корпус 1.
  await importVorFile(TENDER_ID, { documentId: VOR_K2, filePath: fp2 });
  items = await loadVorItems(TENDER_ID);
  assert.equal(items.length, 3);
  assert.equal(items.filter((i) => i.document_id === VOR_K1).length, 1);

  const docs = await getDocumentsByType(TENDER_ID, 'vor');
  assert.equal(docs.length, 2, 'оба ВОР актуальны по манифесту');
});

test('PATCH манифеста: замена документа помечает старый superseded и убирает его из анализа', OPTS, async () => {
  const db = getDb();
  const revBefore = await currentDocumentsRevision(TENDER_ID);

  const { document, manifest } = await manifestService.updateDocumentManifest(VOR_K2, {
    revision_label: 'редакция 2',
    supersedes_document_id: VOR_K1,
  });
  assert.equal(document.revision_label, 'редакция 2');

  // Старый ВОР материализован как superseded — и в строке БД, и в манифесте.
  const old = await db.queryOne('SELECT actuality_status FROM documents WHERE id = ?', VOR_K1);
  assert.equal(old.actuality_status, 'superseded');
  const vorGroup = manifest.groups.find((g) => g.doc_type === 'vor');
  assert.equal(vorGroup.active_count, 1);

  // Вход анализа: остался только заменяющий документ и ЕГО позиции.
  const docs = await getDocumentsByType(TENDER_ID, 'vor');
  assert.deepEqual(docs.map((d) => d.id), [VOR_K2]);
  const primary = await getDocumentByType(TENDER_ID, 'vor');
  assert.equal(primary.id, VOR_K2);
  const items = await loadVorItems(TENDER_ID);
  assert.equal(items.length, 2, 'позиции superseded-ВОР исключены');
  assert.ok(items.every((i) => i.document_id === VOR_K2));

  // Правка манифеста = новая ревизия набора документов (кэш/manifest реагируют
  // штатной механикой ревизий).
  const revAfter = await currentDocumentsRevision(TENDER_ID);
  assert.notEqual(revAfter, revBefore);
});

test('валидация PATCH: цикл замены и неизвестное поле отклоняются без записи', OPTS, async () => {
  await assert.rejects(
    () => manifestService.updateDocumentManifest(VOR_K1, { supersedes_document_id: VOR_K2 }),
    /зацикливается/,
  );
  await assert.rejects(
    () => manifestService.updateDocumentManifest(VOR_K2, { unknown_field: 1 }),
    /Неизвестное поле/,
  );
});
