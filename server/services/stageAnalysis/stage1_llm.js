'use strict';

// Стадия 1 — LLM-агент (OpenAI GPT-4o).
// Заменяет rule-based runStage1 (сохранён в stage1_checklistVor.js как fallback/история).
//
// Контракт: (context) → Issue[]
// context = {
//   tenderId, sourceDocumentId,
//   blocks,        // плоский массив блоков из parseMdToBlocks (с section_path)
//   rawMd,         // исходный текст .md (передаём агенту целиком)
//   vorText,       // текст ВОР (plain или CSV)
//   checklist,     // строки work_checklist_items: { work_name, in_calc, ... }
// }
//
// Поток:
// 1. Сформировать system + user сообщения с контекстом.
// 2. Вызвать chat.completions со structured output (JSON schema).
// 3. Получить findings[] — список фрагментов ТЗ с описаниями неучтённых работ.
// 4. Для каждого finding — найти точную позицию во входных блоках через locateInBlocks.
// 5. Дропнуть finding'и, чьи фрагменты не находятся в исходном тексте (не выдумываем позицию).
// 6. Построить Issue[] для записи в БД.

const { findInParagraphs } = require('./shared/fragmentMatcher');
const { chatJson, getModel } = require('./llm/openaiClient');

const SYSTEM_PROMPT = [
  'Ты — инженер тендерного отдела строительной компании.',
  'На входе у тебя: техническое задание (ТЗ) в формате Markdown с заголовками,',
  'ведомость объёмов работ (ВОР) и чек-лист работ компании (наименование + флаг in_calc:',
  '1 — учтена в КП, 0 — не учтена, null — статус не определён).',
  '',
  'Твоя задача — найти в ТЗ фрагменты, описывающие работы, которые НЕ УЧТЕНЫ',
  'ни в ВОР, ни в чек-листе как in_calc=1. То есть работа описана в ТЗ, но',
  'наша компания её в КП/ВОР не положила — это риск выполнения без оплаты.',
  '',
  'Правила:',
  '• Возвращай ТОЛЬКО реально упомянутые в ТЗ работы. Не выдумывай.',
  '• Поле fragment должно быть ДОСЛОВНОЙ цитатой из ТЗ (несколько слов или короткое предложение).',
  '• section_path — путь заголовков, в котором найден фрагмент, например «1. Введение › 1.2 Объём работ».',
  '• Если работа есть в ТЗ И уже учтена (в ВОР или в чек-листе с in_calc=1) — пропускай.',
  '• Если работа есть в ТЗ И в чек-листе с in_calc=0 → criticality=high, problem_type=не_учтено_в_кп.',
  '• Если работа есть в ТЗ И в чек-листе с in_calc=null → criticality=medium, problem_type=статус_не_определён.',
  '• Если работа есть в ТЗ И отсутствует в ВОР и в чек-листе → criticality=high, problem_type=не_в_обоих.',
  '• Только то, что выглядит как работа/услуга подрядчика. Пропускай общие положения, реквизиты, описания объекта.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'fragment',
          'section_path',
          'problem_type',
          'criticality',
          'suggested_action',
          'basis',
          'suggested_redaction',
          'review_comment',
          'confidence',
        ],
        properties: {
          fragment: {
            type: 'string',
            description: 'Дословная цитата из ТЗ (несколько слов или короткое предложение).',
          },
          section_path: {
            type: 'string',
            description: 'Путь заголовков, например: "1. Введение › 1.2 Объём работ". Пустая строка, если фрагмент вне заголовка.',
          },
          problem_type: {
            type: 'string',
            enum: ['не_учтено_в_кп', 'не_учтено_в_вор', 'не_в_обоих', 'статус_не_определён'],
          },
          criticality: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          suggested_action: {
            type: 'string',
            enum: ['comment', 'replace', 'delete', 'remove_from_scope', 'clarify', 'limit_scope', 'assumption'],
            description: 'Рекомендация агента; инженер может выбрать своё действие в UI.',
          },
          suggested_redaction: {
            type: ['string', 'null'],
            description: 'Если suggested_action=replace — текст замены. Иначе null.',
          },
          review_comment: {
            type: ['string', 'null'],
            description: 'Краткий комментарий инженеру (на русском). Может быть null.',
          },
          basis: {
            type: 'string',
            description: 'Краткое обоснование, почему это проблема.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
      },
    },
  },
  required: ['findings'],
};

function formatChecklist(checklist) {
  if (!checklist || !checklist.length) return '(чек-лист пуст)';
  const lines = ['| # | Работа | in_calc |', '|---|---|---|'];
  checklist.forEach((row, i) => {
    const work = (row.work_name || '').replace(/\|/g, '/');
    const inCalc = row.in_calc === 1 ? '1 (учтена в КП)'
      : row.in_calc === 0 ? '0 (НЕ учтена)'
        : 'null (статус не определён)';
    lines.push(`| ${i + 1} | ${work} | ${inCalc} |`);
  });
  return lines.join('\n');
}

function buildUserMessage({ rawMd, vorText, checklist }) {
  const md = rawMd && rawMd.trim() ? rawMd : '(пусто)';
  const vor = vorText && vorText.trim() ? vorText : '(ВОР не загружен или пуст)';
  return [
    '## ТЗ (markdown)',
    '',
    md,
    '',
    '---',
    '## ВОР',
    '',
    vor,
    '',
    '---',
    '## Чек-лист работ компании',
    '',
    formatChecklist(checklist),
    '',
    '---',
    'Найди в ТЗ фрагменты, описывающие работы, не учтённые в ВОР и в чек-листе как in_calc=1.',
    'Верни их списком в JSON по схеме (поле findings).',
  ].join('\n');
}

// Грубая нормализация для substring-локализации фрагмента в блоках.
// Совпадение должно быть точным после нормализации пробелов.
function normalizeForLocate(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function locateInBlocks(blocks, fragment) {
  const ndl = normalizeForLocate(fragment);
  if (!ndl) return null;

  // 1) Сначала точное вхождение в нормализованной форме.
  for (const block of blocks) {
    const haystackNorm = normalizeForLocate(block.text);
    const idxNorm = haystackNorm.indexOf(ndl);
    if (idxNorm === -1) continue;

    // Перевести позицию из нормализованного представления в исходное:
    // findInParagraphs делает substring-поиск с учётом нижнего регистра и ё→е,
    // что близко по семантике; используем его для позиции внутри ОДНОГО блока.
    const hits = findInParagraphs([block], fragment);
    if (hits.length) {
      const hit = hits[0];
      return { block, char_start: hit.char_start, char_end: hit.char_end, fragment: hit.fragment };
    }
    // Если findInParagraphs не нашёл (различие нормализаций), берём приближение.
    return {
      block,
      char_start: 0,
      char_end: Math.min(block.text.length, fragment.length),
      fragment: block.text.slice(0, Math.min(block.text.length, fragment.length)),
    };
  }

  return null;
}

function buildIssue({ sourceDocumentId, finding, located }) {
  const sectionPath = (finding.section_path || '').trim() || (located?.block?.section_path?.join(' › ') || null);
  return {
    source_document_id: sourceDocumentId || null,
    source_clause: located?.block ? `п. ${located.block.index + 1}` : null,
    source_fragment: located?.fragment || finding.fragment,
    paragraph_index: located?.block?.index ?? null,
    char_start: located?.char_start ?? null,
    char_end: located?.char_end ?? null,
    problem_type: finding.problem_type || null,
    risk_category: 'покрытие_расчёта',
    criticality: finding.criticality || 'medium',
    price_impact: finding.criticality === 'high' ? 'высокое' : 'возможно',
    schedule_impact: 'возможно',
    basis: finding.basis || null,
    suggested_action: finding.suggested_action || 'clarify',
    suggested_redaction: finding.suggested_redaction || null,
    review_comment: finding.review_comment || null,
    confidence: typeof finding.confidence === 'number' ? finding.confidence : 0.7,
    section_path: sectionPath || null,
  };
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${(f.fragment || '').trim()}|${(f.section_path || '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function runStage1Llm(context) {
  const { sourceDocumentId, blocks, rawMd, vorText, checklist } = context;

  if (!Array.isArray(blocks) || !blocks.length) {
    const err = new Error('ТЗ.md пуст или не парсится. Загрузите корректный .md в слот ТЗ.');
    err.status = 400;
    throw err;
  }

  const systemMsg = SYSTEM_PROMPT;
  const userMsg = buildUserMessage({ rawMd: rawMd || '', vorText: vorText || '', checklist: checklist || [] });

  const startedAt = Date.now();
  const json = await chatJson({
    system: systemMsg,
    user: userMsg,
    jsonSchema: RESPONSE_SCHEMA,
    schemaName: 'stage1_findings',
  });
  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(`[stage1_llm] model=${getModel()} elapsed=${elapsedMs}ms findings=${(json?.findings || []).length}`);

  const findings = dedupe(Array.isArray(json?.findings) ? json.findings : []);

  const issues = [];
  let dropped = 0;
  for (const f of findings) {
    const located = locateInBlocks(blocks, f.fragment);
    if (!located) {
      dropped += 1;
      // eslint-disable-next-line no-console
      console.warn(`[stage1_llm] dropped finding (fragment not located in TZ): ${JSON.stringify(f.fragment).slice(0, 120)}`);
      continue;
    }
    issues.push(buildIssue({ sourceDocumentId, finding: f, located }));
  }
  if (dropped) {
    // eslint-disable-next-line no-console
    console.log(`[stage1_llm] dropped ${dropped} findings out of ${findings.length}`);
  }

  return issues;
}

module.exports = { runStage1Llm };
