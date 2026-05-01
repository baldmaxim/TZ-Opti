import { useState } from 'react';
import { useTenderStore } from '../../store/useTenderStore';
import { toastError, toastSuccess } from '../../store/useToastStore';
import ResetStageModal from '../../components/stages/ResetStageModal';

export default function StageRunControls({ stage, status, hasSummary }) {
  const runStage = useTenderStore((s) => s.runStage);
  const finishStage = useTenderStore((s) => s.finishStage);
  const resetStage = useTenderStore((s) => s.resetStage);

  const [busy, setBusy] = useState(false);
  const [resetTo, setResetTo] = useState(null);
  const [resetting, setResetting] = useState(false);

  const isReadOnly = status === 'finished';
  const isLocked = status === 'locked';

  const onRun = async () => {
    setBusy(true);
    try {
      await runStage(stage);
      toastSuccess('Анализ выполнен');
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
          <button className="btn btn-primary" onClick={onRun} disabled={busy}>
            {busy ? 'Анализ…' : (hasSummary ? 'Перезапустить анализ' : 'Запустить анализ')}
          </button>
        )}
        {!isReadOnly && !isLocked && hasSummary && (
          <button className="btn btn-secondary" onClick={onFinish} disabled={busy}>Завершить стадию</button>
        )}
        {!isReadOnly && !isLocked && hasSummary && (
          <button
            className="btn btn-secondary text-red-600"
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
