'use strict';

// Манифест тендерного пакета — ЧИСТОЕ ядро (ни БД, ни express): офлайн-тесты
// гоняют его целиком.
//
// Тендерный пакет — это НЕ «по одному файлу на тип, побеждает последний
// загруженный». Риск ГП часто живёт МЕЖДУ документами (ТЗ ↔ ВОР ↔ Q&A ↔
// договор ↔ график), поэтому у каждого документа есть манифест-поля:
//   revision_label        — редакция («редакция 3», «изм. 2»)
//   actuality_status      — actual | informational | superseded
//   doc_date              — дата документа (ISO, YYYY-MM-DD)
//   conflict_priority     — приоритет при противоречии (больше = важнее)
//   applicability         — применимость («корпус 1», «раздел АР»)
//   supersedes_document_id — какой документ заменён этой редакцией
//
// Вход анализа выбирается ПО ЭТИМ ПОЛЯМ (selectActiveDocuments), а не по
// uploaded_at: superseded исключается всегда, informational (справочный /
// неполный, например РД «для информации») уступает actual, дальше — приоритет,
// дата документа, дата загрузки.

const DOC_STATUSES = Object.freeze(['actual', 'informational', 'superseded']);

// Порядок = порядок разделов манифеста в API и UI.
const DOC_TYPE_LABELS = Object.freeze({
  tz: 'ТЗ',
  vor: 'ВОР',
  pd_rd: 'ПД / РД',
  contract: 'Проект договора',
  schedule: 'График',
  specification: 'Спецификации',
  qa: 'Вопрос-ответ (Q&A)',
  checklist: 'Чек-лист',
  company_conditions: 'Условия компании',
  risks: 'Библиотека рисков',
  other: 'Прочие приложения',
});

const MAX_LABEL = 200;
const MAX_APPLICABILITY = 300;
const PRIORITY_MIN = -1000;
const PRIORITY_MAX = 1000;

function ownStatus(doc) {
  const s = String((doc && doc.actuality_status) || '').trim().toLowerCase();
  return DOC_STATUSES.includes(s) ? s : 'actual';
}

// Обратные ссылки замены: если Б заявляет supersedes_document_id = А, то А
// заменён, ДАЖЕ если его собственный статус забыли обновить (fail-closed:
// заменённый документ не должен просочиться в анализ из-за недоделанной ручной
// разметки).
function supersededByMap(docs) {
  const map = new Map();
  for (const d of docs || []) {
    if (d && d.supersedes_document_id) {
      const list = map.get(d.supersedes_document_id) || [];
      list.push(d.id);
      map.set(d.supersedes_document_id, list);
    }
  }
  return map;
}

// Документы + вычисленные поля манифеста: manifest_status (эффективный статус
// с учётом обратных ссылок замены) и superseded_by (кто заменил).
function annotateDocuments(docs) {
  const reverse = supersededByMap(docs);
  return (docs || []).map((d) => ({
    ...d,
    manifest_status: reverse.has(d.id) ? 'superseded' : ownStatus(d),
    superseded_by: reverse.get(d.id) || [],
  }));
}

function priorityOf(doc) {
  const n = Number(doc.conflict_priority);
  return Number.isFinite(n) ? n : -Infinity;
}

// ISO-строки сравниваются лексикографически; null/пусто — в конец.
function dateKey(v) {
  const s = String(v || '').trim();
  return s || '';
}

// Порядок актуальности: actual раньше informational, затем приоритет при
// противоречии (DESC), дата документа (DESC, без даты — позже), дата загрузки
// (DESC), id — стабильность.
function compareByRelevance(a, b) {
  const rank = (d) => (d.manifest_status === 'actual' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (priorityOf(a) !== priorityOf(b)) return priorityOf(b) - priorityOf(a);
  const da = dateKey(a.doc_date);
  const db_ = dateKey(b.doc_date);
  if (da !== db_) {
    if (!da) return 1;
    if (!db_) return -1;
    return db_ < da ? -1 : 1;
  }
  const ua = dateKey(a.uploaded_at);
  const ub = dateKey(b.uploaded_at);
  if (ua !== ub) return ub < ua ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

// Актуальные документы типа: superseded исключён всегда, остальные — в порядке
// релевантности. `match` — необязательный фильтр по имени (например /\.md$/i
// для md-копии ТЗ). docs — ВСЕ документы тендера (нужны обратные ссылки).
function selectActiveDocuments(docs, docType, { match = null } = {}) {
  return annotateDocuments(docs)
    .filter((d) => d.doc_type === docType)
    .filter((d) => d.manifest_status !== 'superseded')
    .filter((d) => !match || match.test(String(d.name || '')))
    .sort(compareByRelevance);
}

function pickPrimaryDocument(docs, docType, opts = {}) {
  return selectActiveDocuments(docs, docType, opts)[0] || null;
}

// --- Валидация PATCH-полей манифеста -----------------------------------------

// patch → { value, errors[] }. Неизвестные ключи — ошибка (а не молчаливое
// игнорирование: опечатка в имени поля не должна выглядеть успехом).
function normalizeManifestPatch(patch) {
  const errors = [];
  const value = {};
  const src = patch && typeof patch === 'object' ? patch : {};
  const known = [
    'revision_label', 'actuality_status', 'doc_date',
    'conflict_priority', 'applicability', 'supersedes_document_id',
  ];
  for (const key of Object.keys(src)) {
    if (!known.includes(key)) errors.push(`Неизвестное поле манифеста: «${key}»`);
  }

  const strField = (key, max) => {
    if (!(key in src)) return;
    const raw = src[key];
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      value[key] = null;
      return;
    }
    const s = String(raw).trim();
    if (s.length > max) errors.push(`Поле «${key}» длиннее ${max} символов`);
    else value[key] = s;
  };

  strField('revision_label', MAX_LABEL);
  strField('applicability', MAX_APPLICABILITY);

  if ('actuality_status' in src) {
    const raw = src.actuality_status;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      value.actuality_status = 'actual';
    } else {
      const s = String(raw).trim().toLowerCase();
      if (!DOC_STATUSES.includes(s)) {
        errors.push(`Недопустимый статус актуальности: «${raw}» (ожидается ${DOC_STATUSES.join(' | ')})`);
      } else value.actuality_status = s;
    }
  }

  if ('doc_date' in src) {
    const raw = src.doc_date;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      value.doc_date = null;
    } else {
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        errors.push(`Дата документа должна быть в формате YYYY-MM-DD: «${raw}»`);
      } else value.doc_date = s;
    }
  }

  if ('conflict_priority' in src) {
    const raw = src.conflict_priority;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      value.conflict_priority = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) {
        errors.push(`Приоритет — целое число от ${PRIORITY_MIN} до ${PRIORITY_MAX}: «${raw}»`);
      } else value.conflict_priority = n;
    }
  }

  if ('supersedes_document_id' in src) {
    const raw = src.supersedes_document_id;
    value.supersedes_document_id = raw === null || raw === undefined || String(raw).trim() === ''
      ? null
      : String(raw).trim();
  }

  return { value, errors };
}

// Проверка ссылки замены ПЕРЕД записью: цель существует, не сам себя, цепочка
// замен не зацикливается. docs — все документы тендера, docId — кто заменяет,
// targetId — кого заменяют. Возвращает null (ок) или текст ошибки.
function validateSupersedes(docs, docId, targetId) {
  if (!targetId) return null;
  if (targetId === docId) return 'Документ не может заменять сам себя';
  const byId = new Map((docs || []).map((d) => [d.id, d]));
  if (!byId.has(targetId)) return 'Заменяемый документ не найден в этом тендере';
  // Цикл: идём от цели по её ссылкам замены — если дошли до docId, установка
  // ссылки замкнула бы цепочку.
  const seen = new Set([docId]);
  let cur = targetId;
  while (cur) {
    if (seen.has(cur)) return 'Цепочка замены зацикливается';
    seen.add(cur);
    const doc = byId.get(cur);
    cur = doc ? doc.supersedes_document_id : null;
  }
  return null;
}

// --- Сборка манифеста ---------------------------------------------------------

// Все документы тендера → манифест: группы по типу (в фиксированном порядке) +
// предупреждения о разметке (висячая ссылка замены, цикл, несколько актуальных
// md-копий ТЗ). Ничего не скрывается: superseded остаются в группе (в конце).
function buildManifest(docs) {
  const annotated = annotateDocuments(docs);
  const byId = new Map(annotated.map((d) => [d.id, d]));
  const warnings = [];

  for (const d of annotated) {
    if (d.supersedes_document_id && !byId.has(d.supersedes_document_id)) {
      warnings.push({
        code: 'supersedes_missing',
        document_id: d.id,
        message: `«${d.name}»: заменяемый документ ${d.supersedes_document_id} удалён или не существует`,
      });
    }
    if (d.supersedes_document_id
        && validateSupersedes(annotated, d.id, d.supersedes_document_id) === 'Цепочка замены зацикливается') {
      warnings.push({
        code: 'supersedes_cycle',
        document_id: d.id,
        message: `«${d.name}»: цепочка замены зацикливается`,
      });
    }
  }

  const activeTzMd = selectActiveDocuments(docs, 'tz', { match: /\.md$/i });
  if (activeTzMd.length > 1) {
    warnings.push({
      code: 'ambiguous_tz_md',
      document_id: activeTzMd[0].id,
      message: `Несколько актуальных .md-копий ТЗ (${activeTzMd.length}) — анализ возьмёт «${activeTzMd[0].name}»`,
    });
  }

  const types = [...Object.keys(DOC_TYPE_LABELS)];
  for (const d of annotated) if (!types.includes(d.doc_type)) types.push(d.doc_type);

  const groups = [];
  for (const type of types) {
    const inType = annotated.filter((d) => d.doc_type === type);
    if (!inType.length) continue;
    const active = inType.filter((d) => d.manifest_status !== 'superseded').sort(compareByRelevance);
    const superseded = inType.filter((d) => d.manifest_status === 'superseded').sort(compareByRelevance);
    groups.push({
      doc_type: type,
      label: DOC_TYPE_LABELS[type] || type,
      documents: [...active, ...superseded],
      active_count: active.length,
    });
  }

  return { groups, warnings, total: annotated.length };
}

// --- Вклад манифеста в ревизию набора документов ------------------------------

// Суффикс к «версии» документа для computeDocumentsRevision: изменение
// манифест-полей (статус, приоритет, замена, редакция, применимость, дата) —
// это изменение ВХОДА анализа, ревизия набора обязана смениться. Для документа
// с дефолтной разметкой суффикс ПУСТОЙ — ревизии существующих тендеров, где
// манифест не трогали, не меняются.
function manifestRevisionSuffix(doc) {
  if (!doc) return '';
  const status = ownStatus(doc);
  const parts = [];
  if (status !== 'actual') parts.push(`st=${status}`);
  if (doc.revision_label) parts.push(`rev=${doc.revision_label}`);
  if (doc.doc_date) parts.push(`dt=${doc.doc_date}`);
  if (doc.conflict_priority !== null && doc.conflict_priority !== undefined
      && String(doc.conflict_priority) !== '') parts.push(`pr=${doc.conflict_priority}`);
  if (doc.applicability) parts.push(`ap=${doc.applicability}`);
  if (doc.supersedes_document_id) parts.push(`sup=${doc.supersedes_document_id}`);
  return parts.length ? `#m{${parts.join(';')}}` : '';
}

module.exports = {
  DOC_STATUSES,
  DOC_TYPE_LABELS,
  annotateDocuments,
  selectActiveDocuments,
  pickPrimaryDocument,
  compareByRelevance,
  normalizeManifestPatch,
  validateSupersedes,
  buildManifest,
  manifestRevisionSuffix,
};
