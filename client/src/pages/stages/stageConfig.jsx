import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { toastError } from '../../store/useToastStore';

function Stage2QaContext({ tenderId }) {
  const [chars, setChars] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.listCharacteristics(tenderId)
      .then((d) => { if (!cancelled) { setChars(d.items || []); setLoading(false); } })
      .catch((err) => { if (!cancelled) { toastError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [tenderId]);

  const empty = !loading && chars.length === 0;

  return (
    <div className={`card p-4 mt-4 ${empty ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h4 className="font-semibold text-sm">Q&A форма (вход для Стадии 2)</h4>
          {loading ? (
            <p className="text-xs text-gray-500 mt-1">Загрузка статуса…</p>
          ) : empty ? (
            <p className="text-xs text-amber-800 mt-1">
              Q&A форма не загружена. Без неё запуск Стадии 2 заблокирован.
            </p>
          ) : (
            <p className="text-xs text-blue-900 mt-1">
              Загружено характеристик: <strong>{chars.length}</strong>. Анализ Стадии 2 готов к запуску.
            </p>
          )}
        </div>
        <Link
          to={`/tenders/${tenderId}/setup/qa`}
          className="btn btn-secondary"
        >
          {empty ? 'Загрузить Q&A' : 'Открыть Q&A'} →
        </Link>
      </div>
      {!empty && chars.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chars.slice(0, 6).map((c) => (
            <span key={c.id} className="tag bg-white border border-blue-200 text-blue-900">
              {c.name}: {c.value || '—'}
            </span>
          ))}
          {chars.length > 6 && (
            <span className="tag bg-white border border-blue-200 text-blue-900">+ ещё {chars.length - 6}</span>
          )}
        </div>
      )}
    </div>
  );
}

export const STAGE_CONFIG = {
  1: {
    label: 'Стадия 1: ТЗ + Чек-лист + ВОР',
    short: 'Стадия 1',
    description: 'Сравниваем ТЗ с чек-листом состава работ и ведомостью объёмов работ. Выявляем работы, не учтённые в расчёте.',
  },
  2: {
    label: 'Стадия 2: Q&A форма + Таблица характеристик',
    short: 'Стадия 2',
    description: 'Сверяем ТЗ с принятыми бизнес-решениями (Q&A) и характеристиками. Ищем противоречия и неотражённые параметры.',
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
