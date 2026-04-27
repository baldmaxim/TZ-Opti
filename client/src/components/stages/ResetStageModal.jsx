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
      <p className="text-sm text-gray-700">
        Вы открываете на пересмотр стадию {stage}. Это <strong>каскадно сбросит</strong> все стадии после неё:
      </p>
      <ul className="list-disc ml-5 mt-2 text-sm text-gray-700">
        <li>будут удалены замечания и решения стадий ≥ {stage};</li>
        <li>будут удалены применённые исключения фрагментов ТЗ;</li>
        <li>анализ нужно будет запустить заново.</li>
      </ul>
      <p className="text-sm text-gray-700 mt-3">Продолжить?</p>
    </Modal>
  );
}
