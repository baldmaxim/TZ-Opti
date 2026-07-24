'use strict';

// Роли и права — ЧИСТЫЙ модуль (ни env, ни БД, ни express): матрицу можно
// целиком прогнать офлайн-тестом, а изменение прав видно одним диффом.
//
// Роль — это набор прав, право — это то, что проверяет маршрут (security/policy.js).
// Роли НЕ вложены иерархически «по номеру»: manager не «больше» инженера, у него
// другая работа (смотреть и выгружать, но не решать за инженера).

const PERMISSIONS = Object.freeze([
  'tender.read', //     видеть тендер и его данные
  'tender.create', //   заводить тендер
  'tender.update', //   менять карточку тендера
  'tender.delete', //   удалять тендер
  'document.read', //   скачивать документ / читать извлечённый текст
  'document.upload', // загружать документ
  'document.delete', // удалять документ
  'setup.write', //     чек-лист, условия, риски, Q&A, характеристики, параметры, локи
  'analysis.run', //    запуск стадий, конвейера, задач очереди, переимпорт ВОР
  'decision.write', //  решения по находкам/кластерам (главный результат работы)
  'export.perform', //  выгрузки (.docx с правками, csv/json/md, preview)
  'audit.read', //      чтение журнала аудита своего тенанта
  'admin.system', //    служебное: статистика очереди, системные разделы
]);

const ROLES = Object.freeze(['viewer', 'engineer', 'lead', 'manager', 'admin']);

const READ_ONLY = ['tender.read', 'document.read'];

const ENGINEER = [
  ...READ_ONLY,
  'tender.create',
  'tender.update',
  'document.upload',
  'document.delete',
  'setup.write',
  'analysis.run',
  'decision.write',
  'export.perform',
];

const ROLE_PERMISSIONS = Object.freeze({
  // Наблюдатель: только смотрит. Ни выгрузок, ни запуска анализа.
  viewer: Object.freeze([...READ_ONLY]),
  // Инженер тендерного отдела: основной пользователь портала.
  engineer: Object.freeze([...ENGINEER]),
  // Руководитель группы: инженер + удаление и чтение журнала аудита.
  lead: Object.freeze([...ENGINEER, 'tender.delete', 'audit.read']),
  // Руководитель направления: контроль и выгрузки, но НЕ решения за инженера
  // и не запуск анализа (это рабочий инструмент инженера).
  manager: Object.freeze([...READ_ONLY, 'tender.create', 'tender.update', 'export.perform', 'audit.read']),
  // Администратор: всё в пределах СВОЕГО тенанта (изоляция тенантов на админа
  // тоже распространяется — межтенантного «супер-доступа» в системе нет).
  admin: Object.freeze([...PERMISSIONS]),
});

const PERMISSION_SET = new Set(PERMISSIONS);
const ROLE_SET = new Set(ROLES);

const isRole = (role) => ROLE_SET.has(String(role || '').trim().toLowerCase());
const isPermission = (perm) => PERMISSION_SET.has(perm);

// Права набора ролей = объединение. Неизвестные роли молча игнорируются:
// провайдер обычно отдаёт и свои служебные группы, они не должны ничего давать.
function permissionsFor(roles = []) {
  const out = new Set();
  for (const raw of roles) {
    const role = String(raw || '').trim().toLowerCase();
    const perms = ROLE_PERMISSIONS[role];
    if (!perms) continue;
    for (const p of perms) out.add(p);
  }
  return out;
}

function can(roles, permission) {
  if (!isPermission(permission)) return false; // неизвестное право — отказ
  return permissionsFor(roles).has(permission);
}

// Матрица для документации и тестов: { permission: [роли] }.
function permissionMatrix() {
  const matrix = {};
  for (const perm of PERMISSIONS) {
    matrix[perm] = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(perm));
  }
  return matrix;
}

module.exports = { ROLES, PERMISSIONS, ROLE_PERMISSIONS, permissionsFor, can, isRole, isPermission, permissionMatrix };
