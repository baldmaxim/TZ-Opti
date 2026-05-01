'use strict';

const db = require('../../db/connection');
const { newId, nowIso } = require('../../utils/ids');
const { badRequest } = require('../../utils/errors');
const { getActiveTzText, getDocumentByType } = require('../tzActiveTextService');
const { runStage1 } = require('./stage1_checklistVor');
const { runStage2 } = require('./stage2_qaDecisions');
const { runStage3 } = require('./stage3_companyConditions');
const { runStage4 } = require('./stage4_risks');
const { runStage5 } = require('./stage5_selfAnalysis');
const { importQaXlsx } = require('../qaImportService');

const STAGE_LABELS = {
  1: 'ТЗ + Чек-лист + ВОР',
  2: 'Q&A → правки в ТЗ (решения СУ-10)',
  3: 'ТЗ + Существенные условия компании',
  4: 'ТЗ + Типовые риски',
  5: 'Самоанализ ТЗ (скрытые работы, двусмыслия, срок)',
};

async function getStageState(tenderId) {
  let state = await db.queryOne('SELECT * FROM tender_stage_state WHERE tender_id = ?', tenderId);
  if (!state) {
    await db.queryRun(
      `
      INSERT INTO tender_stage_state (tender_id, current_stage, stage1_status, stage2_status, stage3_status, stage4_status, stage5_status)
      VALUES (?, 1, 'open', 'locked', 'locked', 'locked', 'locked')
    `,
      tenderId,
    );
    state = await db.queryOne('SELECT * FROM tender_stage_state WHERE tender_id = ?', tenderId);
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

async function setStageStatus(tenderId, stage, status, runner = db) {
  const col = `stage${stage}_status`;
  await runner.queryRun(
    `UPDATE tender_stage_state SET ${col} = ?, current_stage = ? WHERE tender_id = ?`,
    status,
    stage,
    tenderId,
  );
}

async function unlockNextStage(tenderId, stage, runner = db) {
  if (stage >= 5) return;
  const nextCol = `stage${stage + 1}_status`;
  await runner.queryRun(
    `UPDATE tender_stage_state SET ${nextCol} = 'open', current_stage = ? WHERE tender_id = ?`,
    stage + 1,
    tenderId,
  );
}

async function buildContextForStage(tenderId, stage) {
  const { document: tzDoc, paragraphs, activeText, rawText } = await getActiveTzText(tenderId, stage);
  if (!tzDoc) {
    throw badRequest('В тендер не загружен документ типа «ТЗ» (doc_type=tz). Стадии анализа недоступны.');
  }
  const ctx = {
    tenderId,
    sourceDocumentId: tzDoc.id,
    paragraphs,
    activeText,
    rawText,
  };
  if (stage === 1) {
    const vorDoc = await getDocumentByType(tenderId, 'vor');
    ctx.vorText = vorDoc ? (vorDoc.extracted_text || '') : '';
    ctx.checklist = await db.queryAll('SELECT * FROM work_checklist_items WHERE tender_id = ?', tenderId);
  }
  if (stage === 2) {
    ctx.qaEntries = await db.queryAll('SELECT * FROM qa_entries WHERE tender_id = ? ORDER BY order_idx ASC', tenderId);
  }
  // Стадия 3 (Существенные условия) и Стадия 4 (Типовые риски) сами загружают
  // нужные данные из БД (company_conditions / risks_state) — отдельный
  // ctx-prefetch не требуется.
  return ctx;
}

function runStageOrchestrator(stage, ctx) {
  switch (stage) {
    case 1: return runStage1(ctx);
    case 2: return runStage2(ctx);
    case 3: return runStage3(ctx);
    case 4: return runStage4(ctx);
    case 5: return runStage5(ctx);
    default: throw badRequest('Допустимы стадии 1..5');
  }
}

async function runStage(tenderId, stage) {
  const state = await getStageState(tenderId);
  if (stage < 1 || stage > 5) throw badRequest('Допустимы стадии 1..5');
  if (!isStageRunnable(state, stage)) {
    throw badRequest(`Стадия ${stage} недоступна. Сначала завершите стадию ${stage - 1}.`);
  }
  if (stage === 2) {
    const qaCountRow = await db.queryOne('SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?', tenderId);
    let qaCount = Number(qaCountRow?.c || 0);
    if (!qaCount) {
      // qa_entries пуст — пробуем авто-импортировать из загруженного на вкладке
      // «Документация» Q&A-файла. Это типичный кейс: пользователь залил .xlsx,
      // но импорт по какой-то причине не отработал.
      const qaDoc = await db.queryOne(
        `SELECT * FROM documents
         WHERE tender_id = ? AND doc_type = 'qa'
         ORDER BY uploaded_at DESC LIMIT 1`,
        tenderId,
      );
      if (qaDoc?.file_path) {
        try {
          await importQaXlsx(tenderId, qaDoc.file_path);
          const recheck = await db.queryOne(
            'SELECT COUNT(*) as c FROM qa_entries WHERE tender_id = ?',
            tenderId,
          );
          qaCount = Number(recheck?.c || 0);
        } catch (e) {
          // ignore — попадаем в ошибку ниже с исходным текстом
        }
      }
    }
    if (!qaCount) {
      throw badRequest('Загрузите Q&A форму (.xlsx) на вкладке «Документация» — без переписки стадия 2 не запускается.');
    }
  }

  const ctx = await buildContextForStage(tenderId, stage);
  const issues = await runStageOrchestrator(stage, ctx);

  const runId = newId();
  const startedAt = nowIso();
  const summary = {
    stage,
    label: STAGE_LABELS[stage],
    issues_count: issues.length,
    by_criticality: countBy(issues, 'criticality'),
    by_problem_type: countBy(issues, 'problem_type'),
  };

  await db.transaction(async (tx) => {
    // Удаляем существующие незавершённые Issue этой стадии (повторный запуск)
    await tx.queryRun(
      `DELETE FROM issues WHERE tender_id = ? AND analysis_stage = ? AND review_status = 'pending'`,
      tenderId,
      stage,
    );

    await tx.queryRun(
      `
      INSERT INTO analysis_runs (id, tender_id, stage, started_at, finished_at, status, summary)
      VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `,
      runId,
      tenderId,
      stage,
      startedAt,
      nowIso(),
      JSON.stringify(summary),
    );

    for (const issue of issues) {
      await tx.queryRun(
        `
        INSERT INTO issues (
          id, tender_id, analysis_run_id, analysis_stage, source_document_id, source_clause,
          source_fragment, paragraph_index, char_start, char_end,
          problem_type, risk_category, criticality, price_impact, schedule_impact,
          basis, suggested_action, suggested_redaction, review_comment, confidence,
          review_status, selected_for_export
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1
        )
      `,
        newId(),
        tenderId,
        runId,
        stage,
        issue.source_document_id || null,
        issue.source_clause || null,
        issue.source_fragment || null,
        issue.paragraph_index ?? null,
        issue.char_start ?? null,
        issue.char_end ?? null,
        issue.problem_type || null,
        issue.risk_category || null,
        issue.criticality || 'medium',
        issue.price_impact || null,
        issue.schedule_impact || null,
        issue.basis || null,
        issue.suggested_action || 'comment',
        issue.suggested_redaction || null,
        issue.review_comment || null,
        issue.confidence ?? 0.6,
      );
    }

    await setStageStatus(tenderId, stage, 'reviewing', tx);
  });

  return { runId, summary };
}

async function finishStage(tenderId, stage) {
  const state = await getStageState(tenderId);
  const cur = state[`stage${stage}_status`];
  if (cur === 'locked') throw badRequest('Стадия залочена');
  if (cur === 'finished') throw badRequest('Стадия уже завершена');
  // Применяем tz_excluded_ranges для решений delete / remove_from_scope
  const closeIssues = await db.queryAll(
    `
      SELECT i.*, d.decision FROM issues i
      LEFT JOIN review_decisions d ON d.issue_id = i.id
      WHERE i.tender_id = ? AND i.analysis_stage = ?
    `,
    tenderId,
    stage,
  );

  await db.transaction(async (tx) => {
    for (const issue of closeIssues) {
      const isDelete = issue.review_status === 'accepted'
        && (issue.decision === 'delete' || issue.decision === 'remove_from_scope');
      if (isDelete && issue.paragraph_index != null && issue.char_start != null && issue.char_end != null) {
        await tx.queryRun(
          `
          INSERT INTO tz_excluded_ranges (id, tender_id, source_document_id, paragraph_index, char_start, char_end, after_stage, source_issue_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          newId(),
          tenderId,
          issue.source_document_id || null,
          issue.paragraph_index,
          issue.char_start,
          issue.char_end,
          stage,
          issue.id,
          nowIso(),
        );
      }
    }
    await setStageStatus(tenderId, stage, 'finished', tx);
    await unlockNextStage(tenderId, stage, tx);
  });
  return getStageState(tenderId);
}

async function resetStage(tenderId, stage) {
  // Каскадно сбрасываем стадии ≥ N
  await db.transaction(async (tx) => {
    const issuesToDelete = await tx.queryAll(
      'SELECT id FROM issues WHERE tender_id = ? AND analysis_stage >= ?',
      tenderId,
      stage,
    );
    const ids = issuesToDelete.map((r) => r.id);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      await tx.queryRun(`DELETE FROM review_decisions WHERE issue_id IN (${placeholders})`, ...ids);
      await tx.queryRun(`DELETE FROM tz_excluded_ranges WHERE source_issue_id IN (${placeholders})`, ...ids);
      await tx.queryRun(`DELETE FROM issues WHERE id IN (${placeholders})`, ...ids);
    }
    await tx.queryRun('DELETE FROM analysis_runs WHERE tender_id = ? AND stage >= ?', tenderId, stage);
    await tx.queryRun('DELETE FROM tz_excluded_ranges WHERE tender_id = ? AND after_stage >= ?', tenderId, stage);

    // Возвращаем статусы
    for (let s = stage; s <= 5; s += 1) {
      const status = s === stage ? 'open' : 'locked';
      await tx.queryRun(`UPDATE tender_stage_state SET stage${s}_status = ? WHERE tender_id = ?`, status, tenderId);
    }
    await tx.queryRun('UPDATE tender_stage_state SET current_stage = ? WHERE tender_id = ?', stage, tenderId);
  });
  return getStageState(tenderId);
}

async function listStageIssues(tenderId, stage, filters = {}) {
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
  return db.queryAll(sql, ...params);
}

async function getStageRunSummary(tenderId, stage) {
  const run = await db.queryOne(
    'SELECT * FROM analysis_runs WHERE tender_id = ? AND stage = ? ORDER BY started_at DESC LIMIT 1',
    tenderId,
    stage,
  );
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
