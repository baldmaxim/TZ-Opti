'use strict';

const db = require('../db/connection');
const { newId, nowIso } = require('../utils/ids');
const { badRequest, notFound } = require('../utils/errors');

const ALLOWED_DECISIONS = ['accept', 'reject', 'edit', 'delete', 'remove_from_scope'];

const PATCHABLE = ['review_status', 'edited_redaction', 'manually_edited', 'selected_for_export', 'review_comment'];

function getIssue(id) {
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
}

function getDecision(issueId) {
  return db.prepare('SELECT * FROM review_decisions WHERE issue_id = ? ORDER BY decided_at DESC LIMIT 1').get(issueId);
}

exports.patchIssue = (req, res) => {
  const issue = getIssue(req.params.id);
  if (!issue) throw notFound('Issue не найден');
  const body = req.body || {};
  const updates = {};
  for (const f of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      if (f === 'manually_edited' || f === 'selected_for_export') {
        updates[f] = body[f] ? 1 : 0;
      } else {
        updates[f] = body[f];
      }
    }
  }
  if (!Object.keys(updates).length) return res.json({ ...issue, decision: getDecision(issue.id) });
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE issues SET ${sets} WHERE id = ?`).run(...Object.values(updates), issue.id);
  res.json({ ...getIssue(issue.id), decision: getDecision(issue.id) });
};

exports.makeDecision = (req, res) => {
  const issue = getIssue(req.params.id);
  if (!issue) throw notFound('Issue не найден');
  const { decision, edited_redaction, final_comment } = req.body || {};
  if (!ALLOWED_DECISIONS.includes(decision)) {
    throw badRequest('Допустимые решения: ' + ALLOWED_DECISIONS.join(', '));
  }

  const reviewStatus = (() => {
    if (decision === 'reject') return 'rejected';
    if (decision === 'edit') return 'edited';
    return 'accepted';
  })();

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM review_decisions WHERE issue_id = ?').run(issue.id);
    db.prepare(`
      INSERT INTO review_decisions (id, issue_id, decision, edited_redaction, final_comment, decided_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      newId(),
      issue.id,
      decision,
      edited_redaction || null,
      final_comment || null,
      nowIso()
    );
    const updates = ['review_status = ?'];
    const params = [reviewStatus];
    if (edited_redaction !== undefined) {
      updates.push('edited_redaction = ?'); params.push(edited_redaction);
      updates.push('manually_edited = ?'); params.push(edited_redaction ? 1 : 0);
    }
    params.push(issue.id);
    db.prepare(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  });
  tx();

  res.json({ ...getIssue(issue.id), decision: getDecision(issue.id) });
};
