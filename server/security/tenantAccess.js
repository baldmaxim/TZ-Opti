'use strict';

// Изоляция тенантов: по какому ресурсу бы ни пришёл запрос, его тенант
// вычисляется ИЗ БАЗЫ (а не из тела запроса или заголовка) и сверяется с
// тенантом токена.
//
// Все ресурсы портала висят на тендере, поэтому таблица маршрутов сводится к
// одному вопросу: «какому тендеру принадлежит эта строка». Для дочерних
// сущностей (документ, находка, характеристика, задание) это один JOIN к
// tenders — так добавление новой дочерней таблицы не размывает проверку по
// контроллерам.

const { forbidden, notFound } = require('../utils/errors');

// tenantVia → SQL. Всегда возвращаем и tender_id, и tenant_id: первый нужен
// аудиту и контроллерам, второй — проверке изоляции.
const LOOKUPS = {
  tender: {
    sql: 'SELECT t.id AS tender_id, t.tenant_id AS tenant_id FROM tenders t WHERE t.id = ?',
    param: 'tenderId',
    missing: 'Тендер не найден',
  },
  document: {
    sql: `SELECT d.tender_id AS tender_id, t.tenant_id AS tenant_id
            FROM documents d JOIN tenders t ON t.id = d.tender_id
           WHERE d.id = ?`,
    param: 'documentId',
    missing: 'Документ не найден',
  },
  issue: {
    sql: `SELECT i.tender_id AS tender_id, t.tenant_id AS tenant_id
            FROM issues i JOIN tenders t ON t.id = i.tender_id
           WHERE i.id = ?`,
    param: 'issueId',
    missing: 'Находка не найдена',
  },
  characteristic: {
    sql: `SELECT c.tender_id AS tender_id, t.tenant_id AS tenant_id
            FROM characteristics c JOIN tenders t ON t.id = c.tender_id
           WHERE c.id = ?`,
    param: 'characteristicId',
    missing: 'Характеристика не найдена',
  },
  job: {
    sql: `SELECT j.tender_id AS tender_id, t.tenant_id AS tenant_id
            FROM analysis_jobs j JOIN tenders t ON t.id = j.tender_id
           WHERE j.id = ?`,
    param: 'jobId',
    missing: 'Задание не найдено',
  },
};

// db инжектируется — офлайн-тесты подставляют фейковый набор строк.
function createTenantResolver({ db = require('../db/connection'), defaultTenantId = 'default' } = {}) {
  async function resolve(tenantVia, params = {}) {
    const lookup = LOOKUPS[tenantVia];
    if (!lookup) return null;
    const id = params[lookup.param];
    if (!id) return { found: false, missingMessage: lookup.missing };
    const row = await db.queryOne(lookup.sql, id);
    if (!row) return { found: false, missingMessage: lookup.missing, resourceId: id };
    return {
      found: true,
      resourceId: id,
      tenderId: row.tender_id || null,
      // NULL остаётся у строк, заведённых до миграции изоляции: считаем их
      // тенантом по умолчанию, а не «ничьими» (иначе доступ потеряют все).
      tenantId: row.tenant_id || defaultTenantId,
    };
  }
  return { resolve, lookups: LOOKUPS };
}

// Сверка тенанта субъекта и тенанта ресурса.
//
// Межтенантное обращение отдаёт 403 (а не 404): идентификаторы — UUID v4,
// перебором их не найти, поэтому скрывать факт существования смысла нет, зато
// явный отказ виден в журнале аудита и в поддержке («вам нужен доступ к другому
// тенанту»), а не выглядит как пропавшая запись.
function assertSameTenant(principal, resource) {
  if (!resource) return;
  if (!resource.found) throw notFound(resource.missingMessage || 'Не найдено');
  if (resource.tenantId !== principal.tenantId) {
    const err = forbidden('CROSS_TENANT_DENIED', `tenant ${principal.tenantId} → ${resource.tenantId}`, 'Ресурс принадлежит другой организации');
    err.crossTenant = true;
    throw err;
  }
}

module.exports = { createTenantResolver, assertSameTenant, LOOKUPS };
