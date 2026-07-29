// Карточка выбранного замечания (правая панель). Порядок блоков фиксирован ТЗ:
// что обнаружено → влияние на ГП → предлагаемое действие → точная цитата →
// основание и источник → квалификация gate → причины gate → недостающие данные.
// Вторичные технические поля (score breakdown, сигналы, критик, id) — в
// раскрываемом блоке «Почему ИИ так решил». Быстрые действия — внизу.

import { useState } from 'react';
import {
  CRITICALITY,
  CRITIC_OUTCOMES,
  CRITIC_SOURCES,
  EVIDENCE_LEVELS,
  IMPACT_LEVELS,
  REQUIRED_ACTIONS,
  VERDICTS,
  formatDimensions,
  formatProblemType,
  impactClass,
  verdictClass,
} from '../../utils/labels';
import { clusterTopic, formatTzClause, humanizeNote, occurrenceNote, otherOccurrences } from '../../utils/format';
import {
  GATE_QUALIFICATIONS,
  GATE_QUALIFICATION_CLASSES,
  MISSING_REQUIREMENT_LABELS,
  REASON_LABELS,
  SHADOW_DECISION_LABELS,
} from '../../utils/reviewBoard';

const STATE_BADGE = {
  accepted: { label: 'Принято', cls: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' },
  rejected: { label: 'Отклонено', cls: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300' },
  deferred: { label: 'На проверку', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300' },
  merged: { label: 'Объединено', cls: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300' },
};

function Section({ title, children }) {
  return (
    <div>
      <div className="label">{title}</div>
      {children}
    </div>
  );
}

// Главный (наиболее значимый) элемент кластера — краткое основание и цитата.
function pickPrimaryItem(items = []) {
  return items.find((it) => it.item_role === 'primary') || items[0] || null;
}

export default function FindingCard({
  cluster,
  index,
  total,
  gate,
  state,
  quoteFound,
  busy,
  onAction,
  onNavigate,
}) {
  const [whyOpen, setWhyOpen] = useState(false);

  if (!cluster) return null;

  const items = cluster.items || [];
  const primary = pickPrimaryItem(items);
  const quote = cluster.representative_fragment || (primary && primary.source_fragment) || '';
  const clause = formatTzClause(cluster.tz_clause);
  const dimensions = formatDimensions(cluster.impact_dimensions);
  const description = humanizeNote((primary && primary.basis) || cluster.merged_basis || '—');
  const aiVariant = humanizeNote(cluster.merged_recommendation || '');
  const repeated = occurrenceNote(cluster);
  const occurrences = otherOccurrences(cluster);
  const reason = cluster.publication_reason || cluster.suppression_reason || '';
  const stateBadge = state ? STATE_BADGE[state] : null;
  const engineerShadow = gate && gate.engineer_decision;
  const missing = (gate && gate.missing_requirements) || [];
  const gateReasons = (gate && gate.reasons) || [];

  return (
    <div className="card p-4 space-y-3 overflow-y-auto min-h-0">
      {/* Шапка: позиция, вердикт, влияние, тема, статус решения */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
          №{index + 1} <span className="font-normal text-gray-400">из {total}</span>
        </span>
        {cluster.verdict && (
          <span className={`tag ${verdictClass(cluster.verdict)}`}>
            {VERDICTS[cluster.verdict] || cluster.verdict}
          </span>
        )}
        <span className={`tag ${impactClass(cluster.overall_impact_level || cluster.overall_criticality)}`}>
          {IMPACT_LEVELS[cluster.overall_impact_level]
            || CRITICALITY[cluster.overall_criticality]
            || 'Уровень не оценён'}
        </span>
        {stateBadge && <span className={`tag ${stateBadge.cls}`}>Решение: {stateBadge.label}</span>}
      </div>

      {/* 1. Что обнаружено */}
      <Section title="Что обнаружено">
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{clusterTopic(cluster)}</div>
        <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap mt-0.5">{description}</div>
      </Section>

      {/* 2. Влияние на Генподрядчика */}
      <Section title="Влияние на Генподрядчика">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {dimensions.length
            ? dimensions.map((d) => (
              <span key={d} className="tag bg-brand-50 dark:bg-brand-900/30 text-brand-800 dark:text-brand-200">{d}</span>
            ))
            : <span className="text-gray-500 dark:text-gray-400">Измерения влияния не указаны</span>}
          {cluster.overall_evidence_level && (
            <span className="text-gray-600 dark:text-gray-400">
              {EVIDENCE_LEVELS[cluster.overall_evidence_level] || cluster.overall_evidence_level}
            </span>
          )}
        </div>
        {reason && <div className="text-xs text-gray-500 dark:text-gray-400 italic mt-0.5">{reason}</div>}
      </Section>

      {/* 3. Предлагаемое действие */}
      <Section title="Предлагаемое действие">
        {cluster.required_action && cluster.required_action !== 'none' && (
          <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
            {REQUIRED_ACTIONS[cluster.required_action] || cluster.required_action}
          </div>
        )}
        <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
          {aiVariant || 'ИИ не предложил конкретной правки.'}
        </div>
      </Section>

      {/* 4. Точная цитата */}
      <Section title="Точная цитата">
        {clause && <div className="text-xs text-gray-500 dark:text-gray-400">{clause}</div>}
        {quote ? (
          <div className="mt-1 p-2.5 bg-gray-50 dark:bg-gray-800 border-l-2 border-gray-300 dark:border-gray-600 rounded text-sm text-gray-700 dark:text-gray-300 italic whitespace-pre-wrap max-h-40 overflow-y-auto">
            «{quote}»
          </div>
        ) : (
          <div className="mt-1 text-xs px-2 py-1 rounded bg-red-50 dark:bg-red-900/40 text-red-800 dark:text-red-300">
            У замечания нет дословной цитаты ТЗ — проверьте его особенно внимательно.
          </div>
        )}
        {quote && !quoteFound && (
          <div className="mt-1 text-xs px-2 py-1 rounded bg-red-50 dark:bg-red-900/40 text-red-800 dark:text-red-300">
            Цитата не найдена в текущем тексте ТЗ.
          </div>
        )}
        {repeated && (
          <details className="mt-1">
            <summary className="text-xs text-brand-600 cursor-pointer hover:underline">{repeated}</summary>
            <ul className="mt-1 space-y-1 max-h-36 overflow-y-auto">
              {occurrences.map((e, i) => (
                <li key={e.draft_issue_id || i} className="text-xs text-gray-600 dark:text-gray-400 border-l-2 border-gray-200 dark:border-gray-700 pl-2">
                  {e.tz_clause && <div className="text-gray-500">{formatTzClause(e.tz_clause)}</div>}
                  {e.fragment && <div className="italic whitespace-pre-wrap">«{e.fragment}»</div>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      {/* 5. Основание и источник */}
      <Section title="Основание и источник">
        <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
          {humanizeNote(cluster.merged_basis) || '—'}
        </div>
        <div className="flex flex-wrap gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
          {cluster.final_problem_type && <span>{formatProblemType(cluster.final_problem_type)}</span>}
          {primary && primary.category && <span>[{primary.category}]</span>}
          {gate && Array.isArray(gate.source_stages) && gate.source_stages.length > 0 && (
            <span>Источник: стадия {gate.source_stages.join(', ')}</span>
          )}
        </div>
      </Section>

      {/* 6. Квалификация gate (shadow: рекомендация, не решение) */}
      <Section title="Квалификация gate">
        {gate ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`tag ${GATE_QUALIFICATION_CLASSES[gate.qualification] || ''}`}>
                {GATE_QUALIFICATIONS[gate.qualification] || gate.qualification}
              </span>
              {gate.proposed_priority && (
                <span className="text-gray-600 dark:text-gray-400">
                  Предлагаемый приоритет: {CRITICALITY[gate.proposed_priority] || gate.proposed_priority}
                </span>
              )}
              {engineerShadow && (
                <span className="text-gray-600 dark:text-gray-400">
                  Ваше решение: {SHADOW_DECISION_LABELS[engineerShadow.decision] || engineerShadow.decision}
                  {engineerShadow.reason_code ? ` (${REASON_LABELS[engineerShadow.reason_code] || engineerShadow.reason_code})` : ''}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500">
              Gate работает в shadow-режиме: это рекомендация, окончательное решение — за инженером.
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400">Gate не оценивал это замечание.</div>
        )}
      </Section>

      {/* 7. Причины решения gate */}
      {gate && gateReasons.length > 0 && (
        <Section title="Причины решения gate">
          <ul className="list-disc list-inside text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
            {gateReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Section>
      )}

      {/* 8. Недостающие данные */}
      {gate && missing.length > 0 && (
        <Section title="Недостающие данные">
          <ul className="list-disc list-inside text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
            {missing.map((m, i) => <li key={i}>{MISSING_REQUIREMENT_LABELS[m] || m}</li>)}
          </ul>
        </Section>
      )}

      {/* 9. Вторичные технические данные — свёрнуты */}
      <div className="border-t dark:border-gray-700 pt-2">
        <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setWhyOpen((v) => !v)}>
          {whyOpen ? '▾ Скрыть' : '▸ Почему ИИ так решил'} (score, сигналы стадий, критик)
        </button>
        {whyOpen && (
          <div className="mt-2 space-y-2 text-xs">
            {gate && (
              <div className="p-2 rounded bg-gray-50 dark:bg-gray-800 border dark:border-gray-700 space-y-1">
                <div className="text-gray-500 dark:text-gray-400">
                  Gate: правило {gate.rule_key || '—'}
                  {gate.confidence != null ? ` · confidence ${gate.confidence}` : ''}
                  {gate.evidence_strength ? ` · доказательность ${gate.evidence_strength}` : ''}
                  {gate.gate_version ? ` · версия ${gate.gate_version}` : ''}
                </div>
                {gate.score_breakdown && Object.keys(gate.score_breakdown).length > 0 && (
                  <div className="font-mono text-[10px] text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-all">
                    {JSON.stringify(gate.score_breakdown)}
                  </div>
                )}
              </div>
            )}
            <div className="text-gray-400 dark:text-gray-500 font-mono break-all">
              {cluster.cluster_key && <div>cluster_key: {cluster.cluster_key}</div>}
              {cluster.semantic_bucket && <div>bucket: {cluster.semantic_bucket}</div>}
              {cluster.work_object && <div>work_object: {cluster.work_object}</div>}
            </div>
            <div className="space-y-1.5">
              {items.map((it) => (
                <div key={it.draft_issue_id} className="border dark:border-gray-700 rounded p-2 bg-white dark:bg-gray-800">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5 text-[11px]">
                    <span className={`tag text-[10px] ${it.item_role === 'primary' ? 'bg-brand-100 text-brand-800' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                      {it.item_role === 'primary' ? 'основной' : 'связанный'}
                    </span>
                    {it.problem_type && <span className="text-gray-600 dark:text-gray-400">{formatProblemType(it.problem_type)}</span>}
                    {it.impact_level && (
                      <span className="text-gray-500 dark:text-gray-400">
                        {IMPACT_LEVELS[it.impact_level] || it.impact_level}
                      </span>
                    )}
                    {(it.critic_outcome || it.critic_source) && (
                      <span className="text-gray-400 dark:text-gray-500">
                        {CRITIC_OUTCOMES[it.critic_outcome] || 'Критиком не решено'}
                        {it.critic_source ? ` (${CRITIC_SOURCES[it.critic_source] || it.critic_source})` : ''}
                      </span>
                    )}
                  </div>
                  {it.basis && <div className="text-gray-700 dark:text-gray-300">{humanizeNote(it.basis)}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 10. Быстрые действия. Хоткеи: A / E / R / V, стрелки — навигация. */}
      <div className="border-t dark:border-gray-700 pt-2 space-y-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary text-xs" disabled={busy} onClick={() => onAction('accept')} title="Горячая клавиша: A">
            Принять <kbd className="ml-1 opacity-60">A</kbd>
          </button>
          <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('edit')} title="Горячая клавиша: E">
            Принять с изменением <kbd className="ml-1 opacity-60">E</kbd>
          </button>
          <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('reject')} title="Горячая клавиша: R">
            Отклонить <kbd className="ml-1 opacity-60">R</kbd>
          </button>
          <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('defer')} title="Горячая клавиша: V">
            На проверку <kbd className="ml-1 opacity-60">V</kbd>
          </button>
          <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('merge')}>
            Объединить
          </button>
          <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('priority')}>
            Изменить приоритет
          </button>
        </div>
        <details>
          <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:underline">
            Действия с текстом ТЗ (для экспорта в Word)
          </summary>
          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('remove_from_scope')}>
              Вынести из объёма ГП
            </button>
            <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => onAction('delete')}>
              Удалить из ТЗ
            </button>
          </div>
        </details>
        <div className="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
          <button type="button" className="hover:text-gray-600 dark:hover:text-gray-300" onClick={() => onNavigate(-1)}>
            ← Предыдущее
          </button>
          <span>Стрелки ←/→ — навигация</span>
          <button type="button" className="hover:text-gray-600 dark:hover:text-gray-300" onClick={() => onNavigate(1)}>
            Следующее →
          </button>
        </div>
      </div>
    </div>
  );
}
