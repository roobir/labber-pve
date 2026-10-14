const settings = require('./settings');
const backup = require('./run');

// The backup schedule, in the server's local time (the container's TZ;
// UTC unless set). Checked once a minute. A slot is run once: if the app was
// down at that moment, the next check after it starts runs it (only the
// latest missed slot, never a backlog). A failed scheduled backup is not
// retried until the next slot -- the failure shows in Settings -> Backup and
// the activity log, and "back up now" runs one by hand.

const CHECK_MS = 60 * 1000;

// The first slot strictly after `after` (a Date).
function nextSlot(schedule, after) {
  const [hh, mm] = schedule.time.split(':').map(Number);
  if (schedule.frequency === 'monthly') {
    let slot = new Date(after.getFullYear(), after.getMonth(), schedule.day, hh, mm);
    if (slot <= after) slot = new Date(after.getFullYear(), after.getMonth() + 1, schedule.day, hh, mm);
    return slot;
  }
  if (schedule.frequency === 'weekly') {
    const ahead = (schedule.day - after.getDay() + 7) % 7;
    let slot = new Date(after.getFullYear(), after.getMonth(), after.getDate() + ahead, hh, mm);
    if (slot <= after) slot = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() + 7, hh, mm);
    return slot;
  }
  return null;
}

const ready = (s) => s.schedule.frequency !== 'off' && s.repoUrl && s.token;

// The slot to run now, if one is due: the latest slot that has passed since
// the schedule was saved and since the last slot that ran.
function dueSlot(s, now = new Date()) {
  if (!ready(s)) return null;
  const since = new Date(Math.max(Date.parse(s.scheduleSince || 0) || 0, Date.parse(s.lastSlot || 0) || 0));
  let slot = nextSlot(s.schedule, since);
  if (!slot || slot > now) return null;
  for (let later = nextSlot(s.schedule, slot); later && later <= now; later = nextSlot(s.schedule, later)) slot = later;
  return slot;
}

function next(s, now = new Date()) {
  if (!ready(s)) return null;
  return dueSlot(s, now) || nextSlot(s.schedule, new Date(Math.max(now, Date.parse(s.lastSlot || 0) || 0)));
}

async function tick() {
  const s = settings.load();
  const slot = dueSlot(s);
  if (!slot || backup.isRunning()) return;
  await backup.run({ trigger: 'scheduled', slot: slot.toISOString() }).catch((err) => console.error(`backup: ${err.message}`));
}

function start() {
  const timer = setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
  timer.unref();
  return timer;
}

module.exports = { start, tick, nextSlot, dueSlot, next };
