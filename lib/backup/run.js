const gitApi = require('./git-api');
const { commitFolder } = require('./push');
const { collect } = require('./collect');
const settings = require('./settings');
const audit = require('../audit/log');

// Runs one backup: collect -> one commit -> record the outcome (Settings ->
// Backup shows it) and an activity-log entry. Only one backup runs at a
// time; asking while one is running is refused, not queued.

let running = null;

// A client for the saved repository; with server "auto", the server is asked
// which kind it is (git-api.js detect()).
async function connect(s) {
  if (!s.repoUrl) throw new Error('no repository set (Settings -> Backup)');
  const tls = { verifyTls: s.verifyTls, caCert: s.caCert };
  const kind = s.serverType === 'github' || s.serverType === 'forgejo' ? s.serverType : await gitApi.detect(s.repoUrl, tls);
  return gitApi.client({ repoUrl: s.repoUrl, token: s.token, kind, ...tls });
}

// Checks the repository, branch rights and token without writing anything.
async function test() {
  const client = await connect(settings.load());
  const info = await client.call('GET', '/{repo}');
  if (info.permissions && info.permissions.push === false) throw new Error(`the token can read ${info.full_name} but not push to it`);
  return { repo: info.full_name, private: info.private, server: client.label, defaultBranch: info.default_branch };
}

async function execute(s, { trigger, user }) {
  const { files, counts } = collect(s);
  const at = new Date().toISOString();
  const who = trigger === 'scheduled' ? `scheduled ${s.schedule.frequency}` : `${trigger} by ${user}`;
  const message = `labber backup ${at.slice(0, 16).replace('T', ' ')} UTC (${who})\n\n`
    + `${counts.labs} labs, ${counts.runbookFiles} runbook files, ${counts.activityDays} activity days`
    + `${s.includeRuns ? `, ${counts.runs} runs` : ''}. The Store and all secrets are not included.`;
  const result = await commitFolder(await connect(s), { branch: s.branch, folder: s.folder, files, message });
  return { counts, ...result };
}

// run({ trigger: 'manual' | 'scheduled', user, ip, slot }) -> the recorded outcome
async function run({ trigger, user = 'scheduler', ip = '', slot } = {}) {
  if (running) throw Object.assign(new Error('a backup is already running'), { status: 409 });
  const s = settings.load();
  const at = new Date().toISOString();
  running = (async () => {
    let last;
    try {
      const r = await execute(s, { trigger, user });
      last = { at, trigger, user, ok: true, changed: r.changed, commit: r.commit, url: r.url, counts: r.counts };
    } catch (err) {
      last = { at, trigger, user, ok: false, error: err.message };
    }
    settings.recordLast(last, slot);
    audit.record({
      user, ip, action: 'backup.run', target: `${s.repoUrl} ${s.branch}/${s.folder}`,
      result: last.ok ? 'ok' : 'failed',
      detail: { trigger, commit: last.changed === false ? 'no changes' : last.commit, error: last.error },
    });
    return last;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

module.exports = { run, test, isRunning: () => !!running };
