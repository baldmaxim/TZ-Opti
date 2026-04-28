'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('./connection');
const { runMigration } = require('./migrate');
const { newId, nowIso } = require('../utils/ids');
const { buildMinimalDocx } = require('./fixtures/buildMinimalDocx');
const { buildXlsxBuffer } = require('./fixtures/buildMinimalXlsx');
const { STANDARD_CHECKLIST } = require('./standardChecklist');

const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');

async function isEmpty() {
  const r = await db.queryOne('SELECT COUNT(*) as c FROM tenders');
  return r.c === 0;
}

function readFixture(fileName) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', fileName), 'utf8');
}

function writeFile(tenderId, name, buffer) {
  const dir = path.join(UPLOAD_ROOT, 'tenders', tenderId);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${newId()}__${name}`);
  fs.writeFileSync(fp, buffer);
  return fp;
}

async function insertDocument(tender, docType, name, filePath, mime, extractedText, comment = null) {
  const id = newId();
  await db.queryRun(
    `
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, extracted_text, processing_status)
    VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, ?, 'extracted')
  `,
    id,
    tender.id,
    docType,
    name,
    filePath,
    mime,
    nowIso(),
    comment,
    extractedText,
  );
  return id;
}

function tzParagraphs(text) {
  return text.split(/\r?\n/).filter((s) => s.trim().length > 0);
}

async function seedTenderSeverniy() {
  const tenderId = newId();
  await db.queryRun(
    `
    INSERT INTO tenders (id, title, customer, type, stage, deadline, owner, status, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    tenderId,
    'ЖК Северный — Корпус 5 (монолит + кладка)',
    'ООО «Стройсервис»',
    'shell',
    'РД',
    '2026-06-15',
    'Иванов И.И.',
    'in_progress',
    'Тендер на устройство монолитных конструкций и кладочные работы по корпусу 5.',
    nowIso(),
  );
  await db.queryRun(
    `
    INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
    VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
  `,
    tenderId,
  );

  const tzText = readFixture('tz_severnyy.txt');
  const paragraphs = tzParagraphs(tzText);
  const tzDocx = buildMinimalDocx(paragraphs);
  const tzPath = writeFile(tenderId, 'TZ_Severnyy.docx', tzDocx);
  await insertDocument(
    { id: tenderId },
    'tz',
    'TZ_Severnyy.docx',
    tzPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    paragraphs.join('\n'),
    'Главный документ тендера',
  );

  // ВОР
  const vorRows = [
    { '№': 1, 'Раздел': 'Монолит', 'Наименование': 'Устройство фундаментной плиты', 'Ед.изм.': 'м3', 'Объём': 1200 },
    { '№': 2, 'Раздел': 'Монолит', 'Наименование': 'Колонны и перекрытия', 'Ед.изм.': 'м3', 'Объём': 850 },
    { '№': 3, 'Раздел': 'Кладка', 'Наименование': 'Кладка из газоблока D500 200мм', 'Ед.изм.': 'м3', 'Объём': 540 },
    { '№': 4, 'Раздел': 'Гидроизоляция', 'Наименование': 'Гидроизоляция фундаментов', 'Ед.изм.': 'м2', 'Объём': 1200 },
    { '№': 5, 'Раздел': 'Прочее', 'Наименование': 'Армирование сетками кладки', 'Ед.изм.': 'м2', 'Объём': 1800 },
  ];
  const vorBuf = buildXlsxBuffer(vorRows, 'ВОР');
  const vorPath = writeFile(tenderId, 'VOR_Severnyy.xlsx', vorBuf);
  const vorText = vorRows.map((r) => Object.values(r).join(' | ')).join('\n');
  await insertDocument(
    { id: tenderId },
    'vor',
    'VOR_Severnyy.xlsx',
    vorPath,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    vorText,
    'ВОР заказчика',
  );

  // ПД (текстовая фикстура — упрощённо)
  const pdText =
    'Проектная документация по объекту ЖК Северный, корпус 5. Состав работ: монолитные работы, кладочные работы из газоблока, гидроизоляция фундаментов, армирование сетками. Дополнительно: устройство временных дорог.';
  const pdPath = writeFile(tenderId, 'PD_Severnyy.txt', Buffer.from(pdText, 'utf8'));
  await insertDocument({ id: tenderId }, 'pd_rd', 'PD_Severnyy.txt', pdPath, 'text/plain', pdText, 'Краткий выжимка ПД');

  // Чек-лист — стандартный список с реалистичными ответами «коробочного» тендера.
  // Не учтено в КП: ПД/РД (делает Заказчик), демонтаж, вырубка, мониторинг.
  // Остальное по умолчанию учтено.
  const NOT_ACCOUNTED = new Set([
    'Разработка Рабочей документации',
    'Корректировка ПД',
    'Корректировка АГР',
    'Демонтажные работы',
    'Вырубка',
    'Геотехнический мониторинг',
  ]);
  for (const it of STANDARD_CHECKLIST) {
    const status = NOT_ACCOUNTED.has(it.work_name) ? 0 : 1;
    await db.queryRun(
      `
      INSERT INTO work_checklist_items (id, tender_id, section, work_name, in_calc, comment)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      newId(),
      tenderId,
      it.section,
      it.work_name,
      status,
      null,
    );
  }

  // Условия компании теперь — параметрический шаблон (28 пунктов).
  // Заполняем только tender_setup_params; конкретные условия рендерятся
  // на лету сервисом conditionsRenderer.
  await db.queryRun(
    `
    INSERT INTO tender_setup_params (tender_id, contract_kind, escalation, advance, build_months, transfer_months, kp_date, updated_at)
    VALUES (?, 'shell', 'БСМ5%', NULL, 24, 3, '2026-07-30', ?)
  `,
    tenderId,
    nowIso(),
  );

  // Риски — вся библиотека лежит в коде (server/db/standardRisks.js).
  // Для тендера нужно только overlay (tender_risk_state) — оставляем пустым,
  // пользователь сам выберет «Да/Нет/Авто» по умолчанию.

  // Q&A — заполняем напрямую в qa_entries (имитируем результат импорта реальной формы).
  const qaRows = [
    { section: 'Бетон', q: 'Бетон давальческий?', a: 'Нет, поставка генподрядчиком', d: 'Принято к сведению. Учтено по ВОР' },
    { section: 'Арматура', q: 'Арматура давальческая?', a: 'Да, давальческая', d: 'Принято к сведению. Учтено как давальческая' },
    { section: 'Башенный кран', q: 'Башенный кран?', a: 'Нет', d: 'Учтено: кран ГП' },
    { section: 'Земляные работы', q: 'Вывоз грунта?', a: 'Силами Заказчика', d: 'Не учтено — на стороне Заказчика' },
    { section: 'Лаборатория', q: 'Лабораторные испытания?', a: 'По графику ГП', d: 'Учтено по графику ГП' },
  ];
  for (let i = 0; i < qaRows.length; i++) {
    const r = qaRows[i];
    await db.queryRun(
      `
      INSERT INTO qa_entries
        (id, tender_id, source_file_path, section, sent_at, answer_at, round_label, question, answer, accepted_decision, order_idx, imported_at)
      VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
    `,
      newId(),
      tenderId,
      r.section,
      'Направлено (демо)',
      r.q,
      r.a,
      r.d,
      i,
      nowIso(),
    );
  }

  return tenderId;
}

async function seedTenderZarechnyy() {
  const tenderId = newId();
  await db.queryRun(
    `
    INSERT INTO tenders (id, title, customer, type, stage, deadline, owner, status, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    tenderId,
    'ЖК Заречный — генподряд полного цикла',
    'АО «Девелопер-Регион»',
    'general_contract',
    'П',
    '2026-08-30',
    'Петров П.П.',
    'draft',
    'Тендер на полный цикл строительства жилого комплекса.',
    nowIso(),
  );
  await db.queryRun(
    `
    INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
    VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
  `,
    tenderId,
  );

  const tzText = readFixture('tz_zarechnyy.txt');
  const paragraphs = tzParagraphs(tzText);
  const tzDocx = buildMinimalDocx(paragraphs);
  const tzPath = writeFile(tenderId, 'TZ_Zarechnyy.docx', tzDocx);
  await insertDocument(
    { id: tenderId },
    'tz',
    'TZ_Zarechnyy.docx',
    tzPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    paragraphs.join('\n'),
    'Главный документ тендера',
  );

  // Стандартный чек-лист, статусы не заполнены — пользователь ответит сам.
  for (const it of STANDARD_CHECKLIST) {
    await db.queryRun(
      `
      INSERT INTO work_checklist_items (id, tender_id, section, work_name, in_calc, comment)
      VALUES (?, ?, ?, ?, NULL, NULL)
    `,
      newId(),
      tenderId,
      it.section,
      it.work_name,
    );
  }

  // Параметры тендера для шаблона существенных условий (Генподряд)
  await db.queryRun(
    `
    INSERT INTO tender_setup_params (tender_id, contract_kind, escalation, advance, build_months, transfer_months, kp_date, updated_at)
    VALUES (?, 'gen', 'БСМ5%', 'Аванс 30%', 24, 3, '2026-07-29', ?)
  `,
    tenderId,
    nowIso(),
  );

  return tenderId;
}

async function runSeed(force = false) {
  await runMigration();
  if (!force && (await isEmpty())) {
    console.log('[seed] tenders already exist, skipping');
    return;
  }
  if (force) {
    await db.exec(`
      DELETE FROM review_decisions;
      DELETE FROM tz_excluded_ranges;
      DELETE FROM issues;
      DELETE FROM analysis_runs;
      DELETE FROM characteristics;
      DELETE FROM qa_entries;
      DELETE FROM work_checklist_items;
      DELETE FROM company_conditions;
      DELETE FROM tender_setup_params;
      DELETE FROM tender_risk_state;
      DELETE FROM tender_custom_risks;
      DELETE FROM risk_templates;
      DELETE FROM tender_stage_state;
      DELETE FROM setup_locks;
      DELETE FROM documents;
      DELETE FROM tenders;
    `);
  }
  const id1 = await seedTenderSeverniy();
  const id2 = await seedTenderZarechnyy();
  console.log('[seed] inserted demo tenders:', id1, id2);
}

async function runSeedIfEmpty() {
  if (await isEmpty()) await runSeed(false);
}

if (require.main === module) {
  const force = process.argv.includes('--force') || process.argv.includes('-f');
  runSeed(force)
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}

module.exports = { runSeed, runSeedIfEmpty, isEmpty };
