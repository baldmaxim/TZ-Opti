import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { toastError } from '../../store/useToastStore';

function Stage2QaContext({ tenderId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.listQa(tenderId)
      .then((d) => { if (!cancelled) { setItems(d.items || []); setLoading(false); } })
      .catch((err) => { if (!cancelled) { toastError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [tenderId]);

  const empty = !loading && items.length === 0;
  const linked = items.filter((q) => q.tz_clause && q.tz_clause.trim()).length;
  const contradicts = items.filter((q) => q.tz_contradicts).length;
  const sections = new Set(items.map((q) => q.section).filter(Boolean)).size;

  return (
    <div className={`card p-4 mt-4 ${empty ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h4 className="font-semibold text-sm">Q&A — вход для Стадии 2</h4>
          {loading ? (
            <p className="text-xs text-gray-500 mt-1">Загрузка статуса…</p>
          ) : empty ? (
            <p className="text-xs text-amber-800 mt-1">
              Q&A форма не загружена. Без переписки с заказчиком стадия 2 не запускается.
            </p>
          ) : (
            <p className="text-xs text-blue-900 mt-1">
              Q&A: <strong>{items.length}</strong> вопросов, <strong>{sections}</strong> разделов. Привязок к ТЗ: <strong>{linked}</strong>. Противоречий: <strong>{contradicts}</strong>.
            </p>
          )}
        </div>
        <Link to={`/tenders/${tenderId}/setup/qa`} className="btn btn-secondary">
          {empty ? 'Загрузить Q&A' : 'Открыть Q&A'} →
        </Link>
      </div>
    </div>
  );
}

export const STAGE_CONFIG = {
  1: {
    label: 'Стадия 1: ТЗ + Чек-лист + ВОР',
    short: 'Стадия 1',
    description: 'На основе чек-листа и ВОР находим в тексте ТЗ описания работ, не учтённых в расчёте КП/ВОР.',
  },
  2: {
    label: 'Стадия 2: Q&A → правки в ТЗ',
    short: 'Стадия 2',
    description: 'Преобразуем принятые решения СУ-10 (Q&A) в правки ТЗ: исключённые работы, открытые блокеры, противоречия. Используем привязки к пунктам ТЗ из вкладки Q&A.',
    ContextSlot: Stage2QaContext,
  },
  3: {
    label: 'Стадия 3: Типовые риски',
    short: 'Стадия 3',
    description: 'Сопоставляем ТЗ с базой типовых рисков. Помечаем ключевые формулировки и предлагаем рекомендации.',
  },
  4: {
    label: 'Стадия 4: Самоанализ ТЗ',
    short: 'Стадия 4',
    description: 'Ищем в ТЗ скрытые работы, двусмысленные формулировки и факторы, влияющие на срок выполнения.',
  },
};
