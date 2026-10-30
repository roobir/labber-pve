const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const audit = require('../lib/audit/log');

// Stand-ins for Proxmox: lab-manager is not consulted (resolveVmid is
// stubbed), and a console session is a plain object.
const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
let closes = 0;
stub('../lib/lab-manager', {});
stub('../lib/console-session', {
  resolveVmid: async () => 101,
  openConsoleSession: async () => ({ send() {}, resize() {}, close() { closes += 1; } }),
});
const { handleConnection } = require('../lib/console-bridge');

function fakeWs() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (m) => ws.sent.push(JSON.parse(m));
  return ws;
}
const req = { session: { username: 'nico' }, socket: { remoteAddress: '10.16.0.9' }, headers: { 'x-real-ip': '192.0.2.5' } };
const tick = () => new Promise((r) => setImmediate(r));

test('opening and closing a console is recorded once each, with the duration', async () => {
  const ws = fakeWs();
  handleConnection(ws, req);
  ws.emit('message', JSON.stringify({ type: 'connect', lab: 'lab1.lab.yml', node: 'node1' }));
  await tick();
  assert.ok(ws.sent.some((m) => m.type === 'connected'));
  ws.emit('message', JSON.stringify({ type: 'input', data: 'secret-typed-password\r' }));
  ws.emit('message', JSON.stringify({ type: 'disconnect' }));
  ws.emit('close'); // the browser closing afterwards must not record a second close
  const [close, open] = audit.query();
  assert.deepStrictEqual([open.action, open.user, open.ip, open.target], ['console.open', 'nico', '192.0.2.5', 'lab1.lab.yml/node1']);
  assert.deepStrictEqual([close.action, close.target, typeof close.detail.seconds], ['console.close', 'lab1.lab.yml/node1', 'number']);
  assert.strictEqual(audit.query().length, 2);
  assert.strictEqual(closes, 1);
  assert.ok(!JSON.stringify(audit.query()).includes('secret-typed'), 'keystrokes are never recorded');
});
