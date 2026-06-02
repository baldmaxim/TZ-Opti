import { useEffect, useRef, useState } from 'react';

// Ключ времени старта анализа в localStorage. Сервер НЕ пишет analysis_runs для
// идущего прогона (started_at появляется только по завершении), поэтому момент
// старта запоминает клиент: store.runStage ставит его при запуске, а здесь он
// читается. Переживает перезагрузку вкладки во время 15-мин анализа.
export function analysisStartKey(tenderId, stage) {
  return `tz-opti.analysis-start.${tenderId}.${stage}`;
}

// Оценка длительности анализа по стадиям (мс). Реального прогресса с сервера нет
// (стадия считается в фоне, статус только running/done), поэтому шкала
// заполняется ПО ВРЕМЕНИ: асимптотически приближается к 95% к оценке и НИКОГДА
// не достигает 100% до фактического завершения — чтобы не врать о готовности.
const STAGE_ESTIMATE_MS = {
  1: 12 * 60 * 1000,
  2: 9 * 60 * 1000,
  3: 9 * 60 * 1000,
  4: 10 * 60 * 1000,
  5: 8 * 60 * 1000,
};
const DEFAULT_ESTIMATE_MS = 10 * 60 * 1000;

export default function AnalysisProgressRing({ tenderId, stage, size = 132 }) {
  const estimate = STAGE_ESTIMATE_MS[stage] || DEFAULT_ESTIMATE_MS;

  // Момент старта: из localStorage (выставлен store.runStage); если ключа нет
  // (анализ начат до этой фичи / в другой вкладке) — берём «сейчас» и пишем.
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
  // Кривая заполнения: ~76% к оценке, ~91% к 2×оценке, асимптота 95%.
  const pct = Math.min(95, 95 * (1 - Math.exp((-1.6 * elapsed) / estimate)));
  const display = Math.round(pct);

  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);

  return (
    <div className="flex items-center gap-5 rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="text-blue-100"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            className="text-blue-600"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.5s linear' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold text-blue-700 tabular-nums leading-none">
            {display}%
          </span>
          <span className="text-[11px] text-gray-400 tabular-nums mt-1">
            {mins}:{String(secs).padStart(2, '0')}
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="font-medium text-blue-700 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Идёт анализ…
        </div>
        <div className="text-xs text-gray-500 mt-1.5 max-w-[280px]">
          Оценка ~{Math.round(estimate / 60000)} мин. Шкала приблизительная —
          анализ идёт в фоне. Можно закрыть вкладку, результат появится сам.
        </div>
      </div>
    </div>
  );
}
