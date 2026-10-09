const fs = require('fs');
const path = require('path');
const { listLabs } = require('./lab-files');

// "I'm working on this lab" notices. Purely informational -- nothing in the
// app is blocked by one; the dashboard shows a banner and destructive actions
// mention it in their confirmation. Anyone can reserve, extend, take over or
// release any lab (the team is trusted). Expired ones disappear on their own.
//
// Kept in its own file, not in the lab's YAML or deploy state: a reservation
// should outlive a destroy + redeploy, and nobody should have to edit YAML to
// put up a notice.

const FILE = path.join(process.env.LABS_DIR || '/labs', '.config', 'reservations.json');
const MIN_HOURS = 0.5;
const MAX_HOURS = 24 * 14;
const MAX_NOTE = 120;

let cached = null;

function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch (e) {
    cached = {};
  }
  return cached;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(cached, null, 2), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}

// The active reservation for a lab, or null. Drops an expired one.
function get(lab) {
  const all = load();
  const rec = all[lab];
  if (!rec) return null;
  if (Date.parse(rec.until) <= Date.now()) {
    delete all[lab];
    persist();
    return null;
  }
  return rec;
}

// Reserving again (to extend, or to take over) simply replaces the record;
// the original start time is kept when the same person extends their own.
function reserve(lab, user, hours, note) {
  if (!listLabs().includes(lab)) throw new Error(`Unknown lab file: ${lab}`);
  const h = Number(hours);
  if (!Number.isFinite(h) || h < MIN_HOURS || h > MAX_HOURS) {
    throw new Error(`reserve for between ${MIN_HOURS} hours and ${MAX_HOURS / 24} days`);
  }
  const previous = get(lab);
  const now = Date.now();
  const rec = {
    by: user,
    note: String(note || '').trim().slice(0, MAX_NOTE),
    since: previous && previous.by === user ? previous.since : new Date(now).toISOString(),
    until: new Date(now + h * 3600 * 1000).toISOString(),
  };
  load()[lab] = rec;
  persist();
  return rec;
}

// Returns what was released (or null if there was nothing to release).
function release(lab) {
  const previous = get(lab);
  if (previous) {
    delete load()[lab];
    persist();
  }
  return previous;
}

module.exports = { get, reserve, release, MAX_HOURS };
