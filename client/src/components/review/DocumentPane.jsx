// Левая панель рецензии: исходный текст ТЗ (.md) с подсветкой цитаты выбранного
// замечания. При выборе замечания документ автоматически прокручивается к
// цитате; сверху — заголовок раздела, в котором она находится. Если цитату
// найти не удалось — явное предупреждение (документ мог быть заменён).

import { useEffect, useMemo, useRef } from 'react';
import { splitDocBlocks, sectionTitleFor } from '../../utils/reviewBoard';

// Один блок (строка Markdown). Если в блок попадает подсвечиваемый диапазон —
// режем текст на до/подсветка/после.
function BlockView({ block, highlight, markRef }) {
  const base = block.heading
    ? `font-semibold ${block.level <= 2 ? 'text-sm' : 'text-xs'} text-gray-900 dark:text-gray-100 mt-3`
    : 'text-xs text-gray-700 dark:text-gray-300';
  const overlaps = highlight && highlight.end > block.start && highlight.start < block.end;
  if (!overlaps) {
    return <p className={`${base} whitespace-pre-wrap`}>{block.text}</p>;
  }
  const s = Math.max(0, highlight.start - block.start);
  const e = Math.min(block.text.length, highlight.end - block.start);
  return (
    <p className={`${base} whitespace-pre-wrap`}>
      {block.text.slice(0, s)}
      <mark
        ref={markRef}
        className={`bg-yellow-200 dark:bg-yellow-700/70 text-inherit rounded px-0.5 ${
          highlight.exact ? '' : 'underline decoration-dashed decoration-yellow-600'
        }`}
      >
        {block.text.slice(s, e)}
      </mark>
      {block.text.slice(e)}
    </p>
  );
}

export default function DocumentPane({ text, status, highlight, hasQuote, quoteFound }) {
  const blocks = useMemo(() => splitDocBlocks(text), [text]);
  const markRef = useRef(null);
  const section = highlight ? sectionTitleFor(blocks, highlight.start) : null;

  // Автопрокрутка к цитате при смене выбранного замечания.
  useEffect(() => {
    if (highlight && markRef.current) {
      markRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlight && highlight.start, highlight && highlight.end]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card p-0 flex flex-col overflow-hidden h-full min-h-0">
      <div className="px-3 py-2 border-b dark:border-gray-700 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Текст ТЗ</span>
          {section && (
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate" title={section}>
              Раздел: {section}
            </span>
          )}
        </div>
        {hasQuote && !quoteFound && status === 'ready' && (
          <div className="mt-1 text-xs px-2 py-1 rounded bg-red-50 dark:bg-red-900/40 text-red-800 dark:text-red-300">
            Цитата не найдена в тексте ТЗ — документ мог быть изменён или заменён.
            Проверьте замечание по цитате в карточке справа.
          </div>
        )}
        {highlight && !highlight.exact && (
          <div className="mt-1 text-xs px-2 py-1 rounded bg-amber-50 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
            Точное вхождение не найдено — подсвечено ближайшее совпадение по началу цитаты.
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1">
        {status === 'loading' && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">Загрузка текста ТЗ…</div>
        )}
        {status === 'missing' && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
            .md-документ ТЗ не загружен — панель текста недоступна.
            Загрузите ТЗ в формате Markdown на странице «Документы».
          </div>
        )}
        {status === 'ready' &&
          blocks.map((b) => (
            <BlockView key={b.start} block={b} highlight={highlight} markRef={markRef} />
          ))}
      </div>
    </div>
  );
}
