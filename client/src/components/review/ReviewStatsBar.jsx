// Верхняя панель проверки: общее количество, необработанные, принятые,
// отклонённые, критичные, предложенные gate к скрытию + прогресс проверки.
// Здесь же — переключатель «Только существенные» (снимается одним кликом).

function Chip({ label, value, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${className}`}>
      <span>{label}:</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

export default function ReviewStatsBar({ stats, essential, hiddenByEssential = 0, onToggleEssential }) {
  if (!stats) return null;
  return (
    <div className="card px-3 py-2 flex flex-wrap items-center gap-2">
      <Chip label="Всего" value={stats.total} className="bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300" />
      <Chip label="Необработанные" value={stats.undecided} className="bg-blue-50 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300" />
      <Chip label="Принято" value={stats.accepted} className="bg-green-50 dark:bg-green-900/40 text-green-800 dark:text-green-300" />
      <Chip label="Отклонено" value={stats.rejected} className="bg-red-50 dark:bg-red-900/40 text-red-800 dark:text-red-300" />
      <Chip label="Критичные" value={stats.critical} className="bg-orange-50 dark:bg-orange-900/40 text-orange-800 dark:text-orange-300" />
      <Chip
        label="Gate предлагает скрыть"
        value={stats.gate_hidden}
        className="bg-purple-50 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300"
      />

      {/* Прогресс проверки */}
      <div className="flex items-center gap-2 min-w-[130px] flex-1">
        <div className="h-1.5 flex-1 min-w-[60px] rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div className="h-full bg-brand-600" style={{ width: `${stats.progress_pct}%` }} />
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{stats.progress_pct}%</span>
      </div>

      <button
        type="button"
        className={`text-xs px-2 py-1 rounded border dark:border-gray-600 ${
          essential
            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 border-amber-300'
            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400'
        }`}
        title="Показывать только критичные, высокие и требующие проверки замечания. Остальные не удаляются — фильтр снимается этим же переключателем."
        onClick={onToggleEssential}
      >
        {essential ? `Только существенные — снять (скрыто ${hiddenByEssential})` : 'Только существенные'}
      </button>
    </div>
  );
}
