import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess, toastWarning } from '../../store/useToastStore';

// Согласованные версии ТЗ. Решения рецензии материализуются в новый .md
// («Сформировать версию»), активация делает версию ВХОДОМ следующего раунда
// анализа (новая ревизия документов) и базой экспорта. Анализаторы при этом
// всегда читают неизменный вход — влияние решений идёт только через версию.

const STATUS_LABEL = {
  draft: { text: 'черновик', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300' },
  active: { text: 'активная', cls: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' },
  archived: { text: 'в архиве', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400' },
};

function reportSummary(report) {
  if (!report) return null;
  const parts = [];
  if (report.applied) parts.push(`применено: ${report.applied}`);
  if (report.skipped) parts.push(`пропущено: ${report.skipped}`);
  if (report.failed) parts.push(`не найдено: ${report.failed}`);
  if (report.conflicts) parts.push(`конфликтов: ${report.conflicts}`);
  return parts.join(', ') || 'правок нет';
}

export default function AgreedVersionsPanel({ tenderId, decidedCount = 0, onChanged }) {
  const [versions, setVersions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState(null);
  const [impactBusy, setImpactBusy] = useState(false);

  const load = async () => {
    if (!tenderId) return;
    try {
      const data = await api.listAgreedVersions(tenderId);
      setVersions(data.items || []);
      setLoaded(true);
    } catch (err) { toastError(err.message); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const create = async () => {
    setBusy(true);
    try {
      const v = await api.createAgreedVersion(tenderId);
      const r = v.build_report || {};
      if (r.failed || r.conflicts) {
        toastWarning(`Версия ${v.version_no} сформирована с оговорками (${reportSummary(r)})`);
      } else {
        toastSuccess(`Версия ${v.version_no} сформирована (${reportSummary(r)})`);
      }
      await load();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const activate = async (versionId) => {
    setBusy(true);
    try {
      const v = await api.activateAgreedVersion(tenderId, versionId);
      toastSuccess(`Версия ${v.version_no} активна: следующий анализ пойдёт по ней`);
      setImpact(null); // вход изменился — прежняя карта неактуальна
      await load();
      if (onChanged) await onChanged();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const loadImpact = async () => {
    setImpactBusy(true);
    try {
      setImpact(await api.getPipelineImpact(tenderId));
    } catch (err) { toastError(err.message); }
    setImpactBusy(false);
  };

  const archive = async (versionId) => {
    setBusy(true);
    try {
      await api.archiveAgreedVersion(tenderId, versionId);
      toastSuccess('Версия снята: анализ снова пойдёт от оригинального ТЗ');
      await load();
      if (onChanged) await onChanged();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  if (!loaded) return null;
  if (!versions.length && !decidedCount) return null;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-sm">Согласованные версии ТЗ</div>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Решения рецензии формируют новую версию текста. Активная версия — вход
            следующего раунда анализа и база экспорта.
          </div>
        </div>
        <button
          className="btn btn-primary text-xs"
          disabled={busy || !decidedCount}
          title={decidedCount ? '' : 'Сначала примите решения по замечаниям'}
          onClick={create}
        >
          {busy ? 'Формирую…' : 'Сформировать версию из решений'}
        </button>
      </div>

      {versions.some((v) => v.status === 'active') && (
        <div className="space-y-2">
          <button className="btn text-xs" disabled={impactBusy} onClick={loadImpact}>
            {impactBusy ? 'Оцениваю…' : 'Что пересчитается при следующем анализе?'}
          </button>
          {impact && (
            <div className="text-xs space-y-1 p-2 rounded border dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
              {(impact.stages || []).map((s) => (
                <div key={s.stage} className="flex items-center gap-2">
                  <span className="w-20">Стадия {s.stage}:</span>
                  {s.affected ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      пересчёт {s.to_compute} из {s.total} частей
                    </span>
                  ) : (
                    <span className="text-green-700 dark:text-green-300">
                      не затронута — все {s.total} частей из кэша, без вызовов модели
                    </span>
                  )}
                </div>
              ))}
              <div className="text-gray-500 dark:text-gray-400 pt-1">
                Оценка, не гарантия: правка может сдвинуть нарезку частей, тогда
                пересчёта потребует и хвост документа.
              </div>
            </div>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <div className="space-y-2">
          {versions.map((v) => {
            const st = STATUS_LABEL[v.status] || STATUS_LABEL.draft;
            return (
              <div
                key={v.id}
                className="flex flex-wrap items-center gap-2 p-2 rounded border dark:border-gray-700 bg-white dark:bg-gray-800"
              >
                <span className="font-medium text-sm">Версия {v.version_no}</span>
                <span className={`tag text-[10px] ${st.cls}`}>{st.text}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(v.created_at).toLocaleString('ru-RU')}
                </span>
                {v.build_report && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {reportSummary(v.build_report)}
                  </span>
                )}
                <span className="flex-1" />
                {v.status !== 'active' && (
                  <button className="btn text-xs" disabled={busy} onClick={() => activate(v.id)}>
                    Активировать
                  </button>
                )}
                {v.status === 'active' && (
                  <button className="btn text-xs" disabled={busy} onClick={() => archive(v.id)}>
                    Снять
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
