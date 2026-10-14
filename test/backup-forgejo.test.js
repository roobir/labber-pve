const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshLabsDir } = require('./helpers');
const { createFakeForgejo } = require('./fake-forgejo');
const { createFakeGitHub } = require('./fake-github');

const dir = freshLabsDir();
process.env.DASHBOARD_USERNAME = 'nico';
process.env.DASHBOARD_PASSWORD_HASH = '$2a$04$abcdefghijklmnopqrstuuHASHHASHHASHHASHHASHHASHHASHHA';
const settings = require('../lib/backup/settings');
const backup = require('../lib/backup/run');
const gitApi = require('../lib/backup/git-api');

const fake = createFakeForgejo();
const github = createFakeGitHub();
let repoUrl;
let githubUrl;
const posts = () => fake.requests.filter((r) => r.method === 'POST');

test.before(async () => {
  repoUrl = `${await fake.listen()}.git`;
  githubUrl = await github.listen();
  for (let i = 1; i <= 5; i += 1) fs.writeFileSync(path.join(dir, `lab-${i}.lab.yml`), `nodes:\n  n${i}: { kind: fortios }\n`);
  fs.writeFileSync(path.join(dir, 'lab-é.lab.yml'), '# café\nnodes:\n  n1: { kind: fortios }\n');
  settings.save({ repoUrl, token: 'good-token', folder: 'labber' });
});
test.after(() => { fake.server.close(); github.server.close(); });

test('server detection: Forgejo answers /api/v1/version, GitHub does not', async () => {
  assert.strictEqual(await gitApi.detect(repoUrl), 'forgejo');
  assert.strictEqual(await gitApi.detect(githubUrl), 'github');
  assert.strictEqual(await gitApi.detect('https://github.com/a/b'), 'github');
  assert.strictEqual(gitApi.apiBase('forgejo', 'https://git.example.com'), 'https://git.example.com/api/v1');
  assert.strictEqual(gitApi.apiBase('github', 'https://github.uat.example.com'), 'https://github.uat.example.com/api/v3');
  const t = await backup.test();
  assert.deepStrictEqual([t.server, t.repo, t.private], ['Forgejo', 'home/lab-backup', true]);
});

test('first backup into an empty repository: one commit with every file', async () => {
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.ok(last.ok, last.error);
  assert.match(last.url, /\/home\/lab-backup\/commit\/\w+$/);
  const files = fake.files();
  assert.strictEqual(files['labber/labs/lab-3.lab.yml'], 'nodes:\n  n3: { kind: fortios }\n');
  assert.strictEqual(files['labber/labs/lab-é.lab.yml'], '# café\nnodes:\n  n1: { kind: fortios }\n', 'non-ASCII kept');
  assert.ok('labber/manifest.json' in files);
  assert.strictEqual(posts().length, 1);
});

test('identical content -> no commit; one changed lab -> only that file is sent', async () => {
  const { commitFolder } = require('../lib/backup/push');
  const fj = gitApi.client({ repoUrl, token: 'good-token', kind: 'forgejo' });
  const current = Object.entries(fake.files()).filter(([p]) => p.startsWith('labber/')).map(([p, content]) => ({ path: p.slice(7), content }));
  const same = await commitFolder(fj, { branch: 'main', folder: 'labber', files: current, message: 'same' });
  assert.strictEqual(same.changed, false);
  assert.strictEqual(posts().length, 1, 'no POST for an unchanged folder');

  fs.writeFileSync(path.join(dir, 'lab-2.lab.yml'), 'nodes:\n  n2: { kind: f5_bigip_ve }\n');
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.ok(last.ok, last.error);
  const ops = posts().at(-1).body.files.map((f) => `${f.operation} ${f.path}`);
  assert.ok(ops.includes('update labber/labs/lab-2.lab.yml'));
  assert.ok(!ops.some((o) => o.includes('lab-1.lab.yml')), `unchanged labs are not sent: ${ops}`);
  assert.strictEqual(fake.files()['labber/labs/lab-2.lab.yml'], 'nodes:\n  n2: { kind: f5_bigip_ve }\n');
});

test('a deleted lab is deleted from the backup; other folders are untouched', async () => {
  fake.commitTo('main', { ...fake.files(), 'other/keep.txt': 'k' }, 'someone else');
  fs.rmSync(path.join(dir, 'lab-4.lab.yml'));
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.ok(last.ok, last.error);
  assert.ok(!('labber/labs/lab-4.lab.yml' in fake.files()));
  assert.strictEqual(fake.files()['other/keep.txt'], 'k');
  assert.ok(posts().at(-1).body.files.some((f) => f.operation === 'delete' && f.path === 'labber/labs/lab-4.lab.yml' && f.sha));
});

test('a missing branch is created from the default branch', async () => {
  settings.save({ branch: 'backups/home' });
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  settings.save({ branch: 'main' });
  assert.ok(last.ok, last.error);
  const body = posts().at(-1).body;
  assert.deepStrictEqual([body.branch, body.new_branch], ['main', 'backups/home']);
  assert.strictEqual(fake.files('backups/home')['other/keep.txt'], 'k');
});

test('a file changed on the server meanwhile fails the backup instead of being overwritten', async () => {
  const realCall = gitApi.client;
  gitApi.client = (opts) => {
    const c = realCall(opts);
    return { ...c, call: async (method, p, body) => {
      if (method === 'POST') fake.commitTo('main', { ...fake.files(), 'labber/labs/lab-1.lab.yml': 'edited on the server\n' }, 'meanwhile');
      return c.call(method, p, body);
    } };
  };
  fs.writeFileSync(path.join(dir, 'lab-1.lab.yml'), 'nodes:\n  n1: { kind: cisco_c8000v }\n');
  const failed = await backup.run({ trigger: 'manual', user: 'nico' });
  gitApi.client = realCall;
  assert.strictEqual(failed.ok, false);
  assert.match(failed.error, /Forgejo POST .*409 sha does not match/);
  const again = await backup.run({ trigger: 'manual', user: 'nico' });
  assert.ok(again.ok, again.error);
  assert.strictEqual(fake.files()['labber/labs/lab-1.lab.yml'], 'nodes:\n  n1: { kind: cisco_c8000v }\n');
});

test('forced server type is used without asking the server', async () => {
  settings.save({ serverType: 'github' });
  const t = await backup.test().catch((e) => e);
  settings.save({ serverType: 'auto' });
  assert.match(t.message, /GitHub GET \/api\/v3\/repos\/home\/lab-backup: 404/, 'the very error the user saw');
  assert.throws(() => settings.save({ serverType: 'gitlab' }), /auto, github or forgejo/);
});

test('a rejected token is never repeated in the error (Forgejo echoes it)', async () => {
  settings.save({ token: 'ghp_REALLOOKINGTOKEN123' });
  const last = await backup.run({ trigger: 'manual', user: 'nico' });
  settings.save({ token: 'good-token' });
  assert.strictEqual(last.ok, false);
  assert.match(last.error, /401 access token does not exist \[sha: \*\*\*\]/);
  const audit = require('../lib/audit/log');
  assert.ok(!JSON.stringify(audit.query()).includes('REALLOOKING'));
  assert.ok(!JSON.stringify(settings.load().last).includes('REALLOOKING'));
});
