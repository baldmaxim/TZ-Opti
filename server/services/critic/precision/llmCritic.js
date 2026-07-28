'use strict';

// УРОВЕНЬ 2 precision-критика: НЕЗАВИСИМАЯ LLM-проверка СПОРНЫХ замечаний.
//
// Роль модели здесь противоположна роли агента стадии. Агент ИЩЕТ замечания и
// заинтересован их найти; критик ищет ОСНОВАНИЯ НЕ ПОКАЗЫВАТЬ и по умолчанию
// склоняется к «скрыть». Критик не видит confidence агента и его criticality —
// специально: «агент уверен» не является доводом за публикацию, и знать об этом
// критику незачем.
//
// К модели уходят ТОЛЬКО спорные замечания (жёсткие фильтры их не решили) —
// пакетами, чтобы один вызов закрывал несколько замечаний. Сбой пакета не
// роняет анализ и НЕ публикует ничего сам по себе: см. fail-closed в index.js.

const { chatJson, isConfigured, getModel } = require('../../stageAnalysis/llm/openaiClient');
const {
  EVIDENCE_STRENGTH,
  BUSINESS_CONSEQUENCE,
  ACTIONABILITY,
  NOVELTY,
  IMPACT_LEVELS,
  IMPACT_KEYS,
  normalizeAssessment,
} = require('./assessment');
const { OUTCOMES, contestedGaps } = require('./hardFilters');

const DEFAULT_BATCH = 8;

const SYSTEM_PROMPT = [
  'Ты — КРИТИК ТОЧНОСТИ замечаний по ТЗ на строительно-монтажные работы.',
  'Ты работаешь в тендерном отделе Генподрядчика (ГП) и проверяешь чужую работу:',
  'другой агент уже нашёл замечания, твоя задача — решить, какие из них инженер',
  'реально должен увидеть.',
  '',
  'ТВОЯ УСТАНОВКА: искать ОСНОВАНИЯ НЕ ПОКАЗЫВАТЬ замечание. Ты не ищешь новые',
  'проблемы и не улучшаешь формулировки. По умолчанию замечание НЕ показывается —',
  'публикация требует доказанного существенного последствия для ГП. Лишнее',
  'замечание в списке стоит инженеру времени и подрывает доверие ко всему отчёту,',
  'поэтому сомнение трактуется В ПОЛЬЗУ СКРЫТИЯ.',
  '',
  'ТИПИЧНЫЕ ОСНОВАНИЯ НЕ ПОКАЗЫВАТЬ (проверь каждое):',
  '• это редактура/оформление: опечатка, нумерация, стиль — деньги не двигаются;',
  '• проблема названа, но ПОСЛЕДСТВИЯ нет: ни объём, ни стоимость, ни срок, ни',
  '  договор, ни ответственность ГП не меняются;',
  '• это стандартное требование норм или обычной практики — ГП исполняет его и так;',
  '• это ПОВТОР: то же требование ТЗ уже вынесено другим замечанием;',
  '• это ПРЕДПОЛОЖЕНИЕ: вывод не следует из приведённой цитаты ТЗ, а достроен',
  '  догадкой («возможно потребуется…»);',
  '• с замечанием НЕЧЕГО ДЕЛАТЬ: нет ни правки ТЗ, ни выноса из объёма, ни',
  '  вопроса заказчику — только «принять к сведению»;',
  '• цитата не подтверждает вывод: в ней нет того, о чём говорит обоснование.',
  '',
  'ОСНОВАНИЯ ПОКАЗАТЬ (нужно И существенное последствие, И доказательства):',
  '• формулировка ТЗ возлагает на ГП работы, объёмы или обязанности сверх расчёта;',
  '• работа требуется ТЗ, но не покрыта расчётом/ведомостью;',
  '• условие меняет цену, порядок приёмки/оплаты, сроки, ответственность или',
  '  гарантию не в пользу ГП;',
  '• формулировка ТЗ противоречит другому пункту ТЗ или условиям компании.',
  '',
  'ОЦЕНИ КАЖДОЕ ЗАМЕЧАНИЕ ПО 9 ИЗМЕРЕНИЯМ:',
  '• evidence_strength — чем подтверждено: strong (цитата ТЗ прямо содержит',
  '  проблему), medium (следует из цитаты с толкованием), weak (косвенно/догадка),',
  '  none (подтверждения нет);',
  '• business_consequence — что ГП потеряет: critical (крупные деньги/срок/',
  '  договорная ответственность), high, medium, low, none;',
  '• actionability — actionable (есть конкретная правка ТЗ или вынос из объёма),',
  '  conditional (нужен ответ заказчика), none (делать нечего);',
  '• novelty — novel | partial_duplicate | duplicate;',
  '• scope_impact, cost_impact, schedule_impact, contract_impact,',
  '  responsibility_impact — по каждому каналу: high | medium | low | none.',
  '',
  'ИСХОД (outcome) — ровно одно значение:',
  '• publish_critical — существенное последствие + надёжные доказательства,',
  '  инженер должен увидеть в первую очередь;',
  '• publish_working — доказанное существенное последствие, рабочий список;',
  '• hide_informational — замечание верное, но инженеру в списке не нужно',
  '  (нет последствия / редактура / стандартное требование / нечего делать /',
  '  слабое предположение);',
  '• reject_invalid — замечание невалидно: повтор, цитата не подтверждает вывод,',
  '  указывать не на что.',
  '',
  'ЖЁСТКИЕ ПРАВИЛА:',
  '• Уверенность нашедшего агента тебе НЕ показывают, и она не является доводом',
  '  за публикацию. Опирайся только на цитату ТЗ, обоснование и последствие.',
  '• business_consequence=low или none → публиковать НЕЛЬЗЯ (hide_informational).',
  '• Нет доказательств (evidence_strength=none) → reject_invalid.',
  '• В reasons_against перечисли КОНКРЕТНЫЕ доводы против публикации (даже если',
  '  в итоге публикуешь) — по ним инженер поймёт, чего замечанию не хватает.',
  '• reason — одно предложение по-русски: почему именно такой исход.',
  '• Отвечай строго по схеме, только JSON. id возвращай без изменений.',
].join('\n');

// Схема ответа: по одному решению на каждое переданное замечание.
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'evidence_strength',
          'business_consequence',
          'actionability',
          'novelty',
          'scope_impact',
          'cost_impact',
          'schedule_impact',
          'contract_impact',
          'responsibility_impact',
          'outcome',
          'reasons_against',
          'reason',
        ],
        properties: {
          id: { type: 'string', description: 'id замечания из входа (скопируй дословно).' },
          evidence_strength: { type: 'string', enum: [...EVIDENCE_STRENGTH] },
          business_consequence: { type: 'string', enum: [...BUSINESS_CONSEQUENCE] },
          actionability: { type: 'string', enum: [...ACTIONABILITY] },
          novelty: { type: 'string', enum: [...NOVELTY] },
          scope_impact: { type: 'string', enum: [...IMPACT_LEVELS] },
          cost_impact: { type: 'string', enum: [...IMPACT_LEVELS] },
          schedule_impact: { type: 'string', enum: [...IMPACT_LEVELS] },
          contract_impact: { type: 'string', enum: [...IMPACT_LEVELS] },
          responsibility_impact: { type: 'string', enum: [...IMPACT_LEVELS] },
          outcome: { type: 'string', enum: [...OUTCOMES] },
          reasons_against: {
            type: 'array',
            items: { type: 'string' },
            description: 'Конкретные доводы ПРОТИВ публикации (может быть пустым, если их нет).',
          },
          reason: { type: 'string', description: 'Одно предложение: почему такой исход.' },
        },
      },
    },
  },
};

function trim(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Карточка одного спорного замечания для промта. confidence и criticality
// исходного агента НЕ передаются намеренно (см. шапку модуля).
function renderItem(item, index) {
  const { draft, assessment } = item;
  const lines = [
    `### Замечание ${index + 1}. id: ${draft.id}`,
    `Место в ТЗ: ${trim(draft.tz_clause, 200) || '—'}${draft.paragraph_index != null ? ` (абзац ${draft.paragraph_index + 1})` : ''}`,
    `Цитата ТЗ: ${trim(draft.source_fragment, 700) || '(цитаты нет)'}`,
  ];
  if (draft.context_text && draft.context_text !== draft.source_fragment) {
    lines.push(`Абзац целиком: ${trim(draft.context_text, 900)}`);
  }
  lines.push(
    `Тип проблемы: ${trim(draft.problem_type, 120) || '—'}`,
    `Обоснование агента: ${trim(draft.basis, 700) || '(обоснования нет)'}`,
  );
  if (draft.review_comment) lines.push(`Комментарий агента: ${trim(draft.review_comment, 500)}`);
  lines.push(`Предложенное действие: ${trim(draft.suggested_action, 60) || '—'}`);
  if (draft.suggested_redaction) {
    lines.push(`Предложенная правка: ${trim(draft.suggested_redaction, 500)}`);
  }
  lines.push(
    'Машинная оценка (детерминированная, для сверки — можешь не согласиться): '
      + `доказательства ${assessment.evidence_strength}, последствие ${assessment.business_consequence}, `
      + `действие ${assessment.actionability}, новизна ${assessment.novelty}; `
      + IMPACT_KEYS.map((k) => `${k}=${assessment[k]}`).join(', '),
    `Сработавшие критерии компании: ${(assessment.signals.criteria || []).join(', ') || 'нет'}`,
    `Почему замечание спорное: ${contestedGaps(assessment).join('; ')}.`,
    '',
  );
  return lines.join('\n');
}

function buildUserMessage(items) {
  return [
    `Проверь ${items.length} спорн${items.length === 1 ? 'ое замечание' : 'ых замечаний'}.`,
    'Для КАЖДОГО верни решение по схеме (поле decisions), id — как во входе.',
    '',
    ...items.map((item, i) => renderItem(item, i)),
  ].join('\n');
}

// Проверка одного пакета. Возвращает Map<id, решение> ТОЛЬКО для тех id, что
// пришли в ответе и были во входе (лишние id модели игнорируются, пропущенные
// остаются нерешёнными — их подберёт fail-closed в index.js).
// БРОСАЕТ при сбое вызова — обработка на уровне выше (пакет за пакетом).
async function reviewBatch(items, { model } = {}) {
  const json = await chatJson({
    system: SYSTEM_PROMPT,
    user: buildUserMessage(items),
    jsonSchema: RESPONSE_SCHEMA,
    schemaName: 'precision_critic_decisions',
    model,
    // Критик должен быть воспроизводимым: одно и то же замечание не может то
    // публиковаться, то скрываться от прогона к прогону.
    temperature: 0,
  });
  const allowed = new Set(items.map((it) => it.draft.id));
  const out = new Map();
  for (const raw of Array.isArray(json?.decisions) ? json.decisions : []) {
    const id = String(raw?.id || '');
    if (!allowed.has(id) || out.has(id)) continue;
    out.set(id, {
      assessment: normalizeAssessment(raw),
      outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : null,
      reasons_against: Array.isArray(raw.reasons_against)
        ? raw.reasons_against.map((r) => trim(r, 300)).filter(Boolean)
        : [],
      reason: trim(raw.reason, 400) || null,
    });
  }
  return out;
}

function resolveBatchSize() {
  const n = Number(process.env.PRECISION_CRITIC_BATCH);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_BATCH;
}

module.exports = {
  SYSTEM_PROMPT,
  RESPONSE_SCHEMA,
  DEFAULT_BATCH,
  isConfigured,
  getModel,
  buildUserMessage,
  renderItem,
  reviewBatch,
  resolveBatchSize,
};
