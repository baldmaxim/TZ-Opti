'use strict';

const db = require('../db/connection');
const { tokens } = require('./stageAnalysis/shared/fragmentMatcher');
const { getActiveTzText } = require('./tzActiveTextService');

// Сшивка фрагментов в логические параграфы.
// PDF-экстракция режет строки по визуальным линиям, поэтому одно предложение
// часто разбито на 3–5 строк. Эта функция собирает их обратно, используя
// иерархические шифры (3.1.1.3, 4.2 и т.п.) как естественную границу.
const CLAUSE_RE = /^(\d{1,3}(?:\.\d{1,3}){1,5})[\.\s]/;

function reconstituteParagraphs(rawText) {
  const lines = (rawText || '').split(/\r?\n/);
  const out = [];
  let curText = '';
  let curStart = -1;
  let curClause = null;
  const flush = () => {
    if (curText.trim()) out.push({ index: curStart, text: curText.replace(/\s+/g, ' ').trim(), clause: curClause });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      // Пустая строка — мягкая граница: завершаем только если параграф уже накоплен.
      if (curText.trim().length >= 40) {
        flush();
        curText = ''; curStart = -1; curClause = null;
      }
      continue;
    }
    const m = trimmed.match(CLAUSE_RE);
    if (m) {
      flush();
      curText = trimmed;
      curStart = i;
      curClause = m[1];
      continue;
    }
    if (curStart === -1) {
      curText = trimmed;
      curStart = i;
    } else {
      curText += ' ' + trimmed;
    }
  }
  flush();
  return out;
}

const STOPWORDS = new Set([
  'просим', 'уточнить', 'подтвердить', 'предоставить', 'направить', 'указать', 'сообщить',
  'входит', 'состав', 'работ', 'если', 'когда', 'можно', 'является', 'зоне', 'ответственности',
  'данный', 'данная', 'этой', 'этом', 'рамках', 'соответствии', 'случае', 'между', 'через',
  'пожалуйста', 'каков', 'каких', 'какие', 'какой', 'необходим', 'следует',
  'просьба', 'для', 'при', 'что', 'либо', 'чтобы', 'каком', 'какая',
  'то', 'не', 'или', 'и', 'но', 'на', 'из', 'по', 'до', 'от', 'до',
  'там', 'тот', 'этот', 'это', 'все', 'весь', 'свой', 'свою', 'свои',
  'учтено', 'учтена', 'учтены', 'принято', 'сведению',
  'дгп', 'тз', 'кп', 'гп',
]);

function meaningfulTokens(s) {
  return tokens(s).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function extractClauseFromParagraph(text) {
  if (!text) return null;
  const m = text.match(CLAUSE_RE);
  return m ? m[1] : null;
}

function scoreParagraph(entryTokens, sectionTokens, paraTokenSet) {
  if (!paraTokenSet.size) return 0;
  let inter = 0;
  for (const t of entryTokens) if (paraTokenSet.has(t)) inter += 1;
  if (!inter) return 0;
  const baseScore = inter / Math.max(entryTokens.size, 1);
  let sectionBonus = 0;
  for (const t of sectionTokens) if (paraTokenSet.has(t)) sectionBonus += 0.2;
  return baseScore + sectionBonus;
}

function linkOne(entry, paragraphs, options = {}) {
  const threshold = options.threshold ?? 0.08;
  const idfMap = options.idfMap || null; // штраф за «магнит-абзацы»
  const queryText = `${entry.section || ''} ${entry.question || ''} ${entry.accepted_decision || ''}`;
  const entryTokens = new Set(meaningfulTokens(queryText));
  const sectionTokens = new Set(meaningfulTokens(entry.section || ''));
  if (!entryTokens.size) return null;

  let best = null;
  for (const p of paragraphs) {
    if (!p.text || p.text.length < 30) continue;
    const paraTokenSet = p.tokenSet || new Set(meaningfulTokens(p.text));
    let score = scoreParagraph(entryTokens, sectionTokens, paraTokenSet);
    if (idfMap && idfMap.has(p.index)) score *= idfMap.get(p.index);
    if (!best || score > best.score) best = { paragraph: p, score };
  }
  if (!best || best.score < threshold) return null;

  const clauseNum = best.paragraph.clause || extractClauseFromParagraph(best.paragraph.text);
  const ref = clauseNum ? `п. ${clauseNum}` : `абз. ${best.paragraph.index + 1}`;

  return {
    paragraph_index: best.paragraph.index,
    score: Math.round(best.score * 100) / 100,
    clause: ref,
    snippet: best.paragraph.text.slice(0, 160).trim(),
  };
}

function buildIdfMap(entries, paragraphs) {
  // Первый проход без IDF — считаем, сколько уникальных вопросов цепляются за каждый параграф.
  // Параграфы, ловящие >K вопросов, штрафуем (вероятно, заголовки разделов или TOC-строки).
  const counts = new Map();
  for (const e of entries) {
    const r = linkOne(e, paragraphs);
    if (r) counts.set(r.paragraph_index, (counts.get(r.paragraph_index) || 0) + 1);
  }
  const idf = new Map();
  for (const [idx, n] of counts.entries()) {
    if (n <= 3) continue; // 1–3 попаданий норм
    // n=4 → 0.75x, n=8 → 0.5x, n=20 → 0.25x
    idf.set(idx, Math.max(0.2, 3 / n));
  }
  return idf;
}

async function autoLinkAll(tenderId, options = {}) {
  const overwrite = !!options.overwrite;
  const tz = await getActiveTzText(tenderId, 99);
  if (!tz.document) return { linked: 0, total: 0, skipped: 0, reason: 'no_tz' };

  // Сшивка параграфов из сырого текста ТЗ — компенсирует фрагментацию PDF.
  const reconstituted = reconstituteParagraphs(tz.rawText || '');
  const paragraphs = reconstituted.length ? reconstituted : (tz.paragraphs || []);
  if (!paragraphs.length) return { linked: 0, total: 0, skipped: 0, reason: 'no_tz' };

  // Предвычислим токен-сеты, чтобы не пересчитывать на каждом запросе.
  for (const p of paragraphs) {
    p.tokenSet = new Set(meaningfulTokens(p.text));
  }

  const where = overwrite
    ? 'WHERE tender_id = ?'
    : "WHERE tender_id = ? AND (tz_clause IS NULL OR TRIM(tz_clause) = '')";
  const entries = await db.queryAll(`SELECT * FROM qa_entries ${where}`, tenderId);

  // IDF-штраф для абзацев-«магнитов».
  const idfMap = buildIdfMap(entries, paragraphs);

  let linked = 0;
  let withClauseRef = 0;
  const samples = [];
  await db.transaction(async (tx) => {
    for (const e of entries) {
      const r = linkOne(e, paragraphs, { idfMap });
      if (r) {
        await tx.queryRun('UPDATE qa_entries SET tz_clause = ? WHERE id = ?', r.clause, e.id);
        linked += 1;
        if (r.clause.startsWith('п. ')) withClauseRef += 1;
        if (samples.length < 5) {
          samples.push({ section: e.section, question: e.question?.slice(0, 60), clause: r.clause, score: r.score });
        }
      }
    }
  });

  return {
    linked,
    total: entries.length,
    skipped: entries.length - linked,
    with_clause_ref: withClauseRef,
    paragraphs_total: paragraphs.length,
    samples,
  };
}

module.exports = { autoLinkAll, linkOne, reconstituteParagraphs };
