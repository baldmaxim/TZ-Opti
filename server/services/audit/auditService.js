'use strict';

// Журнал аудита: КТО, ЧТО, НАД ЧЕМ и ЧЕМ КОНЧИЛОСЬ.
//
// Пишется на каждое обращение к защищённому маршруту — чтение, изменение,
// запуск анализа, решение по находке, выгрузка, отказ доступа. Запись
// НЕ ЛОМАЕТ запрос: сбой журнала логируется, но пользовательская операция
// (уже выполненная) не откатывается — иначе недоступность одной таблицы
// останавливала бы работу всего портала.
//
// Чистая часть (normalizeEntry) отделена от SQL: она проверяется офлайн-тестом.

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');

const CATEGORIES = ['read', 'write', 'analysis', 'decision', 'export', 'admin', 'auth'];
const OUTCOMES = ['allowed', 'denied', 'error'];

const MAX_TEXT = 512;
const clip = (v, max = MAX_TEXT) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// Приводит запись к колонкам таблицы. Никаких секретов: ни токена, ни
// заголовка Authorization, ни query-строки (в ней бывают поисковые запросы).
function normalizeEntry(entry = {}) {
  const category = CATEGORIES.includes(entry.category) ? entry.category : 'read';
  const outcome = OUTCOMES.includes(entry.outcome) ? entry.outcome : 'allowed';
  const roles = Array.isArray(entry.actorRoles) ? entry.actorRoles.join(',') : clip(entry.actorRoles, 200);
  let meta = null;
  if (entry.meta !== undefined && entry.meta !== null) {
    try {
      meta = clip(JSON.stringify(entry.meta), 2000);
    } catch {
      meta = null;
    }
  }
  return {
    id: entry.id || newId(),
    ts: entry.ts || nowIso(),
    request_id: clip(entry.requestId, 64),
    tenant_id: clip(entry.tenantId, 64),
    actor_sub: clip(entry.actorSub, 200),
    actor_email: clip(entry.actorEmail, 200),
    actor_roles: roles,
    auth_method: clip(entry.authMethod, 32),
    action: clip(entry.action || 'unknown', 64),
    category,
    outcome,
    resource_type: clip(entry.resourceType, 64),
    resource_id: clip(entry.resourceId, 64),
    tender_id: clip(entry.tenderId, 64),
    method: clip(entry.method, 10),
    path: clip(entry.path, 300),
    status: Number.isFinite(entry.status) ? Math.trunc(entry.status) : null,
    duration_ms: Number.isFinite(entry.durationMs) ? Math.trunc(entry.durationMs) : null,
    ip: clip(entry.ip, 64),
    user_agent: clip(entry.userAgent, 300),
    reason: clip(entry.reason, 300),
    meta,
  };
}

const COLUMNS = [
  'id', 'ts', 'request_id', 'tenant_id', 'actor_sub', 'actor_email', 'actor_roles', 'auth_method',
  'action', 'category', 'outcome', 'resource_type', 'resource_id', 'tender_id', 'method', 'path',
  'status', 'duration_ms', 'ip', 'user_agent', 'reason', 'meta',
];

async function insert(row) {
  await db.queryRun(
    `INSERT INTO audit_log (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
    ...COLUMNS.map((c) => row[c]),
  );
}

// Best-effort запись. Возвращает id записи (или null, если запись не удалась).
async function record(entry) {
  const row = normalizeEntry(entry);
  try {
    await insert(row);
    return row.id;
  } catch (err) {
    // Журнал недоступен — это заметный инцидент, но не повод отдать 500 на
    // операцию, которая уже выполнена.
    console.error(`[audit] запись не удалась (${row.action}/${row.outcome}): ${err.message}`);
    return null;
  }
}

// Чтение журнала — всегда в пределах ОДНОГО тенанта (аргумент обязателен).
async function list({ tenantId, tenderId, actorSub, action, category, outcome, since, until, limit = 100, offset = 0 } = {}) {
  if (!tenantId) throw new Error('audit.list: tenantId обязателен');
  const where = ['tenant_id = ?'];
  const params = [tenantId];
  const add = (cond, value) => {
    if (value === undefined || value === null || value === '') return;
    where.push(cond);
    params.push(value);
  };
  add('tender_id = ?', tenderId);
  add('actor_sub = ?', actorSub);
  add('action = ?', action);
  add('category = ?', category);
  add('outcome = ?', outcome);
  add('ts >= ?', since);
  add('ts <= ?', until);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = await db.queryAll(
    `SELECT ${COLUMNS.join(', ')} FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    lim,
    off,
  );
  const total = await db.queryOne(`SELECT COUNT(*) AS c FROM audit_log WHERE ${where.join(' AND ')}`, ...params);
  return { items: rows, total: Number(total?.c ?? 0), limit: lim, offset: off };
}

// Удаление по сроку хранения (вызывается вручную/по расписанию).
async function purgeOlderThan(isoDate) {
  const r = await db.queryRun('DELETE FROM audit_log WHERE ts < ?', isoDate);
  return r.changes || 0;
}

module.exports = { record, list, purgeOlderThan, normalizeEntry, CATEGORIES, OUTCOMES, COLUMNS };
