import { useState } from 'react';
import { useTenderStore } from '../../store/useTenderStore';
import { toastError, toastSuccess } from '../../store/useToastStore';
import ResetStageModal from '../../components/stages/ResetStageModal';

export default function StageRunControls({ stage, status, hasSummary }) {
  const runStage = useTenderStore((s) => s.runStage);
  const finishStage = useTenderStore((s) => s.finishStage);
  const resetStage = useTenderStore((s) => s.resetStage);
  const documents = useTenderStore((s) => s.documents);

  const [busy, setBusy] = useState(false);
  const [resetTo, setResetTo] = useState(null);
  const [resetting, setResetting] = useState(false);

  const isReadOnly = status === 'finished';
  const isLocked = status === 'locked';
  const isRunning = status === 'running'; // фоновый анализ идёт

  // Стадия 1 (LLM-агент GPT-4) запускается только когда в слот ТЗ загружена .md-копия.
  const hasTzMd = documents.some((d) => d.doc_type === 'tz' && /\.md$/i.test(d.name || ''));
  const stage1Blocked = stage === 1 && !hasTzMd;

  const onRun = async () => {
    setBusy(true);
    try {
      await runStage(stage);
      // Анализ идёт в фоне — успех/ошибку покажет опрос по завершении.
      toastSuccess('Анализ запущен — идёт в фоне. Можно закрыть вкладку, результат появится сам.');
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const onFinish = async () => {
    if (!confirm('Завершить стадию? Решения с действием «удалить из ТЗ» применятся к активному тексту, и стадия N+1 разблокируется.')) return;
    setBusy(true);
    try {
      await finishStage(stage);
      toastSuccess(`Стадия ${stage} завершена`);
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const onReset = async () => {
    setResetting(true);
    try {
      await resetStage(resetTo);
      toastSuccess(`Сброс стадий ${resetTo}+ выполнен`);
      // Не делаем navigate — после refreshStages в store панель этой же
      // стадии переключится на status='open' и UI обновится сам, оставаясь
      // в текущем view (новый Анализ-обзор с плитками).
    } catch (err) { toastError(err.message); }
    setResetting(false);
    setResetTo(null);
  };

  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {!isReadOnly && !isLocked && (
          <button
            className="btn btn-primary"
            onClick={onRun}
            disabled={busy || stage1Blocked || isRunning}
            title={stage1Blocked ? 'Загрузите .md-копию ТЗ — анализ ведётся только по .md' : undefined}
          >
            {isRunning
              ? 'Анализ идёт…'
              : busy
                ? 'Запуск…'
                : (hasSummary ? 'Перезапустить анализ' : 'Запустить анализ')}
          </button>
        )}
        {stage1Blocked && (
          <span className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/40 border dark:border-gray-700 border-amber-200 dark:border-amber-800 rounded px-2 py-1 self-center">
            Загрузите .md-копию ТЗ для запуска
          </span>
        )}
        {!isReadOnly && !isLocked && hasSummary && !isRunning && (
          <button className="btn btn-secondary" onClick={onFinish} disabled={busy}>Завершить стадию</button>
        )}
        {!isReadOnly && !isLocked && hasSummary && !isRunning && (
          <button
            className="btn btn-secondary text-red-600 dark:text-red-300"
            onClick={() => setResetTo(stage)}
            disabled={busy}
            title="Удалить все замечания и решения этой стадии"
          >Сбросить стадию</button>
        )}
        {isReadOnly && (
          <button className="btn btn-secondary" onClick={() => setResetTo(stage)}>Вернуться и пересмотреть</button>
        )}
      </div>

      <ResetStageModal
        open={resetTo !== null}
        stage={resetTo}
        busy={resetting}
        onClose={() => setResetTo(null)}
        onConfirm={onReset}
      />
    </>
  );
}
