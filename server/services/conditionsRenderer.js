'use strict';

const {
  tenderTypeToContractKind,
  PARAMS_SCHEMA,
  CONDITIONS_GEN,
  CONDITIONS_SHELL,
  ESCALATION_GEN,
  ESCALATION_SHELL,
  ADVANCE_VARIANTS,
  BUILD_TERMS_GEN_TEMPLATE,
  BUILD_TERMS_SHELL_TEMPLATE,
} = require('../db/conditionsTemplate');

function pad2(n) { return String(n).padStart(2, '0'); }

// Принимаем ISO-строку YYYY-MM-DD (или с временем) и парсим её как локальную дату,
// чтобы избежать сдвига часового пояса при `new Date('2026-07-29')`.
function parseDateParts(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function formatKpDate(iso) {
  const p = parseDateParts(iso);
  if (!p) return iso || '—';
  return `${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
}

function formatKpDateMonth(iso) {
  const p = parseDateParts(iso);
  if (!p) return iso || '—';
  return `${pad2(p.m)}.${p.y} г.`;
}

function substitutePlaceholders(text, params) {
  if (!text) return '';
  return text
    .replace(/\{kpDate\}/g, formatKpDate(params.kp_date))
    .replace(/\{kpDateMonth\}/g, formatKpDateMonth(params.kp_date))
    .replace(/\{buildMonths\}/g, String(params.build_months ?? '—'))
    .replace(/\{transferMonths\}/g, String(params.transfer_months ?? '—'));
}

/**
 * Возвращает дефолтные параметры для типа договора, на случай отсутствия записи в БД.
 */
function defaultsFor(kind) {
  const schema = PARAMS_SCHEMA[kind] || PARAMS_SCHEMA.shell;
  const out = { contract_kind: kind };
  for (const f of schema) out[f.key] = f.default;
  return out;
}

function getParamsSchema(kind) {
  return PARAMS_SCHEMA[kind] || PARAMS_SCHEMA.shell;
}

function renderDynamic(condition, params, kind) {
  const escalationMap = kind === 'gen' ? ESCALATION_GEN : ESCALATION_SHELL;
  const buildTermsTpl = kind === 'gen' ? BUILD_TERMS_GEN_TEMPLATE : BUILD_TERMS_SHELL_TEMPLATE;

  switch (condition.dynamic) {
    case 'advance': {
      // Только для Генподряда
      const v = ADVANCE_VARIANTS[params.advance];
      return v || '—';
    }
    case 'escalation_compensation': {
      const v = escalationMap[params.escalation];
      return v ? substitutePlaceholders(v.compensation, params) : '—';
    }
    case 'escalation_price_change': {
      const v = escalationMap[params.escalation];
      return v ? substitutePlaceholders(v.priceChange, params) : '—';
    }
    case 'build_terms':
      return substitutePlaceholders(buildTermsTpl, params);
    case 'kp_date':
      return formatKpDate(params.kp_date);
    default:
      return '';
  }
}

/**
 * Возвращает массив условий с подставленными значениями (без overlay из БД).
 * params — нормализованные параметры (см. defaultsFor).
 */
function renderConditions(kind, params) {
  const set = kind === 'gen' ? CONDITIONS_GEN : CONDITIONS_SHELL;
  return set.map((c) => {
    const baseText = c.dynamic
      ? renderDynamic(c, params, kind)
      : (c.text || '');
    return {
      idx: c.idx,
      name: c.name,
      text: baseText,
      isDynamic: !!c.dynamic,
      dynamicKey: c.dynamic || null,
    };
  });
}

module.exports = {
  defaultsFor,
  getParamsSchema,
  renderConditions,
  formatKpDate,
  tenderTypeToContractKind,
};
