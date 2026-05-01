import { Link } from 'react-router-dom';
import { useTenderStore } from '../../store/useTenderStore';
import { api } from '../../services/api';

/**
 * Финальная плитка «Результат» — рецензия + экспорт.
 * Пока — простая навигация на существующие страницы.
 */
export default function ResultPanel() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const tender = useTenderStore((s) => s.tender);
  const stages = useTenderStore((s) => s.stages);

  const finishedStages = (stages || []).filter((s) => s.status === 'finished').length;
  const total = tender?.counts?.issues_total ?? 0;
  const pending = tender?.counts?.issues_pending ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-lg">Результат анализа</h2>
        <p className="text-sm text-gray-600 mt-1">
          Все правки в ТЗ, собранные после анализа: рецензия и экспорт в Word.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card p-3">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{finishedStages}/5</div>
          <div className="text-xs text-gray-500 mt-1">Стадий завершено</div>
        </div>
        <div className="card p-3">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{total}</div>
          <div className="text-xs text-gray-500 mt-1">Всего замечаний</div>
        </div>
        <div className="card p-3">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">
            {pending}
            {pending > 0 && <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" />}
          </div>
          <div className="text-xs text-gray-500 mt-1">На рассмотрении</div>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link
          to={`/tenders/${tenderId}/review`}
          className="btn btn-secondary"
        >
          📋 Открыть рецензию
        </Link>
        <a
          href={api.exportReviewMdUrl(tenderId)}
          className="btn btn-secondary"
          download
          title="review.md со всеми правками со всех стадий"
        >
          ⤓ Скачать review.md (все стадии)
        </a>
        <a
          href={api.exportDocxUrl(tenderId)}
          className="btn btn-primary"
          download
          title="Итоговый .docx с правками Track Changes из всех стадий — открывается в Word"
        >
          ⤓ ТЗ с правками .docx (все стадии)
        </a>
        <Link
          to={`/tenders/${tenderId}/export`}
          className="btn btn-secondary"
        >
          Расширенный экспорт →
        </Link>
      </div>
    </div>
  );
}
