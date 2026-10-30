const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
process.env.SESSION_SECRET = 'test';
process.env.DASHBOARD_USERNAME = 'nico';
process.env.DASHBOARD_PASSWORD_HASH = bcrypt.hashSync('right-pw', 4);
process.env.LOGIN_MAX_ATTEMPTS = '3';
const audit = require('../lib/audit/log');
const { login } = require('../lib/auth');

function attempt(username, password, ip) {
  return new Promise((resolve) => {
    const req = { body: { username, password }, socket: { remoteAddress: '10.16.0.9' }, headers: { 'x-real-ip': ip }, session: { regenerate: (cb) => cb() } };
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code || 200, body }); } };
    login(req, res);
  });
}

test('a failed sign-in keeps the name only when it is a real account', async () => {
  await attempt('nico', 'wrong', '192.0.2.1');
  await attempt('my-Secret-Pa55word', 'x', '192.0.2.1');
  const [unknown, known] = audit.query();
  assert.deepStrictEqual([known.user, known.result], ['nico', 'failed']);
  assert.strictEqual(unknown.user, '(unknown user)');
  assert.ok(!JSON.stringify(audit.query()).includes('Pa55word'));
});

test('the lockout is recorded once; attempts while locked out are not', async () => {
  for (let i = 0; i < 5; i += 1) await attempt('nico', 'wrong', '192.0.2.9');
  const fromIp = audit.query({ q: '192.0.2.9' });
  assert.deepStrictEqual(fromIp.map((e) => e.action), ['auth.lockout', 'auth.login', 'auth.login', 'auth.login']);
  assert.strictEqual((await attempt('nico', 'right-pw', '192.0.2.9')).code, 429);
});

test('a successful sign-in is recorded', async () => {
  const { code } = await attempt('nico', 'right-pw', '192.0.2.2');
  assert.strictEqual(code, 200);
  assert.deepStrictEqual([audit.query()[0].action, audit.query()[0].result, audit.query()[0].user], ['auth.login', 'ok', 'nico']);
});
