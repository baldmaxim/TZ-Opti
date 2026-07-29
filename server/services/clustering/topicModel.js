'use strict';

// ТЕМАТИЧЕСКАЯ модель кластеризации — второй ярус слоя clustering.
//
// Первый ярус (clusteringService: placeKey × semanticBucket) сводит замечания,
// указывающие на ОДНО место ТЗ. Этого мало: одна и та же обязанность ГП
// («ежедневная уборка», «исполнительная документация», «временные сети»,
// «поставка материалов») повторяется в ТЗ в 3–10 пунктах, и инженер получал
// 3–10 отдельных карточек об одном и том же.
//
// Здесь считается ТЕМА замечания — пять осей из спеки:
//   1) тип риска            riskType      (семейство problem_type)
//   2) объект работ         workObject    (предмет обязанности: уборка / ИД / …)
//   3) бизнес-последствие   consequence   (канал влияния от critic)
//   4) рекомендуемое действие requiredAction (что делать инженеру)
//   5) смысловая близость   similarity()  (лексическая сверка текстов)
// Первые четыре дают ТОЧНЫЙ ключ (topicKey) — грубое разбиение; пятая работает
// ВНУТРИ ключа и решает, действительно ли это одна обязанность.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ (спека): «не объединяй разные самостоятельные риски одного
// абзаца». Поэтому mergeGroups НИКОГДА не сливает группы с одинаковым placeKey —
// первый ярус развёл их осознанно (открытый объём ≠ риск оплаты в п. 7.2), и
// второй ярус не имеет права это отменить.
//
// Чистый модуль: без БД, без сети, без LLM. Тестируется офлайн.

// ── Нормализация и лёгкий стемминг ──────────────────────────────────────────
//
// Свой токенайзер, а не vor/vorMatchIndex.stems: там корпус — наименования
// позиций сметы (стоп-слова «устройство», «работы», «итого»), здесь — проза ТЗ.
// Смешивать словари нельзя, а тянуть слой ВОР в слой кластеризации — лишняя связь.

const PROSE_STOPWORDS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'из', 'не', 'от', 'до', 'при', 'к', 'ко',
  'а', 'или', 'же', 'то', 'что', 'как', 'это', 'все', 'том', 'числе', 'др', 'быть',
  'за', 'о', 'об', 'под', 'над', 'без', 'про', 'через', 'между', 'также', 'либо',
  'его', 'ее', 'их', 'иных', 'иные', 'иной', 'любых', 'любые', 'весь', 'всех',
  'должен', 'должна', 'должны', 'обязан', 'обязана', 'обязаны', 'вправе',
  'является', 'осуществляет', 'осуществляется', 'производится', 'выполняется',
  'настоящего', 'настоящему', 'настоящим', 'соответствии', 'соответствующие',
  'пункт', 'пункта', 'пункте', 'раздел', 'раздела', 'разделе', 'тз',
]);

const MIN_TOKEN_LEN = 3;
const STEM_LEN = 6;
const MIN_STEM = 3;

const ENDINGS = [
  'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ыми', 'ими', 'ает', 'ять', 'ить',
  'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ых', 'их', 'ой', 'ей', 'ом', 'ем',
  'ам', 'ям', 'ах', 'ях', 'ую', 'юю', 'ов', 'ев', 'ью', 'ия', 'ии', 'ый', 'ий',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];

// Единая нормализация текста ТЗ: регистр, ё→е, пунктуация → пробел.
// На ней же работают регулярки таксономии объектов работ, поэтому подчёркивание
// тоже становится пробелом: problem_type агенты пишут как «не_учтено_в_кп».
function normalizeRu(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'()[\]{}.,;:!?№/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(token) {
  let t = token;
  for (const end of ENDINGS) {
    if (t.length - end.length >= MIN_STEM && t.endsWith(end)) {
      t = t.slice(0, -end.length);
      break;
    }
  }
  return t.length > STEM_LEN ? t.slice(0, STEM_LEN) : t;
}

function stems(text) {
  const norm = normalizeRu(text);
  if (!norm) return [];
  const out = [];
  for (const raw of norm.split(/[^0-9a-zа-я]+/)) {
    if (!raw || raw.length < MIN_TOKEN_LEN) continue;
    if (PROSE_STOPWORDS.has(raw)) continue;
    out.push(/^\d+$/.test(raw) ? raw : stemToken(raw));
  }
  return out;
}

const stemSet = (text) => new Set(stems(text));

// Жаккар по множествам основ. Короткие формулировки ТЗ дают низкие значения
// (общих слов мало), поэтому пороги ниже привычных — см. MIN_SIMILARITY.
function similarity(a, b) {
  const A = a instanceof Set ? a : stemSet(a);
  const B = b instanceof Set ? b : stemSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const s of A) if (B.has(s)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// ── Объект работ (предмет обязанности) ──────────────────────────────────────
//
// Таксономия типовых обязанностей ГП в ТЗ на СМР. Вес > 1 — специфичная фраза
// («исполнительная документация» точнее, чем просто «документация»), она должна
// перебивать общее совпадение соседней темы. Порядок в списке — тай-брейк при
// равных весах.

const WORK_OBJECTS = [
  {
    id: 'as_built_docs',
    label: 'Исполнительная документация',
    patterns: [
      [/исполнительн[а-я]*\s+документ/, 4],
      [/акт[а-я]*\s+освидетельствован/, 3],
      [/скрыт[а-я]*\s+работ/, 3],
      [/исполнительн[а-я]*\s+схем/, 3],
      [/исполнительн[а-я]*\s+съемк/, 3],
      [/журнал[а-я]*\s+(?:производств|работ)/, 2],
      [/паспорт[а-я]*\s+(?:и\s+)?сертификат/, 2],
      [/\bид\b/, 1],
    ],
  },
  {
    id: 'temporary_utilities',
    label: 'Временные сети и подключения',
    patterns: [
      [/временн[а-я]*\s+(?:сет|инженерн|коммуникац)/, 4],
      [/временн[а-я]*\s+(?:электроснабж|водоснабж|теплоснабж|канализац|освещен)/, 4],
      [/временн[а-я]*\s+подключен/, 3],
      [/точк[а-я]*\s+подключен/, 3],
      [/период\s+строительств[а-я]*\s+(?:электро|вод|тепл)/, 2],
      [/энергоснабжен[а-я]*\s+(?:строительн|площадк)/, 2],
      [/времен[а-я]*\s+титул/, 2],
    ],
  },
  {
    id: 'cleaning',
    label: 'Уборка и вывоз мусора',
    patterns: [
      [/уборк/, 3],
      [/убор[а-я]*\s+(?:территор|помещен|площадк)/, 4],
      [/вывоз[а-я]*\s+(?:мусор|отход|снег|грунт)/, 4],
      [/строительн[а-я]*\s+мусор/, 4],
      [/утилизац[а-я]*\s+отход/, 3],
      [/чистот/, 3],
      [/мойк[а-я]*\s+колес/, 2],
    ],
  },
  {
    id: 'material_supply',
    label: 'Поставка материалов и оборудования',
    patterns: [
      [/поставк[а-я]*\s+(?:материал|оборудован|издели|конструкц)/, 4],
      [/обеспечен[а-я]*\s+материал/, 3],
      [/давальческ/, 3],
      [/закупк[а-я]*\s+(?:материал|оборудован)/, 3],
      [/приобретен[а-я]*\s+(?:материал|оборудован)/, 3],
      [/поставля[а-я]*\s+материал/, 3],
      [/входн[а-я]*\s+контрол/, 2],
      [/материал[а-я]*\s+(?:и\s+)?оборудован/, 2],
    ],
  },
  {
    id: 'site_facilities',
    label: 'Стройгородок и временные здания',
    patterns: [
      [/строительн[а-я]*\s+городок/, 4],
      [/бытов[а-я]*\s+(?:помещен|городок|вагон)/, 4],
      [/временн[а-я]*\s+(?:здан|сооружен|дорог|огражден)/, 3],
      [/ограждени[а-я]*\s+(?:строительн\s+)?площадк/, 2],
    ],
  },
  {
    id: 'security',
    label: 'Охрана объекта и пропускной режим',
    patterns: [
      [/охран[а-я]*\s+(?:объект|территор|площадк|имуществ)/, 4],
      [/пропускн[а-я]*\s+режим/, 4],
      [/видеонаблюден/, 2],
      [/сохранн[а-я]*\s+(?:материал|имуществ)/, 2],
    ],
  },
  {
    id: 'labor_safety',
    label: 'Охрана труда и промбезопасность',
    patterns: [
      [/охран[а-я]*\s+труд/, 4],
      [/техник[а-я]*\s+безопасност/, 4],
      [/пожарн[а-я]*\s+безопасност/, 3],
      [/\bсиз\b/, 3],
      [/промышленн[а-я]*\s+безопасност/, 3],
    ],
  },
  {
    id: 'design_docs',
    label: 'Проектная и рабочая документация',
    patterns: [
      [/рабоч[а-я]*\s+документац/, 4],
      [/проектн[а-я]*\s+документац/, 4],
      [/разработк[а-я]*\s+(?:чертеж|проект)/, 3],
      [/\bппр\b/, 3],
      [/деталировочн/, 2],
    ],
  },
  {
    id: 'commissioning',
    label: 'Сдача-приёмка и пусконаладка',
    patterns: [
      [/пусконаладоч/, 4],
      [/\bпнр\b/, 3],
      [/ввод[а-я]*\s+в\s+эксплуатац/, 4],
      [/рабоч[а-я]*\s+комисс/, 3],
      [/сдач[а-я]*\s+(?:объект|работ)/, 2],
    ],
  },
  {
    id: 'warranty',
    label: 'Гарантийные обязательства',
    patterns: [
      [/гарантийн[а-я]*\s+(?:срок|обязательств|период)/, 4],
      [/гарант/, 2],
      [/устранен[а-я]*\s+дефект/, 3],
    ],
  },
  {
    id: 'payment_terms',
    label: 'Порядок оплаты',
    patterns: [
      [/порядок\s+(?:оплат|расчет)/, 4],
      [/гарантийн[а-я]*\s+удержан/, 4],
      [/аванс/, 3],
      [/отсрочк[а-я]*\s+платеж/, 3],
      [/оплат/, 1],
    ],
  },
  {
    id: 'schedule_terms',
    label: 'Сроки и график работ',
    patterns: [
      [/график[а-я]*\s+(?:производств|работ|выполнен)/, 4],
      [/календарн[а-я]*\s+план/, 3],
      [/срок[а-я]*\s+(?:выполнен|производств|завершен)/, 3],
    ],
  },
  {
    id: 'permits',
    label: 'Согласования и разрешения',
    patterns: [
      [/получен[а-я]*\s+(?:разрешен|согласован|ордер)/, 4],
      [/согласован[а-я]*\s+с\s+(?:заказчик|надзор|эксплуатирующ)/, 3],
      [/технадзор/, 2],
    ],
  },
  {
    id: 'geodesy',
    label: 'Геодезия и изыскания',
    patterns: [
      [/геодезическ/, 4],
      [/разбивочн[а-я]*\s+работ/, 3],
      [/инженерн[а-я]*\s+изыскан/, 3],
    ],
  },
  {
    id: 'utility_costs',
    label: 'Оплата энергоресурсов',
    patterns: [
      [/энергоресурс/, 4],
      [/оплат[а-я]*\s+(?:электроэнерг|вод|тепл)/, 4],
      [/прибор[а-я]*\s+учет/, 3],
      [/коммунальн[а-я]*\s+(?:услуг|платеж)/, 3],
    ],
  },
];

const WORK_OBJECT_LABEL = WORK_OBJECTS.reduce((m, o) => { m[o.id] = o.label; return m; }, {});

// Объект работ по тексту замечания. Возвращает { id, label, score } или null,
// если ни один шаблон не сработал (тогда тему держит только лексическая сверка).
function detectWorkObject(text) {
  const norm = normalizeRu(text);
  if (!norm) return null;
  let best = null;
  for (const obj of WORK_OBJECTS) {
    let score = 0;
    for (const [re, weight] of obj.patterns) {
      if (re.test(norm)) score += weight;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { id: obj.id, label: obj.label, score };
    }
  }
  return best;
}

// ── Тип риска ───────────────────────────────────────────────────────────────
//
// problem_type агенты пишут свободно («не_учтено_в_кп», «не учтено в ВОР»),
// поэтому семейства заданы регулярками поверх нормализованного значения.
// Не распознанное остаётся самим собой — ключ тогда просто строже.

const RISK_FAMILIES = [
  [/не\s*учтен|не\s*посчитан|отсутств[а-я]*\s*в\s*(вор|кп)|пробел\s*покрыт|покрыт/, 'coverage_gap'],
  [/открыт[а-я]*\s*объем|неограничен|в\s*полном\s*объеме|за\s*свой\s*счет|расширен[а-я]*\s*объем/, 'open_scope'],
  [/оплат|платеж|аванс|удержан|расчет/, 'payment_risk'],
  [/срок|график|просрочк|штраф[а-я]*\s*за\s*срок/, 'schedule_risk'],
  [/ответственност|риск\s*подрядчик|возмещен|неустойк|штраф/, 'liability_risk'],
  [/обязанност|за\s*счет\s*подрядчик|силами\s*подрядчик|иждивен/, 'contractor_duty'],
  [/противореч|несоответств|разночтен/, 'contradiction'],
  [/неоднозначн|не\s*определен|не\s*указан|уточнен|вопрос/, 'ambiguity'],
];

function riskTypeOf(draft) {
  const raw = normalizeRu((draft && draft.problem_type) || '');
  if (raw) {
    for (const [re, family] of RISK_FAMILIES) {
      if (re.test(raw)) return family;
    }
    return raw.replace(/\s+/g, '_');
  }
  const cat = normalizeRu((draft && draft.category) || '');
  return cat ? cat.replace(/\s+/g, '_') : 'general';
}

// ── Рекомендуемое действие ──────────────────────────────────────────────────
//
// required_action от critic может быть не заполнено (критик не прогонялся) —
// тогда выводим его из семейства suggested_action, чтобы ключ оставался
// детерминированным и не появлялось «wildcard»-значения, склеивающего всё подряд.
const ACTION_FAMILY_FALLBACK = {
  remove: 'exclude_scope',
  modify: 'amend_tz',
  note: 'ask_customer',
};

function requiredActionOf(review, family) {
  const ra = review && review.required_action;
  if (ra && ra !== 'none') return String(ra);
  return ACTION_FAMILY_FALLBACK[family] || 'none';
}

// ── Раздел ТЗ ───────────────────────────────────────────────────────────────

// Корневой раздел пункта: «п. 5.1.2 Состав работ» → «Раздел 5».
// Без номера — сам пункт (обрезанный), без пункта — null.
function sectionLabel(tzClause) {
  const raw = String(tzClause == null ? '' : tzClause).trim();
  if (!raw) return null;
  const m = raw.match(/(\d+)(?:[.)]\d+)*/);
  if (m) return `Раздел ${m[1]}`;
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
}

// ── Описание темы группы ────────────────────────────────────────────────────

// Текст, по которому считается тема: пункт + дословный фрагмент + основание.
function topicText(draft) {
  return [draft && draft.tz_clause, draft && draft.source_fragment, draft && draft.basis]
    .filter(Boolean)
    .join(' ');
}

// Пять осей темы для одной группы первого яруса.
//   consequence — доминирующее измерение значимости (бизнес-последствие), его
//   считает clusteringService.dominantDimension и передаёт сюда, чтобы не
//   дублировать знание о колонках critic.
function describe(draft, review, consequence, family) {
  const text = topicText(draft);
  const workObject = detectWorkObject(text);
  const riskType = riskTypeOf(draft);
  const requiredAction = requiredActionOf(review, family);
  const objectId = workObject ? workObject.id : 'other';
  return {
    riskType,
    workObject: objectId,
    workObjectLabel: workObject ? workObject.label : null,
    consequence: consequence || 'general',
    actionFamily: family || 'note',
    requiredAction,
    topicKey: `${riskType}|${objectId}|${consequence || 'general'}|${family || 'note'}|${requiredAction}`,
    stems: stemSet(text),
  };
}

// ── Слияние групп по теме ───────────────────────────────────────────────────

// Порог смысловой близости. Формулировки ТЗ об одной обязанности пересекаются
// словами ПЛОХО: «обеспечивает ежедневную уборку площадки» и «вывоз
// строительного мусора силами Подрядчика» — одно требование и почти нулевой
// Жаккар. Поэтому:
//   • объект работ РАСПОЗНАН — лексическая сверка не нужна (known = 0):
//     смысловую близость уже подтвердила таксономия, и она сильнее совпадения
//     слов; требовать сверх этого текстового пересечения значит снова расщепить
//     одно требование по синонимам — ровно то, что чинится;
//   • объект НЕ распознан ('other') — опора только текст, порог высокий, иначе
//     совпадения «тип риска + последствие + действие» хватило бы, чтобы склеить
//     содержательно разные замечания.
const MIN_SIMILARITY = Object.freeze({ known: 0, other: 0.45 });

function thresholdFor(topic) {
  return topic.workObject === 'other' ? MIN_SIMILARITY.other : MIN_SIMILARITY.known;
}

function orderOf(group) {
  const p = group.paragraphIndex;
  return p == null ? Number.MAX_SAFE_INTEGER : p;
}

// Группы первого яруса → «единицы кластера». Каждая единица = один кластер.
//
// Алгоритм: точное разбиение по topicKey, внутри — жадная агломерация в порядке
// документа (single-link: группа примыкает к теме, если близка ХОТЯ БЫ к одному
// её участнику). Порядок детерминирован (абзац → ключ), поэтому результат
// воспроизводим и id кластера стабилен.
//
// ЗАПРЕТ: две группы с одинаковым placeKey не сливаются никогда — первый ярус
// развёл разные самостоятельные риски одного абзаца намеренно.
function mergeGroups(groups) {
  const sorted = [...(groups || [])].sort(
    (a, b) => orderOf(a) - orderOf(b) || String(a.key).localeCompare(String(b.key)),
  );

  const byTopic = new Map();
  for (const g of sorted) {
    const key = g.topic ? g.topic.topicKey : `nokey:${g.key}`;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(g);
  }

  const units = [];
  for (const [topicKey, bucket] of byTopic) {
    const open = []; // { groups: [], places: Set }
    for (const g of bucket) {
      const threshold = thresholdFor(g.topic || { workObject: 'other' });
      let target = null;
      for (const unit of open) {
        if (unit.places.has(g.placeKey)) continue; // разные риски одного места
        // threshold=0 — объект работ распознан, лексическая сверка не требуется.
        const close = threshold <= 0 || unit.groups.some(
          (m) => similarity(m.topic.stems, g.topic.stems) >= threshold,
        );
        if (close) { target = unit; break; }
      }
      if (target) {
        target.groups.push(g);
        target.places.add(g.placeKey);
      } else {
        open.push({ groups: [g], places: new Set([g.placeKey]) });
      }
    }
    for (const unit of open) {
      units.push({ topicKey, topic: unit.groups[0].topic, groups: unit.groups });
    }
  }
  return units;
}

// Ключ кластера. Одноместный кластер сохраняет ИСТОРИЧЕСКУЮ форму
// (placeKey::semanticBucket) — от неё зависит перенос решений между прогонами
// (analysisRuns.matchDecisionsToClusters, match='exact'). Тематический кластер
// получает ключ темы + якорь = место ПЕРВОГО вхождения в документе.
function unitClusterKey(unit) {
  if (!unit.groups || unit.groups.length <= 1) return unit.groups[0].key;
  const anchor = [...unit.groups].sort(
    (a, b) => orderOf(a) - orderOf(b) || String(a.placeKey).localeCompare(String(b.placeKey)),
  )[0];
  return `topic:${unit.topicKey}::${anchor.placeKey}`;
}

module.exports = {
  // текст
  normalizeRu,
  stems,
  stemSet,
  similarity,
  // оси темы
  WORK_OBJECTS,
  WORK_OBJECT_LABEL,
  detectWorkObject,
  RISK_FAMILIES,
  riskTypeOf,
  requiredActionOf,
  sectionLabel,
  topicText,
  describe,
  // слияние
  MIN_SIMILARITY,
  mergeGroups,
  unitClusterKey,
};
