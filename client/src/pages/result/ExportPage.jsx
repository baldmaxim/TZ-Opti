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

  // Готовность рецензии — жёсткий серверный гейт выгрузок (409 REVIEW_NOT_READY).
  // Здесь то же состояние показывается ДО клика, с причинами.
  const [readiness, setReadiness] = useState(null);
  useEffect(() => {
    if (!tenderId || exportStep?.status === 'locked') return;
    api.getReviewReadiness(tenderId).then(setReadiness).catch(() => setReadiness(null));
  }, [tenderId, exportStep?.status]);

  // Источник экспорта: снимок согласованной версии ТЗ или живые решения.
  // По умолчанию — активная версия (если есть): экспорт воспроизводим.
  const [agreedVersions, setAgreedVersions] = useState([]);
  const [versionId, setVersionId] = useState(''); // '' = живые решения

  useEffect(() => {
    if (!tenderId || exportStep?.status === 'locked') return;
    api.listAgreedVersions(tenderId)
      .then((data) => {
        setAgreedVersions(data.items || []);
        if (data.active_id) setVersionId(data.active_id);
      })
      .catch(() => setAgreedVersions([]));
  }, [tenderId, exportStep?.status]);

  const loadReport = useCallback(async () => {
    if (!tenderId) return;
    setLoadingReport(true);
    setReportErr(null);
    try {
      setReport(await api.exportDocxReport(tenderId, null, versionId || null));
    } catch (e) {
      setReportErr(e.message);
      setReport(null);
    } finally {
      setLoadingReport(false);
    }
  }, [tenderId, versionId]);

  useEffect(() => {
    if (tenderId && exportStep?.status !== 'locked') loadReport();
  }, [tenderId, exportStep?.status, loadReport]);

  if (!tenderId) return null;
  if (exportStep?.status === 'locked') {
    return <GateNotice stepId="export" />;
  }

  // Выгрузки закрыты Bearer-токеном: файл забирается запросом с заголовком
  // (api.download*), а не переходом по ссылке — браузер токен не подставит.
  const items = [
    {
      title: 'ТЗ.docx с правками и комментариями',
      desc: 'Главный артефакт. Берётся исходный ТЗ.docx, в него вносятся настоящие правки Word (Track Changes) и комментарии по принятым решениям.',
      get: () => api.downloadExportDocx(tenderId, null, versionId || null),
      primary: true,
    },
    {
      title: 'HTML-preview режима рецензии',
      desc: 'Просмотр в браузере без Word. Те же решения по пунктам ТЗ, что и в Word: зачёркивание, замена, примечание.',
      get: () => api.openReviewPreview(tenderId),
      action: 'Открыть',
    },
    {
      title: 'CSV реестра замечаний',
      desc: 'UTF-8 BOM, открывается в Excel. По всем стадиям, с колонкой analysis_stage.',
      get: () => api.downloadExportCsv(tenderId),
    },
    {
      title: 'JSON результатов анализа',
      desc: 'Полный дамп: тендер, прогоны, замечания, решения.',
      get: () => api.downloadExportJson(tenderId),
    },
    {
      title: 'Краткая сводка (Markdown)',
      desc: 'Сводка по тендеру, итоги анализа, ключевые риски, неучтённые работы.',
      get: () => api.downloadExportSummary(tenderId),
    },
  ];

  const summary = report?.summary;
  const problems = (report?.items || []).filter((it) => it.status !== 'applied');
  // Выгрузка от снимка согласованной версии разрешена всегда (снимок создавался
  // через тот же гейт); живые решения — только при завершённой рецензии.
  const exportAllowed = readiness ? readiness.export_allowed : true;
  const blockedLive = !exportAllowed && !versionId;

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Главный экспорт — `.docx` с правками и комментариями в логике Word Review. Выгрузки
        доступны только после ЗАВЕРШЁННОЙ рецензии: у каждого замечания рабочего списка есть
        решение (в том числе «отклонить»), перенос решений разобран, снимок не устарел.
      </p>

      {readiness && !readiness.export_allowed && (
        <div className="card p-3 border-amber-300 bg-amber-50 dark:bg-amber-900/30 text-sm space-y-1">
          <div className="font-semibold text-amber-900 dark:text-amber-200">
            Экспорт заблокирован: рецензия не завершена
          </div>
          <div className="text-xs text-amber-800 dark:text-amber-300">
            Решено {readiness.decided_clusters} из {readiness.total_clusters} замечаний
            {readiness.carryovers_pending > 0 && <> · перенос решений не разобран: {readiness.carryovers_pending}</>}
            {readiness.pipeline_stale && <> · снимок устарел (документы менялись после сборки)</>}
          </div>
          {(readiness.reasons || []).map((r, i) => (
            <div key={i} className="text-xs text-amber-800 dark:text-amber-300">• {r}</div>
          ))}
        </div>
      )}

      {agreedVersions.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Источник решений для Word:</span>
          <select
            className="input text-sm"
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
          >
            {agreedVersions.map((v) => (
              <option key={v.id} value={v.id}>
                Согласованная версия {v.version_no}
                {v.status === 'active' ? ' (активная)' : v.status === 'archived' ? ' (архив)' : ' (черновик)'}
              </option>
            ))}
            <option value="">Текущие решения рецензии (живые)</option>
          </select>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Экспорт версии идёт от её неизменяемого снимка решений и воспроизводим
            независимо от дальнейшей рецензии.
          </span>
        </div>
      )}
      {items.map((it) => {
        // HTML-preview — просмотр, не выгрузка (не блокируется). Docx от снимка
        // согласованной версии тоже разрешён; остальное ждёт завершения рецензии.
        const disabled = it.action !== 'Открыть' && (it.primary ? blockedLive : !exportAllowed);
        return (
          <div key={it.title} className={`card p-4 flex items-center justify-between gap-3 ${it.primary ? 'border-brand-300 bg-brand-50/40' : ''}`}>
            <div>
              <div className="font-semibold">{it.title}</div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">{it.desc}</div>
            </div>
            <button
              type="button"
              onClick={() => it.get().catch((e) => alert(e.message))}
              className={`btn ${it.primary ? 'btn-primary' : 'btn-secondary'}`}
              disabled={disabled}
              title={disabled ? 'Завершите рецензию: решение по каждому замечанию рабочего списка' : undefined}
            >
              {it.action || 'Скачать'}
            </button>
          </div>
        );
      })}

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
            <span className={`px-1.5 py-0.5 rounded ${report.source !== 'issues' ? 'text-brand-700 bg-brand-50' : 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700'}`}>
              {report.source === 'agreed_version'
                ? `снимок согласованной версии${report.agreed_version ? ` ${report.agreed_version.version_no}` : ''}`
                : report.source === 'clusters' ? 'кластеры (основной путь)' : 'находки стадий (legacy-fallback)'}
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
