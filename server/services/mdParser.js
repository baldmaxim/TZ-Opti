'use strict';

// Парсер markdown → плоский массив блоков с иерархией заголовков.
// Используется для Стадии 1 (LLM-агент GPT-4o): агенту нужны блоки с
// section_path, чтобы он возвращал осмысленный «Раздел: 1.2 Объём работ».
//
// Зависимости (unified/remark-*) — ESM-only. Сервер на CommonJS, поэтому
// загружаем их через dynamic import() с кэшированием.

let _pipelineCache = null;

async function getPipeline() {
  if (_pipelineCache) return _pipelineCache;
  const [{ unified }, remarkParseMod, remarkGfmMod, { toString }] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('mdast-util-to-string'),
  ]);
  _pipelineCache = {
    unified,
    remarkParse: remarkParseMod.default,
    remarkGfm: remarkGfmMod.default,
    toString,
  };
  return _pipelineCache;
}

// Block = { index, type, level?, text, section_path: string[] }
async function parseMdToBlocks(mdText) {
  const text = (mdText || '').toString();
  if (!text.trim()) return [];

  const { unified, remarkParse, remarkGfm, toString } = await getPipeline();
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text);

  const blocks = [];
  const headingStack = []; // [{ level, text }] — путь к текущему месту в иерархии
  let index = 0;

  const currentSectionPath = () => headingStack.map((h) => h.text);

  const pushBlock = (type, text, extra = {}) => {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    blocks.push({
      index: index++,
      type,
      text: trimmed,
      section_path: currentSectionPath(),
      ...extra,
    });
  };

  const walkTopLevel = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'heading': {
        const txt = toString(node).trim();
        if (!txt) return;
        // Сначала формируем section_path (до push в стек) — заголовок сам в свой путь не входит.
        const sectionPath = currentSectionPath();
        // Затем поправляем стек.
        while (headingStack.length && headingStack[headingStack.length - 1].level >= node.depth) {
          headingStack.pop();
        }
        // Section_path берём «до push» — т.е. путь предков. Уже взяли.
        // А вот после pop'а стек уже соответствует level до текущего — заходим текущим.
        headingStack.push({ level: node.depth, text: txt });
        blocks.push({
          index: index++,
          type: 'heading',
          level: node.depth,
          text: txt,
          section_path: sectionPath,
        });
        return;
      }
      case 'paragraph': {
        pushBlock('paragraph', toString(node));
        return;
      }
      case 'list': {
        // Каждый элемент списка — отдельный блок list_item.
        for (const item of node.children || []) {
          pushBlock('list_item', toString(item));
        }
        return;
      }
      case 'table': {
        // Каждая строка таблицы — отдельный блок table_row, ячейки через ' | '.
        for (const row of node.children || []) {
          const cells = (row.children || []).map((c) => toString(c).trim());
          pushBlock('table_row', cells.join(' | '));
        }
        return;
      }
      case 'code': {
        pushBlock('code', node.value || '');
        return;
      }
      case 'blockquote': {
        // Цитаты складываем как обычные параграфы — для substring-поиска и LLM это эквивалентно.
        pushBlock('paragraph', toString(node));
        return;
      }
      case 'thematicBreak':
      case 'html':
      case 'definition':
      case 'yaml':
        return;
      default: {
        // Неизвестный узел — пробуем извлечь текст.
        const txt = toString(node).trim();
        if (txt) pushBlock(node.type || 'paragraph', txt);
      }
    }
  };

  for (const node of tree.children || []) {
    walkTopLevel(node);
  }

  return blocks;
}

// Для отладки/тестов: рендерит блоки обратно в плоский текст со склейкой по \n.
// Не используется в продакшен-флоу, но полезно для diff-проверки.
function blocksToFlatText(blocks) {
  return blocks.map((b) => b.text).join('\n');
}

module.exports = {
  parseMdToBlocks,
  blocksToFlatText,
};
