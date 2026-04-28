import { Link } from 'react-router-dom';
import { useTenderStore } from '../store/useTenderStore';
import { useWizardState } from '../hooks/useWizardState';
import { stepRoute } from '../utils/wizardSteps';
import SectionRollup from '../components/wizard/SectionRollup';
import { api } from '../services/api';

export default function TenderOverview() {
  const tender = useTenderStore((s) => s.tender);
  const { tenderId, sections, recommendedStep, exportReady, ctx } = useWizardState();

  if (!tender || !tenderId) return null;

  const total = tender.counts?.issues_total ?? 0;
  const pending = tender.counts?.issues_pending ?? 0;
  const accepted = Math.max(0, total - pending);

  const allFinished = ctx.stages?.every((s) => s.status === 'finished') || false;

  return (
    <div className="space-y-4">
      {recommendedStep && !allFinished ? (
        <div className="card p-6 bg-gradient-to-br from-brand-50 to-white border-brand-200">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-brand-700 font-semibold">Следующий шаг</div>
              <h2 className="text-xl font-semibold mt-1">{recommendedStep.label}</h2>
              <p className="text-sm text-gray-600 mt-2 max-w-prose">
                {recommendedStep.gate?.reason || 'Откройте раздел и продолжите подготовку или анализ ТЗ.'}
              </p>
            </div>
            <Link
              to={stepRoute(recommendedStep, tenderId)}
              className="btn btn-primary text-base px-5 py-2.5"
            >
              Перейти →
            </Link>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {sections.map((section) => (
          <SectionRollup key={section.id} section={section} tenderId={tenderId} />
        ))}
      </div>

      <div className="card p-4">
        <h3 className="font-semibold mb-3">Сводка по замечаниям</h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-semibold">{total}</div>
            <div className="text-xs text-gray-500">Всего</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-amber-700">{pending}</div>
            <div className="text-xs text-gray-500">На рассмотрении</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-green-700">{accepted}</div>
            <div className="text-xs text-gray-500">Обработано</div>
          </div>
        </div>
      </div>

      {allFinished && (
        <div className="card p-6 bg-green-50 border-green-200">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-semibold text-green-900">Все 4 стадии завершены</h3>
              <p className="text-sm text-green-800 mt-1">
                ТЗ.docx с правками и комментариями готов к скачиванию. Откройте файл в Word — увидите Comments в правой панели и зачёркнутый текст для решений «Удалить из ТЗ».
              </p>
            </div>
            <a
              href={api.exportDocxUrl(tenderId)}
              className="btn btn-primary text-base px-5 py-2.5"
            >
              ⬇ Скачать ТЗ.docx
            </a>
          </div>
        </div>
      )}

      {!allFinished && exportReady && (
        <div className="card p-4 bg-blue-50 border-blue-200">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h4 className="font-semibold text-sm text-blue-900">Промежуточный экспорт доступен</h4>
              <p className="text-xs text-blue-800 mt-1">Можно скачать ТЗ.docx с уже принятыми правками — но рекомендуем пройти все 4 стадии для полноты результата.</p>
            </div>
            <a href={api.exportDocxUrl(tenderId)} className="btn btn-secondary">⬇ Скачать .docx</a>
          </div>
        </div>
      )}
    </div>
  );
}
