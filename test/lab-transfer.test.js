const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { freshLabsDir } = require('./helpers');

const dir = freshLabsDir();
const { seedBuiltins } = require('../lib/runbooks/seed');
const store = require('../lib/runbooks/store');
const files = require('../lib/lab-files');
const transfer = require('../lib/lab-transfer');

seedBuiltins();
store.upsert('password-simple', { type: 'secret', value: 'pw' }, 'test');
store.upsert('f5-ha-node1-master-key', { type: 'secret', value: 'k' }, 'test');

const example = fs.readFileSync(path.join(__dirname, '..', 'labs', 'f5-ha-pair-restore-example.lab.yml'), 'utf-8');
const withIdentity = `# my comment\nnodes:\n  n1:\n    kind: f5_bigip_ve\n    uuid: d6169478-cfeb-4dfb-ab3b-e440132c9a6a\n    mac:\n      net0: 02:52:d8:0c:8b:2d\n    mgmtIp: 192.0.2.10\n    mgmtPort: 443\n    cores: 4\nlinks: []\n`;

test('import keeps the text exactly as written and never replaces a lab', () => {
  const out = transfer.importLab('ident', withIdentity);
  assert.strictEqual(out.name, 'ident.lab.yml');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ident.lab.yml'), 'utf-8'), withIdentity);
  assert.throws(() => transfer.importLab('ident', withIdentity), (e) => e.status === 409);
  assert.ok(files.listLabs().includes('ident.lab.yml'));
});

test('import refuses bad names, bad YAML, invalid labs and oversize files', () => {
  assert.throws(() => transfer.importLab('../evil', withIdentity), /alphanumeric/);
  assert.throws(() => transfer.importLab('x1', 'nodes: [unclosed'), /not valid YAML/);
  assert.throws(() => transfer.importLab('x2', 'links: []\n'), /nodes/);
  assert.throws(() => transfer.importLab('x3', '   '), /empty/);
  assert.throws(() => transfer.importLab('x4', `#${'a'.repeat(1024 * 1024)}`), /1 MB/);
  assert.throws(() => transfer.importLab('x5', undefined), /empty/);
  assert.deepStrictEqual(files.listLabs().filter((f) => f.startsWith('x')), []);
});

test('exact export is byte for byte; clean export drops instance identity only', () => {
  assert.strictEqual(transfer.exportLab('ident.lab.yml').text, withIdentity);
  const clean = transfer.exportLab('ident.lab.yml', { clean: true });
  assert.strictEqual(clean.filename, 'ident-clean.lab.yml');
  const node = yaml.load(clean.text).nodes.n1;
  assert.deepStrictEqual(node, { kind: 'f5_bigip_ve', cores: 4 });
  assert.match(clean.text, /^# ident\.lab\.yml -- clean copy/);
  assert.throws(() => transfer.exportLab('../../etc/passwd'), /Unknown lab file/);
});

test('a clean export imports back as a valid lab', () => {
  const out = transfer.importLab('ident-copy', transfer.exportLab('ident.lab.yml', { clean: true }).text);
  assert.strictEqual(out.name, 'ident-copy.lab.yml');
  assert.doesNotThrow(() => files.parseTopology('ident-copy.lab.yml'));
});

test('warnings name what this labber lacks, without refusing the import', () => {
  const { warnings } = transfer.importLab('ha', example);
  const text = warnings.join('\n');
  assert.match(text, /no golden template for f5_bigip_ve yet .* -- f5-1, f5-2$/m, 'one line per problem, naming the nodes');
  assert.match(text, /Store entry "lic-lab-01" is missing -- f5-1$/m, 'license input given in the lab');
  assert.doesNotMatch(text, /password-simple/, 'present in the Store (a runbook default)');
  assert.doesNotMatch(text, /f5-ha-node1-master-key/);
  assert.ok(files.listLabs().includes('ha.lab.yml'));

  const missing = transfer.importLab('ghost', 'nodes:\n  a:\n    kind: nope\n    bootstrap:\n      - runbook: no-such-runbook\n      - runbook: f5-first-boot\n        version: "9.9"\n');
  assert.match(missing.warnings.join('\n'), /kind "nope"/);
  assert.match(missing.warnings.join('\n'), /runbook "no-such-runbook" is not in this library -- a/);
  assert.match(missing.warnings.join('\n'), /"f5-first-boot" version 9\.9 is not here/);
});

test('every shipped example lab round-trips through export and import', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'labs')).filter((n) => n.endsWith('.lab.yml'))) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'labs', f), 'utf-8');
    const name = `rt-${f.replace(/\.lab\.yml$/, '')}`;
    transfer.importLab(name, text);
    assert.strictEqual(transfer.exportLab(`${name}.lab.yml`).text, text, f);
    assert.doesNotThrow(() => transfer.importLab(`${name}-clean`, transfer.exportLab(`${name}.lab.yml`, { clean: true }).text), f);
  }
});

test('duplicate: a clean copy as a new lab; never over an existing one', () => {
  const out = transfer.duplicateLab('ident.lab.yml', 'ident-dup');
  assert.deepStrictEqual(out, { name: 'ident-dup.lab.yml' });
  const text = fs.readFileSync(path.join(dir, 'ident-dup.lab.yml'), 'utf-8');
  assert.match(text, /^# copy of ident\.lab\.yml, made in labber-pve \d{4}-\d{2}-\d{2}\n# \(node uuid/);
  assert.deepStrictEqual(yaml.load(text).nodes.n1, { kind: 'f5_bigip_ve', cores: 4 });
  assert.throws(() => transfer.duplicateLab('ident.lab.yml', 'ident-dup'), (e) => e.status === 409);
  assert.throws(() => transfer.duplicateLab('nope.lab.yml', 'x9'), /Unknown lab file/);
  assert.throws(() => transfer.duplicateLab('ident.lab.yml', 'bad name'), /alphanumeric/);
});

test('with nothing to leave out, clean copies and duplicates keep the text and its comments', () => {
  const plain = '# my notes\nnodes:\n  n1:\n    kind: fortios # inline note\nlinks: []\n';
  transfer.importLab('plain', plain);
  assert.strictEqual(transfer.cleanCopy(plain).text, plain);
  assert.strictEqual(transfer.cleanCopy(plain).removed, 0);
  const clean = transfer.exportLab('plain.lab.yml', { clean: true }).text;
  assert.ok(clean.endsWith(plain) && !clean.includes('left out'));
  transfer.duplicateLab('plain.lab.yml', 'plain-dup');
  assert.ok(fs.readFileSync(path.join(dir, 'plain-dup.lab.yml'), 'utf-8').endsWith(plain));
});
