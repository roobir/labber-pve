const fs = require('fs');
const path = require('path');
const { parseRepoUrl } = require('./git-api');
const { FOLDER_RE } = require('./push');

// Settings -> Backup, in LABS_DIR/.config/backup.json (0600, like the other
// settings files). The access token is write-only: getSafe() never returns
// it, and saving with an empty token keeps the one already saved.
//
// serverType          auto (default: asks the server) | github | forgejo
// schedule.frequency  monthly (default) | weekly | off
// schedule.day        monthly: day of the month 1-28; weekly: 0 (Sunday)-6
// schedule.time       "HH:MM", the server's local time
// scheduleSince       when the schedule was last saved -- a schedule never
//                     fires for a slot before it existed

const FILE = path.join(process.env.LABS_DIR || '/labs', '.config', 'backup.json');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULTS = {
  repoUrl: '',
  serverType: 'auto',
  branch: 'main',
  folder: 'labber',
  token: '',
  verifyTls: true,
  caCert: '',
  includeRuns: false,
  schedule: { frequency: 'monthly', day: 1, time: '02:00' },
  scheduleSince: null,
  lastSlot: null, // the scheduled slot (ISO time) most recently run or attempted
  last: null, // { at, trigger, user, ok, changed, commit, url, error, counts }
};

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return { ...DEFAULTS, ...saved, schedule: { ...DEFAULTS.schedule, ...(saved.schedule || {}) } };
  } catch (e) {
    return { ...DEFAULTS, schedule: { ...DEFAULTS.schedule } };
  }
}

function write(settings) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}

function getSafe() {
  const s = load();
  return { ...s, token: '', tokenSaved: !!s.token };
}

function checkSchedule({ frequency, day, time }) {
  if (!['monthly', 'weekly', 'off'].includes(frequency)) throw new Error('schedule: monthly, weekly or off');
  const d = Number(day);
  if (frequency === 'monthly' && !(Number.isInteger(d) && d >= 1 && d <= 28)) throw new Error('monthly backups run on day 1-28 of the month');
  if (frequency === 'weekly' && !(Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('weekly backups need a day of the week');
  if (!TIME_RE.test(String(time))) throw new Error('time must look like 02:00');
  return { frequency, day: d, time: String(time) };
}

// Partial update; returns getSafe().
function save(input = {}) {
  const current = load();
  const next = { ...current };
  if (input.repoUrl !== undefined) {
    next.repoUrl = String(input.repoUrl).trim();
    if (next.repoUrl) parseRepoUrl(next.repoUrl); // throws on a bad URL
  }
  if (input.serverType !== undefined) {
    if (!['auto', 'github', 'forgejo'].includes(input.serverType)) throw new Error('server: auto, github or forgejo');
    next.serverType = input.serverType;
  }
  if (input.branch !== undefined) {
    next.branch = String(input.branch).trim() || 'main';
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(next.branch) || next.branch.includes('..')) throw new Error('branch: letters, digits, . _ / - only');
  }
  if (input.folder !== undefined) {
    next.folder = String(input.folder).trim();
    if (!FOLDER_RE.test(next.folder)) throw new Error('folder: one name of letters, digits, dot, dash or underscore');
  }
  if (input.token) next.token = String(input.token).trim();
  if (input.clearToken) next.token = '';
  if (input.verifyTls !== undefined) next.verifyTls = !!input.verifyTls;
  if (input.caCert !== undefined) {
    next.caCert = String(input.caCert).trim();
    if (next.caCert && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(next.caCert)) {
      throw new Error('trusted certificate: paste it in PEM form (-----BEGIN CERTIFICATE----- ...)');
    }
  }
  if (input.includeRuns !== undefined) next.includeRuns = !!input.includeRuns;
  if (input.schedule !== undefined) {
    next.schedule = checkSchedule({ ...current.schedule, ...input.schedule });
    if (JSON.stringify(next.schedule) !== JSON.stringify(current.schedule)) next.scheduleSince = new Date().toISOString();
  }
  if (!next.scheduleSince) next.scheduleSince = new Date().toISOString();
  write(next);
  return getSafe();
}

// After a run: its outcome, and -- for a scheduled run -- the slot it was for.
function recordLast(last, slot) {
  const current = load();
  write({ ...current, last, lastSlot: slot || current.lastSlot });
}

module.exports = { load, getSafe, save, recordLast, DEFAULTS };
