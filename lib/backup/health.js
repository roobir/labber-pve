// Should the dashboard warn about backups? Only when backups are scheduled
// (a repository, a token and a monthly / weekly schedule) and either
//   failed    the most recent backup failed (scheduled or by hand), or
//   overdue   no successful backup within the grace period: 40 days for a
//             monthly schedule, 10 for a weekly one -- counted from the last
//             good backup, or from when the schedule was saved if none yet.
// Manual-only (schedule off) or not set up -> never a warning.
//
// health(settings, now) -> null | { state, since, message }

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = { monthly: 40, weekly: 10 };

const day = (iso) => new Date(iso).toISOString().slice(0, 10);

function health(s, now = new Date()) {
  const grace = GRACE_DAYS[s.schedule && s.schedule.frequency];
  if (!s.repoUrl || !s.token || !grace) return null;
  const last = s.last;
  if (last && !last.ok) {
    return { state: 'failed', since: last.at, message: `The last backup (${day(last.at)}) failed: ${last.error}` };
  }
  const since = last && last.ok ? last.at : s.scheduleSince;
  if (!since || now - Date.parse(since) <= grace * DAY_MS) return null;
  return {
    state: 'overdue',
    since,
    message: last ? `No backup since ${day(last.at)}` : `No backup has run since backups were set up (${day(since)})`,
  };
}

module.exports = { health, GRACE_DAYS };
