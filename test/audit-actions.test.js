const test = require('node:test');
const assert = require('node:assert');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const { describe } = require('../lib/audit/actions');
const { toCsv, filtersFrom } = require('../routes/audit');

test('known calls get a readable action and target', () => {
  assert.deepStrictEqual(describe('PUT', '/api/labs/my%20lab.lab.yml', 'raw yaml text'), { action: 'lab.save', target: 'my lab.lab.yml', detail: undefined });
  assert.strictEqual(describe('POST', '/api/labs/l.lab.yml/nodes/node1/power', { action: 'stop' }).detail.action, 'stop');
  assert.strictEqual(describe('POST', '/api/labs/l.lab.yml/nodes/node1/power', {}).target, 'l.lab.yml/node1');
  assert.strictEqual(describe('DELETE', '/api/runbooks/f5-x/1.2').action, 'runbook.delete');
  // lab entries name the lab by its file, as the lab routes and consoles do
  assert.strictEqual(describe('POST', '/api/labs/import', { name: 'n', text: 'secret-ish yaml' }).target, 'n.lab.yml');
  assert.strictEqual(describe('POST', '/api/labs', { name: ' n ' }).target, 'n.lab.yml');
  assert.deepStrictEqual(describe('POST', '/api/labs/a.lab.yml/duplicate', { name: 'b' }), { action: 'lab.duplicate', target: 'b.lab.yml', detail: { from: 'a.lab.yml' } });
  assert.strictEqual(describe('POST', '/api/labs', {}).target, '');
});

test('run.start names every target node, whatever the input id', () => {
  const d = describe('POST', '/api/runs', { name: 'f5-cluster-pair', inputs: { target: { lab: 'L', node: 'n1' }, peer: { lab: 'L', node: 'n2' }, admin_password: 'pw' } });
  assert.strictEqual(d.target, 'f5-cluster-pair latest');
  assert.strictEqual(d.detail.nodes, 'L/n1, L/n2');
  assert.ok(!JSON.stringify(d).includes('pw'));
});

test('secret-bearing bodies never reach the entry', () => {
  const cases = [
    ['POST', '/api/settings', { tokenSecret: 'S3CRET', host: 'pve' }],
    ['PUT', '/api/store/admin-pw', { type: 'secret', value: 'S3CRET' }],
    ['POST', '/api/users', { username: 'eve', password: 'S3CRET' }],
    ['POST', '/api/runs', { name: 'r', inputs: { pw: 'S3CRET' } }],
    ['POST', '/api/relay-tokens', { label: 'ci', token: 'S3CRET' }],
    ['POST', '/api/something-new', { password: 'S3CRET' }],
  ];
  for (const [m, p, body] of cases) {
    const text = JSON.stringify(describe(m, p, body));
    assert.ok(!text.includes('S3CRET'), `${m} ${p} leaked: ${text}`);
  }
  assert.strictEqual(describe('PUT', '/api/store/admin-pw', { type: 'secret', value: 'x' }).detail.type, 'secret');
});

test('calls that change nothing are skipped; unknown changes still recorded', () => {
  assert.strictEqual(describe('POST', '/api/settings/test', {}), null);
  assert.strictEqual(describe('POST', '/api/templates/preflight', {}), null);
  assert.strictEqual(describe('POST', '/api/presence', {}), null);
  assert.deepStrictEqual(describe('PATCH', '/api/labs/x', {}), { action: 'api.patch', target: '/api/labs/x' });
});

test('a bad %-escape does not throw', () => {
  assert.strictEqual(describe('DELETE', '/api/labs/%E0%A4%A').target, '%E0%A4%A');
});

test('CSV: quoted, quotes doubled, formula-looking cells defused', () => {
  const csv = toCsv([{ time: 't', user: '=cmd()', ip: '', action: 'lab.save', target: 'a "b"', result: 'ok', detail: { k: 'v' } }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.strictEqual(head, '"time","user","ip","action","target","result","detail"');
  assert.strictEqual(row, `"t","'=cmd()","","lab.save","a ""b""","ok","k=v"`);
});

test('filters: a bare `to` date means the end of that day', () => {
  assert.strictEqual(filtersFrom({ to: '2026-10-14' }).to, '2026-10-14T23:59:59.999Z');
  assert.strictEqual(filtersFrom({ to: '2026-10-14T10:00:00Z' }).to, '2026-10-14T10:00:00Z');
  assert.strictEqual(filtersFrom({ user: '  ' }).user, undefined);
});
