import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { toastError, toastSuccess } from '../../store/useToastStore';
import EmptyState from '../../components/ui/EmptyState';
import { useTenderStore } from '../../store/useTenderStore';
import NextStepCta from '../../components/wizard/NextStepCta';

const CONTOURS = [
  { key: 'affects_calc',     short: 'Р', title: 'Влияет на расчёт' },
  { key: 'affects_kp',       short: 'К', title: 'Влияет на КП' },
  { key: 'affects_contract', short: 'Д', title: 'Влияет на договор' },
  { key: 'affects_schedule', short: 'Г', title: 'Влияет на график' },
];

export default function QaPage() {
  const tenderId = useTenderStore((s) => s.tenderId);
  const refreshTender = useTenderStore((s) => s.refreshTender);
  const refreshDocuments = useTenderStore((s) => s.refreshDocuments);
  const [qaEntries, setQaEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sectionFilter, setSectionFilter] = useState('');
  const [roundFilter, setRoundFilter] = useState('');
  const [tzFilter, setTzFilter] = useState('');
  const [search, setSearch] = useState('');
  const fileRef = useRef(null);
  const clauseTimers = useRef({});

  const load = async () => {
    if (!tenderId) return;
    setLoading(true);
    try {
      const q = await api.listQa(tenderId);
      setQaEntries(q.items || []);
    } catch (err) { toastError(err.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenderId]);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.uploadQa(tenderId, file);
      toastSuccess(`Загружено: ${result.qa_count} строк, ${result.sections_count} разделов`);
      if (fileRef.current) fileRef.current.value = '';
      await load();
      await Promise.all([refreshDocuments(), refreshTender()]);
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const handleAutoLink = async (overwrite) => {
    if (overwrite) {
      const ok = window.confirm('Перезаписать все ранее проставленные пункты ТЗ? Ручные правки будут потеряны.');
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.autoLinkQa(tenderId, { overwrite });
      toastSuccess(`Привязано: ${r.linked} из ${r.total} (пропущено ${r.skipped})`);
      await load();
    } catch (err) { toastError(err.message); }
    setBusy(false);
  };

  const patchEntry = async (entryId, patch) => {
    setQaEntries((rows) => rows.map((r) => (r.id === entryId ? { ...r, ...patch } : r)));
    try { await api.patchQaEntry(tenderId, entryId, patch); }
    catch (err) { toastError(err.message); load(); }
  };

  const toggleField = (entry, field) => patchEntry(entry.id, { [field]: entry[field] ? 0 : 1 });

  const onClauseChange = (entry, value) => {
    setQaEntries((rows) => rows.map((r) => (r.id === entry.id ? { ...r, tz_clause: value } : r)));
    clearTimeout(clauseTimers.current[entry.id]);
    clauseTimers.current[entry.id] = setTimeout(() => {
      api.patchQaEntry(tenderId, entry.id, { tz_clause: value }).catch((err) => toastError(err.message));
    }, 500);
  };

  const onDecisionChange = (entry, value) => {
    setQaEntries((rows) => rows.map((r) => (r.id === entry.id ? { ...r, accepted_decision: value } : r)));
    clearTimeout(clauseTimers.current['d_' + entry.id]);
    clauseTimers.current['d_' + entry.id] = setTimeout(() => {
      api.patchQaEntry(tenderId, entry.id, { accepted_decision: value }).catch((err) => toastError(err.message));
    }, 500);
  };

  const sections = useMemo(() => {
    const s = new Set();
    for (const q of qaEntries) if (q.section) s.add(q.section);
    return [...s].sort((a, b) => a.localeCompare(b, 'ru'));
  }, [qaEntries]);

  const rounds = useMemo(() => {
    const s = new Set();
    for (const q of qaEntries) if (q.round_label) s.add(q.round_label);
    return [...s];
  }, [qaEntries]);

  const stats = useMemo(() => {
    const t = { reflected: 0, contradicts: 0, calc: 0, kp: 0, contract: 0, schedule: 0, anyImpact: 0, linked: 0 };
    for (const q of qaEntries) {
      if (q.tz_clause && q.tz_clause.trim()) t.linked += 1;
      if (q.tz_reflected) t.reflected += 1;
      if (q.tz_contradicts) t.contradicts += 1;
      if (q.affects_calc) t.calc += 1;
      if (q.affects_kp) t.kp += 1;
      if (q.affects_contract) t.contract += 1;
      if (q.affects_schedule) t.schedule += 1;
      if (q.affects_calc || q.affects_kp || q.affects_contract || q.affects_schedule) t.anyImpact += 1;
    }
    return t;
  }, [qaEntries]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return qaEntries.filter((q) => {
      if (sectionFilter && q.section !== sectionFilter) return false;
      if (roundFilter && q.round_label !== roundFilter) return false;
      if (tzFilter === 'contradicts' && !q.tz_contradicts) return false;
      if (tzFilter === 'not_reflected' && (q.tz_reflected || !q.tz_clause)) return false;
      if (tzFilter === 'reflected' && !q.tz_reflected) return false;
      if (tzFilter === 'no_clause' && q.tz_clause) return false;
      if (needle) {
        const hay = `${q.question || ''} ${q.answer || ''} ${q.accepted_decision || ''} ${q.tz_clause || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [qaEntries, sectionFilter, roundFilter, tzFilter, search]);

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h3 className="font-semibold text-sm">Загрузка Q&A формы (.xlsx)</h3>
        <p className="text-xs text-gray-600 mt-1">
          Поддерживается формат «Форма ВОПРОС-ОТВЕТ»: «№ / Дата / Дата получения ответа / Раздел / Вопрос / Ответ / Принятые решения». Шапка распознаётся автоматически. Каждая загрузка <strong>полностью заменяет</strong> ранее загруженные строки (но <strong>сохраняет</strong> привязку к ТЗ и контуры по совпадающему вопросу — пока не реализовано).
        </p>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => handleUpload(e.target.files?.[0])}
            disabled={busy}
            className="block text-sm file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-brand-600 file:text-white file:cursor-pointer"
          />
          {busy && <span className="text-xs text-gray-500">Загрузка и парсинг…</span>}
        </div>
      </div>

      {qaEntries.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Всего вопросов" value={qaEntries.length} />
            <Stat label="Уникальных разделов" value={sections.length} />
            <Stat label="Отражено в ТЗ" value={stats.reflected} hint={`${stats.contradicts} противоречий`} />
            <Stat label="Влияют на КП/расчёт/договор/график" value={stats.anyImpact} hint={`Р${stats.calc} К${stats.kp} Д${stats.contract} Г${stats.schedule}`} />
          </div>
          <div className="card p-3 flex items-center justify-between flex-wrap gap-3">
            <div className="text-xs text-gray-600">
              <strong>Авто-привязка к ТЗ</strong> — анализатор сопоставляет вопрос/решение с текстом ТЗ и предлагает пункт. Привязки можно править вручную в таблице.
              <span className="block text-gray-500 mt-0.5">
                Привязано: <strong>{stats.linked}</strong> из {qaEntries.length} (
                <span className="text-gray-400">{qaEntries.length - stats.linked} без пункта</span>)
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn"
                onClick={() => handleAutoLink(false)}
                disabled={busy}
              >Привязать пустые</button>
              <button
                type="button"
                className="btn"
                onClick={() => handleAutoLink(true)}
                disabled={busy}
              >Перепривязать всё</button>
            </div>
          </div>
        </>
      )}

      <div>
        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
          <h4 className="font-semibold text-sm">
            Вопросы и ответы ({filtered.length}{filtered.length !== qaEntries.length ? ` из ${qaEntries.length}` : ''})
          </h4>
          {qaEntries.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <input
                type="text"
                placeholder="Поиск по тексту…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input w-56"
              />
              <select className="input" value={sectionFilter} onChange={(e) => setSectionFilter(e.target.value)}>
                <option value="">Все разделы ({sections.length})</option>
                {sections.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {rounds.length > 1 && (
                <select className="input" value={roundFilter} onChange={(e) => setRoundFilter(e.target.value)}>
                  <option value="">Все раунды ({rounds.length})</option>
                  {rounds.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <select className="input" value={tzFilter} onChange={(e) => setTzFilter(e.target.value)}>
                <option value="">Связь с ТЗ: любая</option>
                <option value="contradicts">⚠ Противоречит ТЗ</option>
                <option value="reflected">✓ Отражено</option>
                <option value="not_reflected">○ Не отражено (есть пункт ТЗ)</option>
                <option value="no_clause">— Без привязки к ТЗ</option>
              </select>
            </div>
          )}
        </div>
        {loading ? (
          <div className="text-center py-6 text-gray-500">Загрузка…</div>
        ) : qaEntries.length === 0 ? (
          <EmptyState
            title="Q&A не загружена"
            description="Загрузите xlsx с формой вопрос-ответ — ниже появится таблица переписки."
          />
        ) : filtered.length === 0 ? (
          <div className="card p-6 text-center text-gray-500 text-sm">Под фильтры не попало ни одной строки.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="table-head w-8">#</th>
                  <th className="table-head w-32">Раздел</th>
                  <th className="table-head min-w-[260px]">Вопрос</th>
                  <th className="table-head min-w-[220px]">Ответ Заказчика</th>
                  <th className="table-head min-w-[220px]">Решение СУ-10</th>
                  <th className="table-head min-w-[200px]">Связь с ТЗ</th>
                  <th className="table-head whitespace-nowrap">Контуры</th>
                  {rounds.length > 1 && <th className="table-head w-32">Раунд</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((q, i) => (
                  <tr key={q.id} className="border-t border-gray-100 align-top">
                    <td className="table-cell text-gray-400">{i + 1}</td>
                    <td className="table-cell text-gray-700 whitespace-nowrap">{q.section || '—'}</td>
                    <td className="table-cell whitespace-pre-wrap">{q.question || '—'}</td>
                    <td className="table-cell whitespace-pre-wrap text-gray-700">{q.answer || '—'}</td>
                    <td className="table-cell">
                      <textarea
                        className="input min-h-[60px] text-xs leading-snug"
                        value={q.accepted_decision || ''}
                        onChange={(e) => onDecisionChange(q, e.target.value)}
                        placeholder="—"
                      />
                    </td>
                    <td className="table-cell">
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          className="input text-xs"
                          placeholder="Пункт ТЗ (например: 3.1.1.3.9)"
                          value={q.tz_clause || ''}
                          onChange={(e) => onClauseChange(q, e.target.value)}
                        />
                        <div className="flex gap-1.5">
                          <Pill
                            on={!!q.tz_reflected}
                            onClick={() => toggleField(q, 'tz_reflected')}
                            color="green"
                            title="Отражено в ТЗ"
                          >
                            ✓ Отр
                          </Pill>
                          <Pill
                            on={!!q.tz_contradicts}
                            onClick={() => toggleField(q, 'tz_contradicts')}
                            color="red"
                            title="Противоречит ТЗ"
                          >
                            ⚠ Прт
                          </Pill>
                        </div>
                      </div>
                    </td>
                    <td className="table-cell">
                      <div className="flex gap-1">
                        {CONTOURS.map((c) => (
                          <Pill
                            key={c.key}
                            on={!!q[c.key]}
                            onClick={() => toggleField(q, c.key)}
                            color="blue"
                            title={c.title}
                          >
                            {c.short}
                          </Pill>
                        ))}
                      </div>
                    </td>
                    {rounds.length > 1 && (
                      <td className="table-cell text-gray-500 whitespace-nowrap">{q.round_label || '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NextStepCta hint="Q&A — рабочий узел: пометьте каждое решение «отражено / противоречит» и контуры влияния. Эти данные станут источником правок в ТЗ на Стадии 2." />
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="card p-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
      {hint && <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

const PILL_COLORS = {
  green: { on: 'bg-green-100 text-green-800 border-green-300', off: 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100' },
  red:   { on: 'bg-red-100 text-red-800 border-red-300',       off: 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100' },
  blue:  { on: 'bg-blue-100 text-blue-800 border-blue-300',    off: 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100' },
};

function Pill({ on, onClick, color, title, children }) {
  const c = PILL_COLORS[color] || PILL_COLORS.blue;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-1.5 py-0.5 rounded border text-[10px] font-medium leading-tight transition-colors ${on ? c.on : c.off}`}
    >
      {children}
    </button>
  );
}
