import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { formatDateTime } from '../../utils/format';
import { toastError, toastSuccess } from '../../store/useToastStore';
import { useTenderStore } from '../../store/useTenderStore';

const SLOTS = [
  {
    type: 'tz',
    label: 'ТЗ',
    hint: 'Техническое задание (Word/PDF + .md-копия для AI)',
    badge: 'ТЗ',
    color: 'blue',
    subSlots: [
      { key: 'word', label: 'Word / PDF', accept: '.docx,.doc,.pdf', match: /\.(docx?|pdf)$/i },
      { key: 'md', label: 'Markdown (.md)', accept: '.md,text/markdown', match: /\.md$/i },
    ],
  },
  {
    type: 'pd_rd',
    label: 'ПД / РД',
    hint: 'Проектная и рабочая документация',
    accept: '.pdf,.docx,.doc,.zip,.dwg',
    badge: 'ПД',
    color: 'green',
    multiple: true,
  },
  {
    type: 'vor',
    label: 'ВОР',
    hint: 'Ведомость объёмов работ',
    accept: '.xlsx,.xls,.csv,.pdf',
    badge: 'ВОР',
    color: 'purple',
    multiple: false,
  },
  {
    type: 'qa',
    label: 'Q&A форма',
    hint: 'Форма «Вопрос–Ответ» в .xlsx',
    accept: '.xlsx,.xls',
    badge: 'Q&A',
    color: 'amber',
    multiple: false,
  },
];

const COLOR_CLASSES = {
  blue: { bg: 'bg-blue-50', border: 'border-blue-200', badge: 'bg-blue-600 text-white' },
  green: { bg: 'bg-green-50', border: 'border-green-200', badge: 'bg-green-600 text-white' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-500 text-white' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-600 text-white' },
};

export default function DocumentsPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);
  const refreshDocuments = useTenderStore((s) => s.refreshDocuments);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyType, setBusyType] = useState(null);

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const data = await api.listDocuments(tenderId);
      setItems(data.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  // Авто-обновление статуса фоновой text-extraction.
  useEffect(() => {
    if (!tenderId) return undefined;
    const hasPending = items.some((d) => d.processing_status === 'pending');
    if (!hasPending) return undefined;
    const tick = setTimeout(async () => {
      try {
        const data = await api.listDocuments(tenderId);
        setItems(data.items || []);
      } catch (_e) { /* swallow polling errors */ }
    }, 3000);
    return () => clearTimeout(tick);
  }, [items, tenderId]);

  const docsFor = (type) => items.filter((d) => d.doc_type === type);

  const handleUpload = async (slot, files, subSlot = null) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !tenderId) return;
    setBusyType(slot.type);
    try {
      if (subSlot) {
        // Подслот: один файл, замена существующего того же формата.
        const file = list[0];
        const existing = docsFor(slot.type).find((d) => subSlot.match.test(d.name));
        await api.uploadDocument(tenderId, file, slot.type, '');
        if (existing) {
          try { await api.deleteDocument(existing.id); } catch (_e) { /* swallow */ }
        }
        toastSuccess(`${slot.label} · ${subSlot.label}: загружено`);
      } else if (slot.multiple) {
        // ПД/РД: добавляем все файлы, ничего не удаляем
        for (const f of list) {
          await api.uploadDocument(tenderId, f, slot.type, '');
        }
        toastSuccess(`${slot.label}: добавлено ${list.length}`);
      } else {
        // Одиночный слот: заменяем
        const file = list[0];
        const existing = docsFor(slot.type)[0];
        await api.uploadDocument(tenderId, file, slot.type, '');
        if (existing) {
          try { await api.deleteDocument(existing.id); } catch (_e) { /* swallow */ }
        }
        toastSuccess(`${slot.label}: загружено`);
      }
      await load();
      await Promise.all([refreshTender(), refreshDocuments()]);
    } catch (err) {
      toastError(err.message);
    }
    setBusyType(null);
  };

  const handleDelete = async (slot, doc) => {
    if (!confirm(`Удалить ${slot.label}: ${doc.name}?`)) return;
    try {
      await api.deleteDocument(doc.id);
      toastSuccess('Документ удалён');
      await load();
      await Promise.all([refreshTender(), refreshDocuments()]);
    } catch (err) { toastError(err.message); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Документы тендера</h2>
        <p className="text-sm text-gray-600 mt-0.5">
          ТЗ — отдельные подслоты для Word/PDF и Markdown-копии (для AI).
          ВОР — один файл (повторная загрузка заменяет предыдущий).
          В разделе ПД/РД можно держать несколько файлов одновременно.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {SLOTS.map((slot) => (
          <SlotCard
            key={slot.type}
            slot={slot}
            docs={docsFor(slot.type)}
            busy={busyType === slot.type}
            disabled={loading || (busyType !== null && busyType !== slot.type)}
            tenderId={tenderId}
            onUpload={(files, subSlot) => handleUpload(slot, files, subSlot)}
            onDelete={(doc) => handleDelete(slot, doc)}
          />
        ))}
      </div>

      {loading && items.length === 0 && (
        <div className="text-center text-gray-500 text-sm py-2">Загрузка…</div>
      )}
    </div>
  );
}

function SlotCard({ slot, docs, busy, disabled, tenderId, onUpload, onDelete }) {
  const c = COLOR_CLASSES[slot.color];

  // Слот с подслотами (ТЗ: Word/PDF + Markdown).
  if (slot.subSlots) {
    const anyDoc = docs.length > 0;
    return (
      <div className={`card p-4 flex flex-col gap-3 ${anyDoc ? c.border + ' ' + c.bg : 'border-dashed'}`}>
        <SlotHeader slot={slot} c={c} />
        <div className="flex flex-col gap-2 flex-1">
          {slot.subSlots.map((sub) => (
            <SubSlotRow
              key={sub.key}
              sub={sub}
              doc={docs.find((d) => sub.match.test(d.name))}
              busy={busy}
              disabled={disabled}
              onUpload={(files) => onUpload(files, sub)}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    );
  }

  // Обычный слот (один файл или multi).
  return (
    <RegularSlotCard
      slot={slot} docs={docs} busy={busy} disabled={disabled}
      tenderId={tenderId} onUpload={onUpload} onDelete={onDelete} c={c}
    />
  );
}

function SlotHeader({ slot, c, count }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`flex items-center justify-center w-12 h-12 rounded-lg font-bold text-sm flex-shrink-0 ${c.badge}`}>
        {slot.badge}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold leading-tight flex items-center gap-2">
          {slot.label}
          {typeof count === 'number' && count > 0 && (
            <span className="text-xs bg-white border border-gray-300 text-gray-700 px-1.5 py-0.5 rounded-full font-normal">
              {count}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-0.5">{slot.hint}</div>
      </div>
    </div>
  );
}

function SubSlotRow({ sub, doc, busy, disabled, onUpload, onDelete }) {
  const inputRef = useRef(null);
  const trigger = () => inputRef.current?.click();
  const onPick = (e) => {
    const fs = e.target.files;
    if (fs && fs.length) onUpload(fs);
    if (inputRef.current) inputRef.current.value = '';
  };
  const empty = !doc;
  const status = doc?.processing_status;
  const statusLabel =
    status === 'extracted' ? 'извлечён' :
    status === 'failed' ? 'ошибка' :
    status === 'pending' ? 'обработка' : status;
  const statusClass =
    status === 'extracted' ? 'text-green-700' :
    status === 'failed' ? 'text-red-700' : 'text-amber-700';

  return (
    <div className="bg-white border border-gray-200 rounded-md p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-700">{sub.label}</span>
        {!empty && (
          <span className="text-[11px] text-gray-500 truncate">
            {formatDateTime(doc.uploaded_at)} · <span className={statusClass}>{statusLabel}</span>
          </span>
        )}
      </div>
      {empty ? (
        <div className="text-xs text-gray-400 italic">Не загружено</div>
      ) : (
        <div className="text-sm font-medium break-all" title={doc.name}>{doc.name}</div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={sub.accept}
        onChange={onPick}
        className="hidden"
        disabled={busy}
      />
      <div className="flex items-center gap-1.5 mt-0.5">
        <button
          className={`flex-1 ${empty ? 'btn btn-primary' : 'btn btn-secondary'}`}
          onClick={trigger}
          disabled={busy || disabled}
        >
          {busy ? 'Загрузка…' : empty ? '+ Загрузить' : 'Заменить'}
        </button>
        {!empty && (
          <button
            type="button"
            className="btn btn-secondary text-red-600"
            onClick={() => onDelete(doc)}
            disabled={busy || disabled}
            title="Удалить"
            aria-label="Удалить"
          >×</button>
        )}
      </div>
    </div>
  );
}

function RegularSlotCard({ slot, docs, busy, disabled, tenderId, onUpload, onDelete, c }) {
  const inputRef = useRef(null);
  const empty = docs.length === 0;
  const multi = !!slot.multiple;

  const trigger = () => inputRef.current?.click();
  const onPick = (e) => {
    const fs = e.target.files;
    if (fs && fs.length) onUpload(fs);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className={`card p-4 flex flex-col gap-3 ${empty ? 'border-dashed' : c.border + ' ' + c.bg}`}>
      <SlotHeader slot={slot} c={c} count={multi ? docs.length : undefined} />

      <div className="flex-1 min-h-[64px]">
        {empty ? (
          <p className="text-sm text-gray-500 italic">Не загружено</p>
        ) : multi ? (
          <DocList docs={docs} onDelete={onDelete} disabled={busy || disabled} />
        ) : (
          <DocSingle doc={docs[0]} />
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={slot.accept}
        multiple={multi}
        onChange={onPick}
        className="hidden"
        disabled={busy}
      />

      <div className="flex items-center gap-1.5">
        <button
          className={`flex-1 ${empty ? 'btn btn-primary' : 'btn btn-secondary'}`}
          onClick={trigger}
          disabled={busy || disabled}
        >
          {busy ? 'Загрузка…' : empty ? '+ Загрузить' : multi ? '+ Добавить файл' : 'Заменить'}
        </button>
        {!multi && !empty && (
          <button
            type="button"
            className="btn btn-secondary text-red-600"
            onClick={() => onDelete(docs[0])}
            disabled={busy || disabled}
            title="Удалить"
            aria-label="Удалить"
          >×</button>
        )}
      </div>

      {slot.type === 'qa' && !empty && tenderId && (
        <Link
          to={`/tenders/${tenderId}/setup/qa`}
          className="btn btn-secondary justify-center w-full"
        >
          Открыть таблицу Q&A →
        </Link>
      )}
    </div>
  );
}

function DocSingle({ doc }) {
  const status = doc.processing_status;
  const statusLabel =
    status === 'extracted' ? 'текст извлечён' :
    status === 'failed' ? 'ошибка обработки' :
    status === 'pending' ? 'обработка…' : status;
  const statusClass =
    status === 'extracted' ? 'text-green-700' :
    status === 'failed' ? 'text-red-700' : 'text-amber-700';
  return (
    <div className="text-sm">
      <div className="font-medium break-all" title={doc.name}>{doc.name}</div>
      <div className="text-xs text-gray-500 mt-1">
        <span>{formatDateTime(doc.uploaded_at)}</span>
        <span className="mx-1.5">•</span>
        <span className={statusClass}>{statusLabel}</span>
      </div>
    </div>
  );
}

function DocList({ docs, onDelete, disabled }) {
  return (
    <ul className="space-y-1.5">
      {docs.map((d) => {
        const ok = d.processing_status === 'extracted';
        const failed = d.processing_status === 'failed';
        return (
          <li key={d.id} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium break-all" title={d.name}>{d.name}</div>
              <div className="text-[11px] text-gray-500">
                {formatDateTime(d.uploaded_at)}
                <span className="mx-1">•</span>
                <span className={ok ? 'text-green-700' : failed ? 'text-red-700' : 'text-amber-700'}>
                  {ok ? 'извлечён' : failed ? 'ошибка' : 'обработка'}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="text-red-600 hover:text-red-800 text-sm px-1.5"
              onClick={() => onDelete(d)}
              disabled={disabled}
              title="Удалить"
              aria-label="Удалить"
            >×</button>
          </li>
        );
      })}
    </ul>
  );
}
