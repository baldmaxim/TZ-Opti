import { useEffect, useRef, useState } from 'react';

// Ключ времени старта анализа в localStorage. Сервер НЕ пишет analysis_runs для
// идущего прогона, поэтому момент старта запоминает клиент: store.runStage ставит
// его при запуске, а здесь он читается. Переживает перезагрузку вкладки.
export function analysisStartKey(tenderId, stage) {
  return `tz-opti.analysis-start.${tenderId}.${stage}`;
}

// Грубая оценка длительности по стадиям (мс) — ТОЛЬКО для текстовой подсказки
// «≈ N мин». Прогресс-кольцо по ней НЕ заполняется (это и был баг: реальный прогон
// короче/длиннее оценки). Реальный сигнал — progress.{total,done} с сервера.
const STAGE_ESTIMATE_MS = {
  1: 12 * 60 * 1000,
  2: 9 * 60 * 1000,
  3: 9 * 60 * 1000,
  4: 10 * 60 * 1000,
  5: 8 * 60 * 1000,
};
const DEFAULT_ESTIMATE_MS = 10 * 60 * 1000;

// progress: { total, done, startedAt } | null — реальный прогресс по сегментам с
// сервера (см. progressRegistry). Если total>1 — рисуем детерминированное кольцо
// done/total. Иначе (один сегмент: стадии 2/3, или прогресс ещё не пришёл) —
// честная индетерминированная анимация с таймером, БЕЗ ложных процентов.
export default function AnalysisProgressRing({ tenderId, stage, size = 132, progress = null }) {
  const estimate = STAGE_ESTIMATE_MS[stage] || DEFAULT_ESTIMATE_MS;

  // Момент старта (клиентские часы) — для таймера. Из localStorage; если ключа нет
  // (анализ начат до фичи / в другой вкладке) — берём «сейчас» и пишем.
  const startMs = useRef(null);
  if (startMs.current == null) {
    const key = analysisStartKey(tenderId, stage);
    const saved = Number(localStorage.getItem(key));
    if (saved > 0) {
      startMs.current = saved;
    } else {
      startMs.current = Date.now();
      try { localStorage.setItem(key, String(startMs.current)); } catch { /* ignore */ }
    }
  }

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, now - startMs.current);
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const timer = `${mins}:${String(secs).padStart(2, '0')}`;

  const total = progress?.total || 0;
  const done = progress?.done || 0;
  // Детерминированный режим только когда сегментов реально больше одного.
  const determinate = total > 1;
  // Никогда не показываем 100% до фактического завершения (кольцо исчезнет по
  // смене статуса) — кап на 99%.
  const frac = determinate ? Math.min(0.99, done / total) : 0;
  const display = Math.round(frac * 100);

  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div className="flex items-center gap-5 rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        {determinate ? (
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke="currentColor" strokeWidth={stroke}
              className="text-blue-100"
            />
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
              className="text-blue-600"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - frac)}
              style={{ transition: 'stroke-dashoffset 0.5s linear' }}
            />
          </svg>
        ) : (
          // Индетерминированная вращающаяся дуга (~28% окружности) — честный
          // «идёт работа» без обещания конкретного процента.
          <svg
            width={size} height={size}
            className="absolute inset-0 animate-spin"
            style={{ animationDuration: '1.4s' }}
          >
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke="currentColor" strokeWidth={stroke}
              className="text-blue-100"
            />
            <circle
              cx={size / 2} cy={size / 2} r={r}
              fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
              className="text-blue-600"
              strokeDasharray={`${c * 0.28} ${c * 0.72}`}
            />
          </svg>
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {determinate ? (
            <>
              <span className="text-3xl font-semibold text-blue-700 tabular-nums leading-none">
                {display}%
              </span>
              <span className="text-[11px] text-gray-500 tabular-nums mt-1">
                {done}/{total} · {timer}
              </span>
            </>
          ) : (
            <>
              <span className="text-2xl font-semibold text-blue-700 tabular-nums leading-none">
                {timer}
              </span>
              <span className="text-[11px] text-gray-400 mt-1">мин:сек</span>
            </>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="font-medium text-blue-700 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Идёт анализ…
        </div>
        <div className="text-xs text-gray-500 mt-1.5 max-w-[280px]">
          {determinate
            ? `Обработка по частям: ${done} из ${total}. Анализ идёт в фоне — можно закрыть вкладку, результат появится сам.`
            : `Оценка ≈${Math.round(estimate / 60000)} мин (приблизительно). Анализ идёт в фоне — можно закрыть вкладку, результат появится сам.`}
        </div>
      </div>
    </div>
  );
}
