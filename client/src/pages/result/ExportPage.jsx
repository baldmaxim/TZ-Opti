import { api } from '../../services/api';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';

export default function ExportPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const { steps } = useWizardState();
  const exportStep = steps.find((s) => s.id === 'export');

  if (!tenderId) return null;
  if (exportStep?.status === 'locked') {
    return <GateNotice stepId="export" />;
  }

  const items = [
    {
      title: 'ТЗ.docx с правками и комментариями',
      desc: 'Главный артефакт. Берётся исходный ТЗ.docx, в него внедряются комментарии Word, для решений «удалить из ТЗ» применяется визуальное вычёркивание.',
      url: api.exportDocxUrl(tenderId),
      primary: true,
    },
    {
      title: 'HTML-preview режима рецензии',
      desc: 'Просмотр в браузере без Word. Цветные вставки на пунктах ТЗ + карточки комментариев.',
      url: api.reviewPreviewUrl(tenderId),
      target: '_blank',
    },
    {
      title: 'CSV реестра замечаний',
      desc: 'UTF-8 BOM, открывается в Excel. По всем стадиям, с колонкой analysis_stage.',
      url: api.exportCsvUrl(tenderId),
    },
    {
      title: 'JSON результатов анализа',
      desc: 'Полный дамп: тендер, прогоны, замечания, решения.',
      url: api.exportJsonUrl(tenderId),
    },
    {
      title: 'Краткая сводка (Markdown)',
      desc: 'Сводка по тендеру, итоги анализа, ключевые риски, неучтённые работы.',
      url: api.exportSummaryUrl(tenderId),
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Главный экспорт — `.docx` с правками и комментариями в логике Word Review. Доступен после первой завершённой стадии, но качество результата выше после прохождения всех 4 стадий.
      </p>
      {items.map((it) => (
        <div key={it.title} className={`card p-4 flex items-center justify-between gap-3 ${it.primary ? 'border-brand-300 bg-brand-50/40' : ''}`}>
          <div>
            <div className="font-semibold">{it.title}</div>
            <div className="text-xs text-gray-600 mt-1">{it.desc}</div>
          </div>
          <a
            href={it.url}
            target={it.target || '_self'}
            className={`btn ${it.primary ? 'btn-primary' : 'btn-secondary'}`}
          >
            {it.target === '_blank' ? 'Открыть' : 'Скачать'}
          </a>
        </div>
      ))}
      <div className="text-xs text-gray-500 pt-2 border-t">
        Ограничение MVP: настоящий Word Track Changes (`w:ins` / `w:del`) — следующая задача. Сейчас «удаления» отображаются как зачёркнутый текст красного цвета + комментарий. Архитектура готова к замене (см. README).
      </div>
    </div>
  );
}
