// Плашка «смотрим ПРОГОН-КАНДИДАТ, а не действующий снимок».
//
// Одиночные build* слоёв — отладочные: они пишут в новый прогон-кандидат и НЕ
// переводят указатель, поэтому действующий итог (и решения инженера) не меняются.
// Чтобы результат такой сборки было видно, страница читает именно этот прогон —
// и обязана честно об этом сказать.
export default function CandidateRunBanner({ runId, onClear }) {
  if (!runId) return null;
  return (
    <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-sm flex items-center justify-between gap-3">
      <span className="text-amber-900 dark:text-amber-200">
        Показан прогон-кандидат <span className="font-mono text-xs">{runId}</span> — он НЕ активен:
        действующий снимок и решения инженера не изменены.
      </span>
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 text-xs px-2 py-1 rounded border border-amber-400 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50"
      >
        Показать актуальный снимок
      </button>
    </div>
  );
}
