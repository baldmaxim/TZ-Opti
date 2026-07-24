'use strict';

// Иерархическая token-aware сегментация ТЗ для LLM-стадий.
//
// Прежняя схема (жадная упаковка блоков под ЧАР-бюджет) для больших ТЗ давала
// один гигантский сегмент: модель получала 400К символов «плоским» текстом,
// теряла середину, а блок крупнее бюджета вообще не дробился. Здесь три уровня:
//
//   1) БЛОК крупнее бюджета дробится по границам предложений с перекрытием
//      (part.index/part.total, paragraph_index сохраняется — локализация цитаты
//      по исходному блоку продолжает работать);
//   2) блоки собираются в ПУНКТЫ (unit): заголовок — свой unit и граница;
//      нумерованный пункт («3.4.1 …», «а)», «-») начинает новый unit; списки и
//      строки таблиц прилипают к текущему (таблица не рвётся построчно);
//   3) пункты пакуются в СЕГМЕНТЫ под ТОКЕННЫЙ бюджет с предпочтением границ
//      разделов, с ПЕРЕКРЫТИЕМ хвоста предыдущего сегмента и с сохранением
//      ЗАГОЛОВОЧНОГО КОНТЕКСТА (путь разделов печатается в шапке сегмента).
//
// Всё чистое и офлайн-тестируемое (server/test/unit/segmentation.test.js).

const crypto = require('crypto');

// ── Оценка токенов ───────────────────────────────────────────────────────────
// Точный токенайзер модели недоступен (и он разный у разных провайдеров), но
// нам нужна лишь верхняя оценка. Кириллица в BPE дороже латиницы — считаем по
// классам символов, это сильно точнее, чем «делить длину на 4».
const CYR_CHARS_PER_TOKEN = 2.6;
const LAT_CHARS_PER_TOKEN = 4.0;
const OTHER_CHARS_PER_TOKEN = 3.0;
// Средневзвешенное для обратного перевода токенов в символы (русский текст).
const AVG_CHARS_PER_TOKEN = 2.9;

function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  let cyr = 0;
  let lat = 0;
  let other = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if ((c >= 0x0410 && c <= 0x044f) || c === 0x0401 || c === 0x0451) cyr += 1;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat += 1;
    else other += 1;
  }
  return Math.ceil(
    cyr / CYR_CHARS_PER_TOKEN + lat / LAT_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN,
  );
}

const tokensToChars = (t) => Math.max(0, Math.round(Number(t || 0) * AVG_CHARS_PER_TOKEN));
const charsToTokens = (c) => Math.max(0, Math.ceil(Number(c || 0) / AVG_CHARS_PER_TOKEN));

// ── Параметры сегментации ────────────────────────────────────────────────────
// budgetTokens — потолок ОДНОГО сегмента. Даже если стадия отдала громадный
// символьный бюджет (STAGE_LLM_CHAR_BUDGET=400000), сегмент не растёт выше него:
// «влезает в контекст» и «модель это реально проанализирует» — разные величины.
const DEFAULT_BUDGET_TOKENS = Number(process.env.STAGE_SEGMENT_TOKENS) || 20000;
const DEFAULT_SECTION_BREAK_LEVEL = Number(process.env.STAGE_SEGMENT_SECTION_LEVEL) || 2;
const DEFAULTS = Object.freeze({
  budgetTokens: DEFAULT_BUDGET_TOKENS,
  overlapRatio: 0.08,        // перекрытие ≈ 8% бюджета
  minOverlapTokens: 150,
  maxOverlapTokens: 2000,
  maxOverlapUnits: 6,
  minFillRatio: 0.55,        // рвать по разделу, только если сегмент уже заполнен
  maxUnitRatio: 0.5,         // unit крупнее половины бюджета дальше не склеиваем
  sectionBreakLevel: DEFAULT_SECTION_BREAK_LEVEL,
  perBlockOverheadTokens: 3, // переводы строк + разметка заголовка
});

function resolveOptions(opts = {}) {
  const merged = { ...DEFAULTS, ...opts };
  const budgetTokens = Math.max(500, Math.floor(merged.budgetTokens));
  let overlapTokens;
  if (opts.overlapTokens != null) {
    overlapTokens = Math.max(0, Math.floor(opts.overlapTokens));
  } else {
    overlapTokens = Math.max(
      Math.round(budgetTokens * merged.overlapRatio),
      Math.min(merged.minOverlapTokens, Math.floor(budgetTokens / 10)),
    );
  }
  overlapTokens = Math.min(overlapTokens, merged.maxOverlapTokens, Math.floor(budgetTokens / 3));
  return { ...merged, budgetTokens, overlapTokens };
}

// ── Распознавание пунктов ────────────────────────────────────────────────────
const NUMBERED_CLAUSE = /^\s{0,3}\d{1,3}(?:\.\d{1,3}){0,4}[.)]?\s+\S/;
const LETTERED_CLAUSE = /^\s{0,3}[а-яёa-z][).]\s+\S/i;
const BULLET_CLAUSE = /^\s{0,3}[-–—•*·]\s+\S/;
// Строки таблиц и элементы списков не начинают новый пункт: таблица должна
// оставаться единым куском, а список — прилипать к своему вводному абзацу.
const STICKY_TYPES = new Set(['table_row', 'list_item', 'code']);

function isClauseStart(block) {
  if (!block || block.type === 'heading') return false;
  if (STICKY_TYPES.has(block.type)) return false;
  const t = block.text || '';
  return NUMBERED_CLAUSE.test(t) || LETTERED_CLAUSE.test(t) || BULLET_CLAUSE.test(t);
}

function blockTokens(block, overhead = DEFAULTS.perBlockOverheadTokens) {
  return estimateTokens(block && block.text) + overhead;
}

// ── (1) Дробление слишком большого блока ─────────────────────────────────────
const SENTENCE_END = /[.;!?…]["»)]?\s/g;

// Ищем «мягкую» границу (конец предложения, затем пробел) в хвосте окна.
function softBreakAt(text, from, to) {
  const windowStart = Math.max(from + 1, to - Math.max(200, Math.floor((to - from) / 5)));
  const slice = text.slice(windowStart, to);
  let best = -1;
  SENTENCE_END.lastIndex = 0;
  let m = SENTENCE_END.exec(slice);
  while (m) {
    best = windowStart + m.index + m[0].length;
    m = SENTENCE_END.exec(slice);
  }
  if (best > from) return best;
  const space = text.lastIndexOf(' ', to);
  if (space > windowStart) return space + 1;
  return to;
}

// Начало следующего куска выравниваем по границе слова (вперёд), чтобы не
// разрезать слово пополам. Поиск ОГРАНИЧЕН окном: в тексте без пробелов
// (сплошная строка, длинный код/таблица без разделителей) безоглядный проход
// уехал бы в конец блока и молча съел весь остаток.
const ALIGN_SCAN = 200;
function alignForward(text, i, maxScan = ALIGN_SCAN) {
  const from = Math.max(0, Math.min(i, text.length));
  const limit = Math.min(text.length, from + maxScan);
  let j = from;
  while (j < limit && !/\s/.test(text[j])) j += 1;
  if (j >= limit) return from; // границы слова рядом нет — режем как есть
  while (j < text.length && /\s/.test(text[j])) j += 1;
  return j;
}

// Блок крупнее бюджета → части с перекрытием. paragraph_index (block.index) у
// всех частей ОДИН И ТОТ ЖЕ: цитата из части — подстрока исходного абзаца,
// поэтому locateInBlocks находит её в оригинальных блоках как раньше.
function splitOversizedBlock(block, opts = {}) {
  const { budgetTokens, overlapTokens } = resolveOptions(opts);
  const text = block.text || '';
  // Плотность считаем по САМОМУ блоку (таблица цифр и русский абзац дают разное
  // число символов на токен) — иначе часть промахивается мимо бюджета.
  const ratio = text.length / Math.max(1, estimateTokens(text));
  const maxChars = Math.max(400, Math.floor((budgetTokens - 50) * ratio));
  if (text.length <= maxChars) return [block];
  const overlapChars = Math.min(tokensToChars(overlapTokens), Math.floor(maxChars / 4));

  const ranges = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) end = softBreakAt(text, start, end);
    if (end <= start) end = Math.min(text.length, start + maxChars); // страховка от зацикливания
    ranges.push([start, end]);
    if (end >= text.length) break;
    // Начало следующей части — назад на величину перекрытия, но строго вперёд
    // относительно предыдущего начала и не дальше конца текущей части
    // (иначе кусок текста остался бы непокрытым).
    const next = Math.min(alignForward(text, Math.max(start + 1, end - overlapChars)), end);
    start = next > start ? next : end;
  }

  return ranges.map(([s, e], i) => ({
    ...block,
    text: text.slice(s, e),
    part: { index: i, total: ranges.length, char_offset: s },
  }));
}

function expandOversizedBlocks(blocks, opts) {
  const out = [];
  let split = 0;
  // Место под перекрытие резервируем и здесь: часть разбитого блока не должна
  // одна занимать весь сегмент, иначе хвост предыдущей части в него не влезет.
  const partOpts = { ...opts, budgetTokens: Math.max(500, opts.budgetTokens - opts.overlapTokens) };
  const maxTokens = partOpts.budgetTokens - opts.perBlockOverheadTokens;
  for (const b of blocks) {
    if (blockTokens(b, opts.perBlockOverheadTokens) <= maxTokens) {
      out.push(b);
      continue;
    }
    const parts = splitOversizedBlock(b, partOpts);
    if (parts.length > 1) split += 1;
    out.push(...parts);
  }
  return { blocks: out, splitBlocks: split };
}

// ── (2) Блоки → пункты (units) ───────────────────────────────────────────────
// unit = { kind: 'heading'|'clause', level, headingPath, blocks[], tokens }
function headingPathOf(block) {
  const path = Array.isArray(block && block.section_path) ? block.section_path : [];
  if (block && block.type === 'heading') return [...path, block.text];
  return [...path];
}

function buildUnits(blocks, opts) {
  const maxUnitTokens = Math.max(1, Math.floor(opts.budgetTokens * opts.maxUnitRatio));
  const units = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.blocks.length) units.push(cur);
    cur = null;
  };
  const open = (block, kind) => {
    cur = {
      kind,
      level: block.level || null,
      headingPath: headingPathOf(block),
      blocks: [block],
      tokens: blockTokens(block, opts.perBlockOverheadTokens),
    };
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      flush();
      open(b, 'heading');
      flush();
      continue;
    }
    const t = blockTokens(b, opts.perBlockOverheadTokens);
    if (!cur || isClauseStart(b) || cur.tokens + t > maxUnitTokens) {
      flush();
      open(b, 'clause');
      continue;
    }
    cur.blocks.push(b);
    cur.tokens += t;
  }
  flush();
  return units;
}

// ── (3) Пункты → сегменты ────────────────────────────────────────────────────
function packUnits(units, opts) {
  // Бюджет содержимого = полный бюджет минус место под перекрытие.
  const contentBudget = Math.max(1, opts.budgetTokens - opts.overlapTokens);
  const packed = [];
  let cur = [];
  let curTokens = 0;

  const push = () => {
    if (cur.length) packed.push(cur);
    cur = [];
    curTokens = 0;
  };

  for (const u of units) {
    const startsSection = u.kind === 'heading' && (u.level || 99) <= opts.sectionBreakLevel;
    const overflow = curTokens + u.tokens > contentBudget;
    const sectionBreak = startsSection && curTokens >= contentBudget * opts.minFillRatio;
    if (cur.length && (overflow || sectionBreak)) push();
    cur.push(u);
    curTokens += u.tokens;
  }
  push();

  // Заголовок не должен «висеть» в конце сегмента без своего содержания —
  // переносим такие хвосты в начало следующего сегмента (сегмент из одних
  // заголовков при этом просто исчезает: посылать в LLM оглавление без текста
  // бессмысленно, а заголовки стоят единицы токенов).
  for (let i = packed.length - 2; i >= 0; i -= 1) {
    while (packed[i].length && packed[i][packed[i].length - 1].kind === 'heading') {
      packed[i + 1].unshift(packed[i].pop());
    }
  }
  return packed.filter((seg) => seg.length);
}

// Хвост предыдущего сегмента для перекрытия. Если последний пункт сам крупнее
// перекрытия (длинный абзац на границе), берём его ХВОСТОВОЙ срез — иначе
// требование, разорванное границей, не попадёт целиком ни в один сегмент.
function takeOverlap(prevUnits, opts) {
  if (!prevUnits || !prevUnits.length || opts.overlapTokens <= 0) return [];
  const picked = [];
  let tokens = 0;
  for (let i = prevUnits.length - 1; i >= 0; i -= 1) {
    const u = prevUnits[i];
    if (picked.length >= opts.maxOverlapUnits) break;
    if (tokens + u.tokens > opts.overlapTokens) break;
    picked.unshift(u);
    tokens += u.tokens;
  }
  if (picked.length) return picked.map((u) => ({ ...u, overlap: true }));

  const last = prevUnits[prevUnits.length - 1];
  const lastBlock = last.blocks[last.blocks.length - 1];
  const text = lastBlock.text || '';
  const tailChars = Math.min(text.length, tokensToChars(opts.overlapTokens));
  const from = alignForward(text, Math.max(0, text.length - tailChars));
  const tail = text.slice(from);
  if (!tail.trim()) return [];
  const tailBlock = {
    ...lastBlock,
    text: tail,
    part: {
      index: (lastBlock.part && lastBlock.part.index) || 0,
      total: (lastBlock.part && lastBlock.part.total) || 1,
      char_offset: ((lastBlock.part && lastBlock.part.char_offset) || 0) + from,
      tail: true,
    },
  };
  return [{
    kind: 'clause',
    level: null,
    headingPath: last.headingPath,
    blocks: [tailBlock],
    tokens: estimateTokens(tail),
    overlap: true,
  }];
}

function segmentKeyFor(headingPath, contentBlocks) {
  const basis = [
    headingPath.join(' › '),
    contentBlocks.map((b) => `${b.index}:${(b.part && b.part.char_offset) || 0}`).join(','),
    contentBlocks.map((b) => b.text).join('\n'),
  ].join('::');
  return `seg_${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

function makeSegment(units, overlapUnits, index, opts) {
  const contentBlocks = units.flatMap((u) => u.blocks);
  const overlapBlocks = overlapUnits.flatMap((u) => u.blocks);
  const firstContent = contentBlocks[0] || null;
  const headingPath = firstContent ? headingPathOf(firstContent) : [];
  const chars = contentBlocks.reduce((n, b) => n + (b.text || '').length, 0);
  const tokens =
    units.reduce((n, u) => n + u.tokens, 0) + overlapUnits.reduce((n, u) => n + u.tokens, 0);
  const indexes = contentBlocks.map((b) => b.index).filter((i) => Number.isFinite(i));
  return {
    index,
    key: segmentKeyFor(headingPath, contentBlocks),
    headingPath,
    blocks: [...overlapBlocks, ...contentBlocks],
    contentBlocks,
    overlapBlocks,
    unitCount: units.length,
    tokens,
    chars,
    firstBlockIndex: indexes.length ? Math.min(...indexes) : null,
    lastBlockIndex: indexes.length ? Math.max(...indexes) : null,
    hasSplitBlocks: contentBlocks.some((b) => b.part && b.part.total > 1),
    budgetTokens: opts.budgetTokens,
  };
}

// Главная функция: блоки ТЗ → сегменты под токенный бюджет.
function segmentDocument(blocks, options = {}) {
  const opts = resolveOptions(options);
  const src = Array.isArray(blocks) ? blocks.filter((b) => b && (b.text || '').trim()) : [];
  if (!src.length) {
    return { segments: [], stats: { blocks: 0, units: 0, segments: 0, splitBlocks: 0, ...opts } };
  }

  const { blocks: expanded, splitBlocks } = expandOversizedBlocks(src, opts);
  const units = buildUnits(expanded, opts);
  const packed = packUnits(units, opts);

  const segments = packed.map((unitsOfSeg, i) =>
    makeSegment(unitsOfSeg, i > 0 ? takeOverlap(packed[i - 1], opts) : [], i, opts));

  return {
    segments,
    stats: {
      blocks: src.length,
      expandedBlocks: expanded.length,
      splitBlocks,
      units: units.length,
      segments: segments.length,
      budgetTokens: opts.budgetTokens,
      overlapTokens: opts.overlapTokens,
      totalTokens: units.reduce((n, u) => n + u.tokens, 0),
      maxSegmentTokens: segments.reduce((m, s) => Math.max(m, s.tokens), 0),
    },
  };
}

// ── Рендер сегмента для промта ───────────────────────────────────────────────
// Заголовки — markdown (#), прочее — дословный block.text (цитата модели должна
// совпасть дословно, иначе locateInBlocks её не найдёт). Служебные пояснения
// идут цитатой (>), чтобы модель не путала их с текстом ТЗ.
function renderBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'heading') {
      parts.push(`${'#'.repeat(Math.max(1, b.level || 1))} ${b.text}`);
      continue;
    }
    if (b.part && b.part.total > 1 && b.part.index > 0 && !b.part.tail) {
      parts.push(`> ⟨продолжение пункта, часть ${b.part.index + 1}/${b.part.total}⟩`);
    }
    parts.push(b.text);
  }
  return parts.join('\n');
}

function renderSegmentText(segment, opts = {}) {
  if (Array.isArray(segment)) return renderBlocks(segment);
  const total = opts.total || null;
  const head = [];
  if (segment.headingPath && segment.headingPath.length) {
    head.push(`> Контекст раздела: ${segment.headingPath.join(' › ')}`);
  }
  if (total && total > 1) {
    head.push(
      `> Это часть ${segment.index + 1}/${total} ТЗ. Анализируй только приведённый ниже текст; ` +
        'остальные части обрабатываются отдельно.',
    );
  }
  const body = [];
  if (segment.overlapBlocks && segment.overlapBlocks.length) {
    body.push('> ⟨повтор конца предыдущей части — чтобы пункт на границе читался целиком⟩');
    body.push(renderBlocks(segment.overlapBlocks));
    body.push('> ⟨конец повтора; далее — основной текст этой части⟩');
  }
  body.push(renderBlocks(segment.contentBlocks || segment.blocks || []));
  return [...head, '', ...body].join('\n');
}

// Компактный план разделов документа — вход финальной межраздельной сверки.
function outlineOf(segments) {
  return segments.map((s) => ({
    part: s.index + 1,
    section: (s.headingPath || []).join(' › ') || '—',
    blocks: `${s.firstBlockIndex}..${s.lastBlockIndex}`,
    tokens: s.tokens,
  }));
}

module.exports = {
  DEFAULTS,
  estimateTokens,
  tokensToChars,
  charsToTokens,
  isClauseStart,
  blockTokens,
  splitOversizedBlock,
  buildUnits,
  packUnits,
  takeOverlap,
  segmentDocument,
  renderBlocks,
  renderSegmentText,
  outlineOf,
  resolveOptions,
};
