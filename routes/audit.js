const express = require('express');
const audit = require('../lib/audit/log');
const { summary } = require('../lib/audit/summary');

// Read-only access to the audit log (Settings -> Activity). There is
// deliberately no route that changes or deletes entries: every user of this
// app is an administrator, and the log is how their changes are traced.
//
//   GET /api/audit       newest first, as JSON
//   GET /api/audit.csv   the same entries as a CSV download
//   GET /api/audit/summary   changes per user: last 7 days, 30 days, all kept
// Query: user, action (e.g. "lab" or "lab.deploy"), target (a lab file name
// also matches its nodes), q (free text), from / to
// (ISO date or time), limit (default 200, or 5000 for the CSV; at most 5000).

function filtersFrom(query) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  // A bare date for `to` means "to the end of that day".
  const to = str(query.to);
  return {
    user: str(query.user),
    action: str(query.action),
    target: str(query.target),
    q: str(query.q),
    from: str(query.from),
    to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to,
    limit: query.limit,
  };
}

// Quoted cells, doubled quotes, and a leading ' on anything a spreadsheet
// would run as a formula (a lab or node name is user-chosen text).
function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(entries) {
  const head = ['time', 'user', 'ip', 'action', 'target', 'result', 'detail'];
  const rows = entries.map((e) => [e.time, e.user, e.ip, e.action, e.target, e.result,
    Object.entries(e.detail || {}).map(([k, v]) => `${k}=${v}`).join('; ')]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function buildAuditRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/audit', requireAuth, (req, res) => {
    res.json({ entries: audit.query(filtersFrom(req.query)), retentionDays: audit.RETENTION_DAYS });
  });

  router.get('/api/audit/summary', requireAuth, (req, res) => res.json(summary()));

  router.get('/api/audit.csv', requireAuth, (req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.attachment(`labber-activity-${stamp}.csv`);
    // An export wants everything that matches, not one screen's worth.
    const filters = { ...filtersFrom(req.query), limit: req.query.limit || 5000 };
    res.type('text/csv').send(toCsv(audit.query(filters)));
  });

  return router;
}

module.exports = { buildAuditRoutes, toCsv, filtersFrom };
