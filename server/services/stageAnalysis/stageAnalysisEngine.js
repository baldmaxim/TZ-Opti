'use strict';

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const { getActiveTzText, getDocumentByType } = require('../tzActiveTextService');
const { runStage1 } = require('./stage1_checklistVor');
const { runStage2 } = require('./stage2_characteristics');
const { runStage3 } = require('./stage3_risks');
const { runStage4 } = require('./stage4_selfAnalysis');

const STAGE_LABELS = {
  1: 'ТЗ + Чек-лист + ВОР',
  2: 'ТЗ + Q&A форма (Таблица характеристик)',
  3: 'ТЗ + Типовые риски',
  4: 'Самоанализ ТЗ (скрытые работы, двусмыслия, срок)',
};

function getStageState(tenderId) {
  let state = db.prepare('SELECT * FROM tender_stage_state WHERE tender_id = ?').get(tenderId);
  if (!state) {
    db.prepare(`
      INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status)
      VALUES (?, 1, 'open', 'locked', 'locked', 'locked')
    `).run(tenderId);
    state = db.prepare('SELECT * FROM tender_stage_state WHERE tender_id = ?').get(tenderId);
  }
  return state;
}

function isStageRunnable(state, stage) {
  if (stage === 1) return ['open', 'running', 'reviewing'].includes(state.stage1_status);
  const prevKey = `stage${stage - 1}_status`;
  if (state[prevKey] !== 'finished') return false;
  const cur = state[`stage${stage}_status`];
  return cur !== 'finished';
}

function setStageStatus(tenderId, stage, status) {
  const col = `stage${stage}_status`;
  db.prepare(`UPDATE tender_stage_state SET ${col} = ?, current_stage = ? WHERE tender_id = ?`).run(
    status,
    stage,
    tenderId
  );
}

function unlockNextStage(tenderId, stage) {
  if (stage >= 4) return;
  const nextCol = `stage${stage + 1}_status`;
  db.prepare(`UPDATE tender_stage_state SET ${nextCol} = 'open', current_stage = ? WHERE tender_id = ?`).run(
    stage + 1,
    tenderId
  );
}

function buildContextForStage(tenderId, stage) {
  const { document: tzDoc, paragraphs, activeText } = getActiveTzText(tenderId, stage);
  if (!tzDoc) {
    throw badRequest('В тендер не загружен документ типа «ТЗ» (doc_type=tz). Стадии анализа недоступны.');
  }
  const ctx = {
    tenderId,
    sourceDocumentId: tzDoc.id,
    paragraphs,
    activeText,
  };
  if (stage === 1) {
    const vorDoc = getDocumentByType(tenderId, 'vor');
    ctx.vorText = vorDoc ? (vorDoc.extracted_text || '') : '';
    ctx.checklist = db.prepare('SELECT * FROM work_checklist_items WHERE tender_id = ?').all(tenderId);
  }
  if (stage === 2) {
    ctx.characteristics = db.prepare('SELECT * FROM characteristics WHERE tender_id = ?').all(tenderId);
  }
  if (stage === 3) {
    ctx.riskTemplates = db
      .prepare('SELECT * FROM risk_templates WHERE tender_id = ? OR is_global = 1')
      .all(tenderId);
  }
  return ctx;
}

function runStageOrchestrator(stage, ctx) {
  switch (stage) {
    case 1: return runStage1(ctx);
    case 2: return runStage2(ctx);
    case 3: return runStage3(ctx);
    case 4: return runStage4(ctx);
    default: throw badRequest('Допустимы стадии 1..4');
  }
}

function runStage(tenderId, stage) {
  const state = getStageState(tenderId);
  if (stage < 1 || stage > 4) throw badRequest('Допустимы стадии 1..4');
  if (!isStageRunnable(state, stage)) {
    throw badRequest(`Стадия ${stage} недоступна. Сначала завершите стадию ${stage - 1}.`);
  }
  if (stage === 2) {
    const qaCount = db.prepare('SELECT COUNT(*) as c FROM characteristics WHERE tender_id = ?').get(tenderId).c;
    if (!qaCount) {
      throw badRequest('Загрузите Q&A форму (.xlsx) — таблица характеристик пуста.');
    }
  }

  const ctx = buildContextForStage(tenderId, stage);
  const issues = runStageOrchestrator(stage, ctx);

  const runId = newId();
  const startedAt = nowIso();
  const summary = {
    stage,
    label: STAGE_LABELS[stage],
    issues_count: issues.length,
    by_criticality: countBy(issues, 'criticality'),
    by_problem_type: countBy(issues, 'problem_type'),
  };

  const tx = db.transaction(() => {
    // Удаляем существующие незавершённые Issue этой стадии (повторный запуск)
    db.prepare(`
      DELETE FROM issues WHERE tender_id = ? AND analysis_stage = ?
        AND review_status = 'pending'
    `).run(tenderId, stage);

    db.prepare(`
      INSERT INTO analysis_runs (id, tender_id, stage, started_at, finished_at, status, summary)
      VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `).run(runId, tenderId, stage, startedAt, nowIso(), JSON.stringify(summary));

    const ins = db.prepare(`
      INSERT INTO issues (
        id, tender_id, analysis_run_id, analysis_stage, source_document_id, source_clause,
        source_fragment, paragraph_index, char_start, char_end,
        problem_type, risk_category, criticality, price_impact, schedule_impact,
        basis, suggested_action, suggested_redaction, review_comment, confidence,
        review_status, selected_for_export
      ) VALUES (
        @id, @tender_id, @analysis_run_id, @analysis_stage, @source_document_id, @source_clause,
        @source_fragment, @paragraph_index, @char_start, @char_end,
        @problem_type, @risk_category, @criticality, @price_impact, @schedule_impact,
        @basis, @suggested_action, @suggested_redaction, @review_comment, @confidence,
        'pending', 1
      )
    `);
    for (const issue of issues) {
      ins.run({
        id: newId(),
        tender_id: tenderId,
        analysis_run_id: runId,
        analysis_stage: stage,
        source_document_id: issue.source_document_id || null,
        source_clause: issue.source_clause || null,
        source_fragment: issue.source_fragment || null,
        paragraph_index: issue.paragraph_index ?? null,
        char_start: issue.char_start ?? null,
        char_end: issue.char_end ?? null,
        problem_type: issue.problem_type || null,
        risk_category: issue.risk_category || null,
        criticality: issue.criticality || 'medium',
        price_impact: issue.price_impact || null,
        schedule_impact: issue.schedule_impact || null,
        basis: issue.basis || null,
        suggested_action: issue.suggested_action || 'comment',
        suggested_redaction: issue.suggested_redaction || null,
        review_comment: issue.review_comment || null,
        confidence: issue.confidence ?? 0.6,
      });
    }
    setStageStatus(tenderId, stage, 'reviewing');
  });
  tx();

  return { runId, summary };
}

function finishStage(tenderId, stage) {
  const state = getStageState(tenderId);
  const cur = state[`stage${stage}_status`];
  if (cur === 'locked') throw badRequest('Стадия залочена');
  if (cur === 'finished') throw badRequest('Стадия уже завершена');
  // Применяем tz_excluded_ranges для решений delete / remove_from_scope
  const closeIssues = db
    .prepare(`
      SELECT i.*, d.decision FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.analysis_stage = ?
    `)
    .all(tenderId, stage);

  const tx = db.transaction(() => {
    const insExcl = db.prepare(`
      INSERT INTO tz_excluded_ranges (id, tender_id, source_document_id, paragraph_index, char_start, char_end, after_stage, source_issue_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const issue of closeIssues) {
      const isDelete = issue.review_status === 'accepted'
        && (issue.decision === 'delete' || issue.decision === 'remove_from_scope');
      if (isDelete && issue.paragraph_index != null && issue.char_start != null && issue.char_end != null) {
        insExcl.run(
          newId(),
          tenderId,
          issue.source_document_id || null,
          issue.paragraph_index,
          issue.char_start,
          issue.char_end,
          stage,
          issue.id,
          nowIso()
        );
      }
    }
    setStageStatus(tenderId, stage, 'finished');
    unlockNextStage(tenderId, stage);
  });
  tx();
  return getStageState(tenderId);
}

function resetStage(tenderId, stage) {
  // Каскадно сбрасываем стадии ≥ N
  const tx = db.transaction(() => {
    const issuesToDelete = db
      .prepare('SELECT id FROM issues WHERE tender_id = ? AND analysis_stage >= ?')
      .all(tenderId, stage);
    const ids = issuesToDelete.map((r) => r.id);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM review_decisions WHERE issue_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM tz_excluded_ranges WHERE source_issue_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM issues WHERE id IN (${placeholders})`).run(...ids);
    }
    db.prepare('DELETE FROM analysis_runs WHERE tender_id = ? AND stage >= ?').run(tenderId, stage);
    db.prepare('DELETE FROM tz_excluded_ranges WHERE tender_id = ? AND after_stage >= ?').run(tenderId, stage);

    // Возвращаем статусы
    for (let s = stage; s <= 4; s++) {
      const status = s === stage ? 'open' : 'locked';
      db.prepare(`UPDATE tender_stage_state SET stage${s}_status = ? WHERE tender_id = ?`).run(status, tenderId);
    }
    db.prepare('UPDATE tender_stage_state SET current_stage = ? WHERE tender_id = ?').run(stage, tenderId);
  });
  tx();
  return getStageState(tenderId);
}

function listStageIssues(tenderId, stage, filters = {}) {
  let sql = `
    SELECT i.*, d.decision as decision_kind, d.final_comment as decision_comment, d.edited_redaction as decision_redaction
    FROM issues i
    LEFT JOIN review_decisions d ON d.issue_id = i.id
    WHERE i.tender_id = ? AND i.analysis_stage = ?
  `;
  const params = [tenderId, stage];
  if (filters.criticality) { sql += ' AND i.criticality = ?'; params.push(filters.criticality); }
  if (filters.review_status) { sql += ' AND i.review_status = ?'; params.push(filters.review_status); }
  if (filters.problem_type) { sql += ' AND i.problem_type = ?'; params.push(filters.problem_type); }
  sql += ' ORDER BY i.criticality DESC, i.paragraph_index ASC, i.char_start ASC';
  return db.prepare(sql).all(...params);
}

function getStageRunSummary(tenderId, stage) {
  const run = db
    .prepare('SELECT * FROM analysis_runs WHERE tender_id = ? AND stage = ? ORDER BY started_at DESC LIMIT 1')
    .get(tenderId, stage);
  if (!run) return null;
  let summary = null;
  try { summary = run.summary ? JSON.parse(run.summary) : null; } catch (_e) { summary = null; }
  return { ...run, summary };
}

function countBy(arr, key) {
  const out = {};
  for (const i of arr) {
    const v = i[key] || '—';
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

module.exports = {
  STAGE_LABELS,
  getStageState,
  runStage,
  finishStage,
  resetStage,
  listStageIssues,
  getStageRunSummary,
};
