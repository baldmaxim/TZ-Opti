'use strict';

function normalize(s) {
  return (s || '').toLowerCase().replace(/[ё]/g, 'е');
}

function findAllOccurrences(haystack, needle) {
  if (!haystack || !needle) return [];
  const hay = normalize(haystack);
  const ndl = normalize(needle);
  const out = [];
  let from = 0;
  while (from <= hay.length - ndl.length) {
    const idx = hay.indexOf(ndl, from);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + ndl.length });
    from = idx + ndl.length;
  }
  return out;
}

function findInParagraphs(paragraphs, needle) {
  const results = [];
  for (const p of paragraphs) {
    const hits = findAllOccurrences(p.text, needle);
    for (const h of hits) {
      results.push({
        paragraph_index: p.index,
        char_start: h.start,
        char_end: h.end,
        fragment: p.text.slice(h.start, h.end),
        full_paragraph: p.text,
      });
    }
  }
  return results;
}

function tokens(s) {
  return normalize(s)
    .replace(/[^a-zа-я0-9 ]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function jaccardOverlap(a, b) {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function containsAnyToken(haystack, words) {
  const h = normalize(haystack);
  return words.some((w) => h.includes(normalize(w)));
}

module.exports = {
  normalize,
  findAllOccurrences,
  findInParagraphs,
  tokens,
  jaccardOverlap,
  containsAnyToken,
};
