const audit = require('./log');

// Who is most active: changes per user for the last 7 days, the last 30 days
// and everything kept (AUDIT_RETENTION_DAYS), split into four kinds. Counted
// from the activity log in one pass. What counts is a change someone made:
// sign-ins / sign-outs are not counted, a lab operation counts once (when it
// ends, not also its "started" line), a console counts when opened (not when
// closed). Failed attempts count too -- they are activity all the same.
//
// summary(now) -> { periods: { week, month, all }: [{ user, total, kinds }] }
//   sorted by total, most active first; kinds = { labs, runbooks, consoles, other }

const KINDS = ['labs', 'runbooks', 'consoles', 'other'];
const DAY_MS = 24 * 60 * 60 * 1000;

function kindOf(entry) {
  const [area] = entry.action.split('.');
  if (area === 'auth' || entry.result === 'started' || entry.action === 'console.close') return null;
  if (area === 'lab' || area === 'node') return 'labs';
  if (area === 'run' || area === 'runbook') return 'runbooks';
  if (area === 'console') return 'consoles';
  return 'other';
}

function ranked(counts) {
  return [...counts.entries()]
    .map(([user, kinds]) => ({ user, total: KINDS.reduce((n, k) => n + kinds[k], 0), kinds }))
    .sort((a, b) => b.total - a.total || a.user.localeCompare(b.user));
}

function summary(now = new Date()) {
  const since = { week: new Date(now - 7 * DAY_MS).toISOString(), month: new Date(now - 30 * DAY_MS).toISOString() };
  const periods = { week: new Map(), month: new Map(), all: new Map() };
  audit.eachEntry((entry) => {
    const kind = kindOf(entry);
    if (!kind) return;
    for (const [period, counts] of Object.entries(periods)) {
      if (since[period] && entry.time < since[period]) continue;
      if (!counts.has(entry.user)) counts.set(entry.user, Object.fromEntries(KINDS.map((k) => [k, 0])));
      counts.get(entry.user)[kind] += 1;
    }
  });
  return {
    kinds: KINDS,
    retentionDays: audit.RETENTION_DAYS,
    periods: Object.fromEntries(Object.entries(periods).map(([p, counts]) => [p, ranked(counts)])),
  };
}

module.exports = { summary, kindOf, KINDS };
