const fs = require('fs');
const os = require('os');
const path = require('path');
const configStore = require('../config-store');
const apiSettings = require('../api-settings');
const userStore = require('../user-store');
const { RUNBOOKS_DIR, RUNS_DIR } = require('../runbooks/paths');
const { AUDIT_DIR } = require('../audit/log');

// What a backup holds, as [{ path, content }] relative to the backup folder
// (layout in docs/BACKUP.md). Built from an ALLOW-list: only these are read,
// so a new secret file under LABS_DIR/.config can never slip in by accident.
//
//   labs/<name>.lab.yml          every lab file, exactly as written
//   state/<name>.lab.yml.json    deployed-lab state (VM ids, mgmt IPs)
//   runbooks/<name>/<v>.yml      every runbook version + its .meta.json
//   activity/<day>.jsonl         the activity (audit) log
//   runs/<id>.json               run history (redacted) -- only if asked for
//   settings/*.json              settings WITHOUT secrets, user names only
//   manifest.json                what this backup is
//
// Never included: the Store (passwords, licences, keys, saved configs), the
// Proxmox token / password, password hashes, API-token hashes, the backup PAT.

const LABS_DIR = process.env.LABS_DIR || '/labs';
const STATE_DIR = path.join(LABS_DIR, '.state');
const APP_VERSION = require('../../package.json').version;

function listFiles(dir, keep) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && keep(e.name)).map((e) => e.name).sort();
  } catch (e) {
    return [];
  }
}

const read = (file) => fs.readFileSync(file, 'utf-8');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function runbookFiles() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(RUNBOOKS_DIR).filter((n) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(n)).sort(); } catch (e) { /* none yet */ }
  for (const name of names) {
    for (const f of listFiles(path.join(RUNBOOKS_DIR, name), (n) => /^\d{1,4}\.\d{1,4}(\.meta\.json|\.yml)$/.test(n))) {
      out.push({ path: `runbooks/${name}/${f}`, content: read(path.join(RUNBOOKS_DIR, name, f)) });
    }
  }
  return out;
}

// Names only (never the password hashes); an install without users yet
// must not fail the whole backup.
function userNames() {
  try {
    return userStore.list();
  } catch (e) {
    return [];
  }
}

function settingsFiles(backupSettings) {
  const proxmox = { ...configStore.getSafe() };
  delete proxmox.tokenSecret;
  delete proxmox.pvePassword;
  delete proxmox.configured;
  const backup = { ...backupSettings };
  for (const key of ['token', 'last', 'lastSlot', 'scheduleSince']) delete backup[key];
  return [
    { path: 'settings/proxmox.json', content: json(proxmox) },
    { path: 'settings/api-settings.json', content: json(apiSettings.getSettings()) },
    { path: 'settings/users.json', content: json(userNames()) },
    { path: 'settings/backup.json', content: json(backup) },
  ];
}

// collect(backupSettings) -> { files, counts }
function collect(backupSettings) {
  const labs = listFiles(LABS_DIR, (n) => n.endsWith('.lab.yml')).map((f) => ({ path: `labs/${f}`, content: read(path.join(LABS_DIR, f)) }));
  const state = listFiles(STATE_DIR, (n) => n.endsWith('.json')).map((f) => ({ path: `state/${f}`, content: read(path.join(STATE_DIR, f)) }));
  const runbooks = runbookFiles();
  const activity = listFiles(AUDIT_DIR, (n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((f) => ({ path: `activity/${f}`, content: read(path.join(AUDIT_DIR, f)) }));
  const runs = backupSettings.includeRuns
    ? listFiles(RUNS_DIR, (n) => n.endsWith('.json')).map((f) => ({ path: `runs/${f}`, content: read(path.join(RUNS_DIR, f)) }))
    : [];
  const counts = { labs: labs.length, deployedLabs: state.length, runbookFiles: runbooks.length, activityDays: activity.length, runs: runs.length };
  const manifest = {
    app: 'labber-pve',
    version: APP_VERSION,
    host: os.hostname(),
    // No time / trigger / user here (they are in the commit message): an
    // unchanged labber must give an identical tree, so no empty commit.
    counts,
    excluded: ['Store (passwords, licences, keys, saved configs)', 'Proxmox token and password', 'password hashes', 'API token hashes', 'backup access token'],
  };
  const files = [...labs, ...state, ...runbooks, ...activity, ...runs, ...settingsFiles(backupSettings), { path: 'manifest.json', content: json(manifest) }];
  return { files, counts };
}

module.exports = { collect };
