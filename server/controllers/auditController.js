'use strict';

// Чтение журнала аудита. Тенант НЕ берётся из запроса — только из токена:
// иначе «журнал своей организации» превращался бы в журнал любой.

const audit = require('../services/audit/auditService');
const { badRequest } = require('../utils/errors');

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

exports.list = async (req, res) => {
  const q = req.query || {};
  for (const key of ['since', 'until']) {
    if (q[key] && !ISO.test(String(q[key]))) throw badRequest(`Параметр ${key} должен быть датой ISO 8601`);
  }
  const result = await audit.list({
    tenantId: req.principal.tenantId,
    tenderId: q.tender_id,
    actorSub: q.actor,
    action: q.action,
    category: q.category,
    outcome: q.outcome,
    since: q.since,
    until: q.until,
    limit: q.limit,
    offset: q.offset,
  });
  res.json(result);
};
