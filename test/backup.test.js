const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshLabsDir } = require('./helpers');
const { createFakeGitHub } = require('./fake-github');

const dir = freshLabsDir();
process.env.DASHBOARD_USERNAME = 'nico';
process.env.DASHBOARD_PASSWORD_HASH = '$2a$04$abcdefghijklmnopqrstuuHASHHASHHASHHASHHASHHASHHASHHA';
const store = require('../lib/runbooks/store');
const configStore = require('../lib/config-store');
const settings = require('../lib/backup/settings');
const backup = require('../lib/backup/run');
const audit = require('../lib/audit/log');
const { parseRepoUrl } = require('../lib/backup/git-api');

const fake = createFakeGitHub();
let repoUrl;
test.before(async () => {
  repoUrl = await fake.listen();
  fs.writeFileSync(path.join(dir, 'lab-a.lab.yml'), 'nodes:\n  n1: { kind: f5_bigip_ve }\n');
  fs.writeFileSync(path.join(dir, 'lab-b.lab.yml'), '# keep me\nnodes:\n  n1: { kind: fortios }\n');
  fs.mkdirSync(path.join(dir, '.runbooks', 'my-rb'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.runbooks', 'my-rb', '1.0.yml'), 'title: x\n');
  fs.writeFileSync(path.join(dir, '.runbooks', 'my-rb', '1.0.meta.json'), '{"status":"draft"}');
  store.upsert('pr1-config', { type: 'text', value: 'STORE-SECRET-CONFIG' }, 't');
  configStore.save({ host: 'pve.lab', tokenId: 'root@pam!x', tokenSecret: 'PVE-SECRET', pvePassword: 'PVE-PW' });
  audit.record({ user: 'nico', action: 'lab.save', target: 'lab-a.lab.yml' });
});
test.after(() => fake.server.close());

test('repository URLs: GitHub Enterprise and github.com', () => {
  assert.deepStrictEqual(parseRepoUrl('https://github.uat.example.com/NetSec/labber.git'),
    { origin: 'https://github.uat.example.com', owner: 'NetSec', repo: 'labber', webBase: 'https://github.uat.example.com/NetSec/labber' });
  assert.strictEqual(require('../lib/backup/git-api').apiBase('github', 'https://github.com'), 'https://api.github.com');
  assert.throws(() => parseRepoUrl('https://github.com/only-owner'), /owner\/repo/);
  assert.throws(() => parseRepoUrl('not a url'), /owner\/repo/);
});

test('settings: token is write-only, bad values refused, monthly is the default', () => {
  assert.deepStrictEqual(settings.getSafe().schedule, { frequency: 'monthly', day: 1, time: '02:00' });
  const saved = settings.save({ repoUrl, token: 'good-token', branch: 'main', folder: 'labber' });
  assert.strictEqual(saved.token, '');
  assert.strictEqual(saved.tokenSaved, true);
  settings.save({ token: '' });
  assert.strictEqual(settings.load().token, 'good-token', 'an empty token keeps the saved one');
  assert.throws(() => settings.save({ folder: '../x' }), /folder/);
  assert.throws(() => settings.save({ schedule: { day: 31 } }), /1-28/);
  assert.throws(() => settings.save({ schedule: { time: '25:00' } }), /time/);
  assert.throws(() => settings.save({ caCert: 'not a cert' }), /PEM/);
  assert.throws(() => settings.save({ branch: 'a..b' }), /branch/);
});

test('the first backup starts an empty repository and commits the allow-listed files only', async () => {
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.ok(last.ok, last.error);
  const files = fake.files();
  assert.deepStrictEqual(Object.keys(files).sort(), [
    'README.md', 'labber/activity/' + new Date().toISOString().slice(0, 10) + '.jsonl', 'labber/labs/lab-a.lab.yml', 'labber/labs/lab-b.lab.yml',
    'labber/manifest.json', 'labber/runbooks/my-rb/1.0.meta.json', 'labber/runbooks/my-rb/1.0.yml',
    'labber/settings/api-settings.json', 'labber/settings/backup.json', 'labber/settings/proxmox.json', 'labber/settings/users.json',
  ].sort());
  assert.strictEqual(files['labber/labs/lab-b.lab.yml'], '# keep me\nnodes:\n  n1: { kind: fortios }\n');
  assert.deepStrictEqual(JSON.parse(files['labber/settings/users.json']), [{ username: 'nico' }]);
  const everything = JSON.stringify(files);
  for (const secret of ['STORE-SECRET-CONFIG', 'PVE-SECRET', 'PVE-PW', 'good-token', 'passwordHash', 'HASHHASH']) assert.ok(!everything.includes(secret), secret);
  assert.match(fake.commits()[0].message, /manual by nico/);
  assert.strictEqual(settings.load().last.commit, last.commit);
});

test('nothing changed -> no new commit; a deleted lab disappears; other folders untouched', async () => {
  const before = fake.commits().length;
  // Identical files -> no commit. (A real second backup always differs a
  // little: the previous backup's own activity-log entry is new.)
  const { commitFolder } = require('../lib/backup/push');
  const gh = require('../lib/backup/git-api').client({ repoUrl, token: 'good-token', kind: 'github' });
  const files = Object.entries(fake.files()).filter(([p]) => p.startsWith('labber/')).map(([p, content]) => ({ path: p.slice(7), content }));
  const same = await commitFolder(gh, { branch: 'main', folder: 'labber', files, message: 'same' });
  assert.strictEqual(same.changed, false);
  assert.strictEqual(fake.commits().length, before);
  fake.commitTo('main', { ...fake.files(), 'other-instance/labs/x.lab.yml': 'x' }, 'someone else');
  fs.rmSync(path.join(dir, 'lab-a.lab.yml'));
  const after = await backup.run({ trigger: 'scheduled', slot: '2026-11-01T02:00:00.000Z' });
  assert.ok(after.ok && after.changed);
  assert.ok(!('labber/labs/lab-a.lab.yml' in fake.files()));
  assert.strictEqual(fake.files()['other-instance/labs/x.lab.yml'], 'x');
  assert.strictEqual(settings.load().lastSlot, '2026-11-01T02:00:00.000Z');
  assert.strictEqual(fake.commits().length, before + 2);
});

test('a bad token fails cleanly, is recorded, and is shown as the last outcome', async () => {
  settings.save({ token: 'wrong' });
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.strictEqual(last.ok, false);
  assert.match(last.error, /401 Bad credentials/);
  const [entry] = audit.query({ action: 'backup' });
  assert.deepStrictEqual([entry.result, entry.user], ['failed', 'nico']);
  await assert.rejects(backup.test(), /401/);
  settings.save({ token: 'good-token' });
  assert.strictEqual((await backup.test()).repo, 'NetSec/labber');
});

test('the branch moving during a backup is retried on top, never overwritten', async () => {
  fs.writeFileSync(path.join(dir, 'lab-c.lab.yml'), 'nodes:\n  n1: { kind: fortios }\n');
  const gitApi = require('../lib/backup/git-api');
  const realCall = gitApi.client;
  let moved = false;
  gitApi.client = (opts) => {
    const c = realCall(opts);
    return { ...c, call: async (method, p, body) => {
      if (method === 'PATCH' && !moved) { moved = true; fake.commitTo('main', { ...fake.files(), 'other-instance/new.txt': 'n' }, 'concurrent'); }
      return c.call(method, p, body);
    } };
  };
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  gitApi.client = realCall;
  assert.ok(last.ok, last.error);
  assert.strictEqual(fake.files()['other-instance/new.txt'], 'n');
  assert.ok('labber/labs/lab-c.lab.yml' in fake.files());
});

test('the scheduler runs a due slot once, then waits for the next one', async () => {
  const schedule = require('../lib/backup/schedule');
  const fs2 = require('fs');
  const file = require('path').join(dir, '.config', 'backup.json');
  const saved = JSON.parse(fs2.readFileSync(file, 'utf-8'));
  fs2.writeFileSync(file, JSON.stringify({ ...saved, scheduleSince: '2026-01-15T00:00:00.000Z', lastSlot: null }));
  const before = fake.commits().length;
  await schedule.tick();
  const after = settings.load();
  assert.strictEqual(after.last.trigger, 'scheduled');
  assert.ok(after.last.ok, after.last.error);
  assert.strictEqual(after.lastSlot, schedule.dueSlot({ ...after, lastSlot: null }).toISOString(), 'the latest missed slot');
  assert.strictEqual(fake.commits().length, before + 1);
  await schedule.tick();
  assert.strictEqual(fake.commits().length, before + 1, 'not run again for the same slot');
});

test('a branch with a slash (backups/prod) works', async () => {
  settings.save({ branch: 'backups/prod' });
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  settings.save({ branch: 'main' });
  assert.ok(last.ok, last.error);
  assert.ok('labber/manifest.json' in fake.files('backups/prod'));
});

test('a token pasted into the repository URL is refused, and never logged', () => {
  assert.throws(() => settings.save({ repoUrl: 'https://nico:ghp_SECRET123@github.example.com/NetSec/labber.git' }), /out of the URL/);
  assert.ok(!JSON.stringify(settings.load()).includes('ghp_SECRET123'));
  const { describe } = require('../lib/audit/actions');
  const d = describe('PUT', '/api/backup/settings', { repoUrl: 'https://nico:ghp_SECRET123@github.example.com/NetSec/labber.git', token: 'ghp_OTHER' });
  assert.strictEqual(d.target, 'https://github.example.com/NetSec/labber.git');
  assert.strictEqual(d.detail.token, 'changed');
  assert.ok(!JSON.stringify(d).includes('SECRET123') && !JSON.stringify(d).includes('ghp_OTHER'));
  assert.ok(!JSON.stringify(describe('PUT', '/api/backup/settings', { repoUrl: 'not a url //u:p@x' })).includes('u:p'));
});
