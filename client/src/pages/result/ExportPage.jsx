import { useEffect, useState, useCallback } from 'react';
import { api } from '../../services/api';
import { useTenderStore } from '../../store/useTenderStore';
import { useWizardState } from '../../hooks/useWizardState';
import GateNotice from '../../components/wizard/GateNotice';
import { USER_DECISION_LABELS } from '../../utils/labels';

const STATUS_LABEL = {
  applied: 'легло',
  fallback: 'через комментарий',
  failed: 'не легло',
  skipped: 'пропущено',
};
const STATUS_CLASS = {
  applied: 'text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/40',
  fallback: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/40',
  failed: 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/40',
  skipped: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700',
};

export default function ExportPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const { steps } = useWizardState();
  const exportStep = steps.find((s) => s.id === 'export');

  const [report, setReport] = useState(null);
  const [reportErr, setReportErr] = useState(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const loadReport = useCallback(async () => {
    if (!tenderId) return;
    setLoadingReport(true);
    setReportErr(null);
    try {
      setReport(await api.exportDocxReport(tenderId));
    } catch (e) {
      setReportErr(e.message);
      setReport(null);
    } finally {
      setLoadingReport(false);
    }
  }, [tenderId]);

  useEffect(() => {
    if (tenderId && exportStep?.status !== 'locked') loadReport();
  }, [tenderId, exportStep?.status, loadReport]);

  if (!tenderId) return null;
  if (exportStep?.status === 'locked') {
    return <GateNotice stepId="export" />;
  }

  const items = [
    {
      title: 'ТЗ.docx с правками и комментариями',
      desc: 'Главный артефакт. Берётся исходный ТЗ.docx, в него вносятся настоящие правки Word (Track Changes) и комментарии по принятым решениям.',
      url: api.exportDocxUrl(tenderId),
      primary: true,
    },
    {
      title: 'HTML-preview режима рецензии',
      desc: 'Просмотр в браузере без Word. Те же решения по пунктам ТЗ, что и в Word: зачёркивание, замена, примечание.',
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

  const summary = report?.summary;
  const problems = (report?.items || []).filter((it) => it.status !== 'applied');

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Главный экспорт — `.docx` с правками и комментариями в логике Word Review. Доступен после сборки анализа ТЗ; качество результата выше, когда принята рецензия по кластерам.
      </p>
      {items.map((it) => (
        <div key={it.title} className={`card p-4 flex items-center justify-between gap-3 ${it.primary ? 'border-brand-300 bg-brand-50/40' : ''}`}>
          <div>
            <div className="font-semibold">{it.title}</div>
            <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">{it.desc}</div>
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

      <div className="card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Проверка экспорта в Word</div>
            <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">Что из решений попало в документ, а что нет (до скачивания).</div>
          </div>
          <button type="button" className="btn btn-secondary text-xs" onClick={loadReport} disabled={loadingReport}>
            {loadingReport ? 'Проверяю…' : 'Обновить'}
          </button>
        </div>

        {report?.source && (
          <div className="text-xs mt-2">
            Источник решений:{' '}
            <span className={`px-1.5 py-0.5 rounded ${report.source === 'clusters' ? 'text-brand-700 bg-brand-50' : 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700'}`}>
              {report.source === 'clusters' ? 'кластеры (основной путь)' : 'находки стадий (legacy-fallback)'}
            </span>
          </div>
        )}

        {reportErr && <div className="text-xs text-red-600 dark:text-red-300 mt-2">{reportErr}</div>}

        {summary && (
          <>
            <div className="flex flex-wrap gap-2 mt-3 text-xs">
              <span className="px-2 py-0.5 rounded text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/40">Легло: {summary.applied}</span>
              <span className="px-2 py-0.5 rounded text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/40">Через комментарий: {summary.fallback}</span>
              <span className="px-2 py-0.5 rounded text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/40">Не легло: {summary.failed}</span>
              <span className="px-2 py-0.5 rounded text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700">Пропущено: {summary.skipped}</span>
            </div>

            {problems.length === 0 ? (
              <div className="text-xs text-green-700 dark:text-green-300 mt-3">Все выбранные правки легли в документ как задумано.</div>
            ) : (
              <table className="w-full text-xs mt-3">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400">
                    <th className="font-medium pb-1 pr-2">Решение</th>
                    <th className="font-medium pb-1 pr-2">Фрагмент</th>
                    <th className="font-medium pb-1 pr-2">Статус</th>
                    <th className="font-medium pb-1">Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((it) => (
                    <tr key={it.issueId} className="border-t dark:border-gray-700 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">{USER_DECISION_LABELS[it.decisionKind] || it.decisionKind || '—'}</td>
                      <td className="py-1 pr-2 text-gray-600 dark:text-gray-400">{it.fragment ? `«${it.fragment}»` : '—'}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <span className={`px-1.5 py-0.5 rounded ${STATUS_CLASS[it.status] || ''}`}>{STATUS_LABEL[it.status] || it.status}</span>
                      </td>
                      <td className="py-1 text-gray-500 dark:text-gray-400">{it.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t dark:border-gray-700">
        Удаления и правки идут как настоящие Word Track Changes (`w:del` / `w:ins`); «вынести из объёма» дополнительно помечается комментарием. Если правку не удалось вставить автоматически, на её месте остаётся Word-комментарий — в отчёте выше это «через комментарий».
      </div>
    </div>
  );
}
