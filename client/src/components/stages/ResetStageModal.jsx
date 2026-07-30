import Modal from '../ui/Modal';

export default function ResetStageModal({ open, stage, onConfirm, onClose, busy }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Вернуться к стадии ${stage}?`}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Сброс…' : `Сбросить стадии ${stage}+`}
          </button>
        </>
      }
    >
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Вы открываете на пересмотр стадию {stage}. Это <strong>каскадно сбросит</strong> все стадии после неё:
      </p>
      <ul className="list-disc ml-5 mt-2 text-sm text-gray-700 dark:text-gray-300">
        <li>результаты стадий ≥ {stage} будут сняты с актуальных (уйдут в архив);</li>
        <li>анализ нужно будет запустить заново.</li>
      </ul>
      <p className="text-sm text-gray-700 dark:text-gray-300 mt-3">Продолжить?</p>
    </Modal>
  );
}
