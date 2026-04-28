'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('./connection');
const { runMigration } = require('./migrate');
const { newId, nowIso } = require('../utils/ids');
const { buildMinimalDocx } = require('./fixtures/buildMinimalDocx');
const { buildXlsxBuffer } = require('./fixtures/buildMinimalXlsx');
const { STANDARD_CHECKLIST } = require('./standardChecklist');

const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');

function isEmpty() {
  const c = db.prepare('SELECT COUNT(*) as c FROM tenders').get().c;
  return c === 0;
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

function insertDocument(tender, docType, name, filePath, mime, extractedText, comment = null) {
  const id = newId();
  db.prepare(`
    INSERT INTO documents (id, tender_id, doc_type, name, file_path, mime_type, version, uploaded_at, comment, extracted_text, processing_status)
    VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, ?, 'extracted')
  `).run(id, tender.id, docType, name, filePath, mime, nowIso(), comment, extractedText);
  return id;
}

function tzParagraphs(text) {
  return text.split(/\r?\n/).filter((s) => s.trim().length > 0);
}

function seedTenderSeverniy() {
  const tenderId = newId();
  db.prepare(`
    INSERT INTO tenders (id, title, customer, type, stage, deadline, owner, status, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenderId,
    'ЖК Северный — Корпус 5 (монолит + кладка)',
    'ООО «Стройсервис»',
    'shell',
    'РД',
    '2026-06-15',
    'Иванов И.И.',
    'in_progress',
    'Тендер на устройство монолитных конструкций и кладочные работы по корпусу 5.',
    nowIso()
  );
  db.prepare(`
    INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
    VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
  `).run(tenderId);

  const tzText = readFixture('tz_severnyy.txt');
  const paragraphs = tzParagraphs(tzText);
  const tzDocx = buildMinimalDocx(paragraphs);
  const tzPath = writeFile(tenderId, 'TZ_Severnyy.docx', tzDocx);
  insertDocument(
    { id: tenderId },
    'tz',
    'TZ_Severnyy.docx',
    tzPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    paragraphs.join('\n'),
    'Главный документ тендера'
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
  insertDocument({ id: tenderId }, 'vor', 'VOR_Severnyy.xlsx', vorPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', vorText, 'ВОР заказчика');

  // ПД (текстовая фикстура — упрощённо)
  const pdText = 'Проектная документация по объекту ЖК Северный, корпус 5. Состав работ: монолитные работы, кладочные работы из газоблока, гидроизоляция фундаментов, армирование сетками. Дополнительно: устройство временных дорог.';
  const pdPath = writeFile(tenderId, 'PD_Severnyy.txt', Buffer.from(pdText, 'utf8'));
  insertDocument({ id: tenderId }, 'pd_rd', 'PD_Severnyy.txt', pdPath, 'text/plain', pdText, 'Краткий выжимка ПД');

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
  const stmtChk = db.prepare(`
    INSERT INTO work_checklist_items (id, tender_id, section, work_name, in_calc, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const it of STANDARD_CHECKLIST) {
    const status = NOT_ACCOUNTED.has(it.work_name) ? 0 : 1;
    stmtChk.run(newId(), tenderId, it.section, it.work_name, status, null);
  }

  // Условия компании теперь — параметрический шаблон (28 пунктов).
  // Заполняем только tender_setup_params; конкретные условия рендерятся
  // на лету сервисом conditionsRenderer.
  db.prepare(`
    INSERT INTO tender_setup_params (tender_id, contract_kind, escalation, advance, build_months, transfer_months, kp_date, updated_at)
    VALUES (?, 'shell', 'БСМ5%', NULL, 24, 3, '2026-07-30', ?)
  `).run(tenderId, nowIso());

  // Риски
  const stmtRisk = db.prepare(`
    INSERT INTO risk_templates (id, tender_id, category, risk_text, recommendation, criticality, is_global)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const risks = [
    { c: 'Срок', t: 'согласование', r: 'Зафиксировать SLA согласований и сроки в днях. При срыве — продление графика.', cr: 'high', g: 1 },
    { c: 'Срок', t: 'неустойк', r: 'Ограничить неустойку 0,1% за день, не более 10% от стоимости.', cr: 'high', g: 1 },
    { c: 'Объём', t: 'все необходимые мероприятия', r: 'Заменить на закрытый перечень.', cr: 'high', g: 1 },
    { c: 'Объём', t: 'в полном объеме', r: 'Сослаться на конкретный раздел ПД.', cr: 'medium', g: 1 },
    { c: 'Качество', t: 'надлежащим образом', r: 'Заменить на ссылку на нормативные документы.', cr: 'medium', g: 1 },
    { c: 'Гарантии', t: 'до полного устранения', r: 'Ограничить срок устранения и состав работ.', cr: 'medium', g: 0 },
  ];
  for (const r of risks) stmtRisk.run(newId(), r.g ? null : tenderId, r.c, r.t, r.r, r.cr, r.g);

  // Доп. инфо
  db.prepare(`
    INSERT INTO additional_object_info (id, tender_id, tender_type, package_scope, terms, staging, blocks_sections, site_constraints, special_conditions, comment)
    VALUES (?, ?, 'shell', 'Монолит + кладка корпуса 5', '12 мес.', '2 этапа', 'Корпус 5, секции 1–4', 'Стесненная площадка, ограниченный доступ техники по ночам', 'Круглосуточный режим запрещен по решению префектуры', null)
  `).run(newId(), tenderId);

  // Q&A xlsx-фикстура
  const qaRows = [
    { 'Вопрос': 'Бетон давальческий?', 'Ответ': 'Нет, поставка генподрядчиком', 'Принятое решение': 'Поставка ГП', 'Источник характеристики': 'Бетон', 'Значение': 'поставка генподрядчиком' },
    { 'Вопрос': 'Арматура давальческая?', 'Ответ': 'Да, давальческая', 'Принятое решение': 'Заказчик поставляет', 'Источник характеристики': 'Арматура', 'Значение': 'давальческая' },
    { 'Вопрос': 'Башенный кран?', 'Ответ': 'Нет', 'Принятое решение': 'Кран ГП', 'Источник характеристики': 'Башенный кран', 'Значение': 'силами генподрядчика' },
    { 'Вопрос': 'Вывоз грунта?', 'Ответ': 'Силами Заказчика', 'Принятое решение': 'Заказчик', 'Источник характеристики': 'Вывоз грунта', 'Значение': 'силами заказчика' },
    { 'Вопрос': 'Лабораторные испытания?', 'Ответ': 'По графику ГП', 'Принятое решение': 'ГП график', 'Источник характеристики': 'Лаборатория', 'Значение': 'по графику генподрядчика' },
  ];
  const qaBuf = buildXlsxBuffer(qaRows, 'Q&A');
  const qaPath = writeFile(tenderId, 'QA_Severnyy.xlsx', qaBuf);
  // Сохраняем файл в documents (для удобства повторного скачивания)
  insertDocument({ id: tenderId }, 'qa', 'QA_Severnyy.xlsx', qaPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', qaRows.map((r) => Object.values(r).join(' | ')).join('\n'), 'Демо Q&A форма');

  return tenderId;
}

function seedTenderZarechnyy() {
  const tenderId = newId();
  db.prepare(`
    INSERT INTO tenders (id, title, customer, type, stage, deadline, owner, status, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenderId,
    'ЖК Заречный — генподряд полного цикла',
    'АО «Девелопер-Регион»',
    'general_contract',
    'П',
    '2026-08-30',
    'Петров П.П.',
    'draft',
    'Тендер на полный цикл строительства жилого комплекса.',
    nowIso()
  );
  db.prepare(`
    INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
    VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
  `).run(tenderId);

  const tzText = readFixture('tz_zarechnyy.txt');
  const paragraphs = tzParagraphs(tzText);
  const tzDocx = buildMinimalDocx(paragraphs);
  const tzPath = writeFile(tenderId, 'TZ_Zarechnyy.docx', tzDocx);
  insertDocument(
    { id: tenderId },
    'tz',
    'TZ_Zarechnyy.docx',
    tzPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    paragraphs.join('\n'),
    'Главный документ тендера'
  );

  // Стандартный чек-лист, статусы не заполнены — пользователь ответит сам.
  const stmtChk = db.prepare(`
    INSERT INTO work_checklist_items (id, tender_id, section, work_name, in_calc, comment)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `);
  for (const it of STANDARD_CHECKLIST) stmtChk.run(newId(), tenderId, it.section, it.work_name);

  // Параметры тендера для шаблона существенных условий (Генподряд)
  db.prepare(`
    INSERT INTO tender_setup_params (tender_id, contract_kind, escalation, advance, build_months, transfer_months, kp_date, updated_at)
    VALUES (?, 'gen', 'БСМ5%', 'Аванс 30%', 24, 3, '2026-07-29', ?)
  `).run(tenderId, nowIso());

  return tenderId;
}

function runSeed(force = false) {
  runMigration();
  if (!force && !isEmpty()) {
    console.log('[seed] tenders already exist, skipping');
    return;
  }
  if (force) {
    db.exec(`
      DELETE FROM review_decisions;
      DELETE FROM tz_excluded_ranges;
      DELETE FROM issues;
      DELETE FROM analysis_runs;
      DELETE FROM characteristics;
      DELETE FROM qa_entries;
      DELETE FROM work_checklist_items;
      DELETE FROM company_conditions;
      DELETE FROM tender_setup_params;
      DELETE FROM risk_templates;
      DELETE FROM additional_object_info;
      DELETE FROM tender_stage_state;
      DELETE FROM setup_locks;
      DELETE FROM documents;
      DELETE FROM tenders;
    `);
  }
  const id1 = seedTenderSeverniy();
  const id2 = seedTenderZarechnyy();
  console.log('[seed] inserted demo tenders:', id1, id2);
}

function runSeedIfEmpty() {
  if (isEmpty()) runSeed(false);
}

if (require.main === module) {
  const force = process.argv.includes('--force') || process.argv.includes('-f');
  runSeed(force);
  process.exit(0);
}

module.exports = { runSeed, runSeedIfEmpty, isEmpty };
