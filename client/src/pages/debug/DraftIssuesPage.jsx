import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

// Debug-вкладка единого анализатора ТЗ (draft_issues поверх signals).
// Не входит в основной wizard-сайдбар — /tenders/:id/debug/draft-issues.

const CAT_CLASS = {
  coverage: 'bg-blue-100 text-blue-800',
  decision: 'bg-violet-100 text-violet-800',
  condition: 'bg-emerald-100 text-emerald-800',
  risk: 'bg-red-100 text-red-800',
};

function catClass(cat) {
  return CAT_CLASS[cat] || 'bg-amber-100 text-amber-800'; // сводные типы (a+b) — янтарный
}

export default function DraftIssuesPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const [items, setItems] = useState([]);
  const [byCategory, setByCategory] = useState({});
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const res = await api.listDraftIssues(tenderId);
      setItems(res.items || []);
      setByCategory(res.by_category || {});
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const build = async () => {
    if (!tenderId) return;
    setBuilding(true);
    try {
      const res = await api.buildDraftIssues(tenderId);
      toastSuccess(`Собрано draft issues: ${res.summary?.draft_issues ?? 0} (из ${res.summary?.signals ?? 0} сигналов)`);
      await load();
    } catch (err) { toastError(err.message); }
    setBuilding(false);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Единый анализатор — draft issues (debug)</h1>
        <div className="flex gap-2">
          <button onClick={load} className="text-sm px-3 py-1 rounded border hover:bg-gray-50">
            Обновить
          </button>
          <button
            onClick={build}
            disabled={building}
            className="text-sm px-3 py-1 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {building ? 'Сборка…' : 'Собрать draft issues'}
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-500">
        Единый анализатор сводит совокупность signals (стадии 1–4) одного места ТЗ в один
        draft_issue. Параллельный слой — не влияет на рецензию и экспорт.
      </p>

      <div className="text-sm text-gray-600">
        Всего: {items.length}
        {Object.keys(byCategory).length > 0 && (
          <span className="ml-2 text-gray-400">
            ({Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')})
          </span>
        )}
      </div>

      {loading && <div className="text-gray-500">Загрузка…</div>}

      {!loading && !items.length && (
        <div className="text-gray-500">
          Draft issues нет. Запустите стадии 1–4 (чтобы появились signals), затем нажмите «Собрать draft issues».
        </div>
      )}

      <div className="space-y-3">
        {items.map((d) => (
          <div key={d.id} className="border rounded p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded ${catClass(d.category)}`}>{d.category}</span>
              {d.problem_type && <span className="text-xs text-gray-500">{d.problem_type}</span>}
              <span className="text-xs text-gray-500">уверенность {Number(d.confidence).toFixed(2)}</span>
              {d.suggested_action && (
                <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">→ {d.suggested_action}</span>
              )}
              {d.tz_clause && <span className="text-xs text-gray-400 truncate max-w-md">{d.tz_clause}</span>}
            </div>
            {d.source_fragment && (
              <div className="text-sm text-gray-800 whitespace-pre-wrap line-clamp-3">«{d.source_fragment}»</div>
            )}
            {d.basis && <div className="text-sm text-gray-600">{d.basis}</div>}
            <div className="text-xs text-gray-400">
              источники: {Array.isArray(d.created_from_signal_ids) ? d.created_from_signal_ids.length : 0} сигн.
              {Array.isArray(d.created_from_signal_ids) && d.created_from_signal_ids.length > 0 && (
                <span className="ml-1 font-mono">
                  [{d.created_from_signal_ids.map((id) => String(id).slice(0, 8)).join(', ')}]
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
