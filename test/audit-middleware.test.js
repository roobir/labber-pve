const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const audit = require('../lib/audit/log');
const { auditMiddleware } = require('../lib/audit/middleware');

// A stand-in app: a fake session from a header, the real middleware, and a
// few routes that answer the way the real ones do.
function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = { username: req.headers['x-user'] }; next(); });
  a.use(auditMiddleware);
  a.put('/api/labs/:name', (req, res) => res.json({ ok: true }));
  a.delete('/api/labs/:name', (req, res) => res.status(404).json({ error: 'Unknown lab file' }));
  a.post('/api/users', (req, res) => res.status(401).json({ error: 'not authenticated' }));
  a.get('/api/labs', (req, res) => res.json([]));
  a.post('/api/runs', (req) => req.socket.destroy()); // client sees the connection drop
  a.post('/login', (req, res) => res.json({}));
  return a;
}

let server;
let base;
test.before(async () => {
  server = app().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, path, body, user = 'nico') => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-user': user, 'x-real-ip': '192.0.2.7' },
  body: body ? JSON.stringify(body) : undefined,
}).catch(() => null);

const settle = () => new Promise((r) => setTimeout(r, 50));

test('a change is recorded with user, client IP and ok', async () => {
  await call('PUT', '/api/labs/a.lab.yml', { x: 1 });
  await settle();
  const [e] = audit.query();
  assert.deepStrictEqual([e.user, e.ip, e.action, e.target, e.result], ['nico', '192.0.2.7', 'lab.save', 'a.lab.yml', 'ok']);
});

test('failed / denied keep the status; aborted when no reply went out', async () => {
  await call('DELETE', '/api/labs/b.lab.yml');
  await call('POST', '/api/users', { username: 'x', password: 'p' });
  await call('POST', '/api/runs', { name: 'r' });
  await settle();
  const [aborted, denied, failed] = audit.query();
  assert.deepStrictEqual([failed.action, failed.result, failed.detail.status], ['lab.delete', 'failed', 404]);
  assert.deepStrictEqual([denied.action, denied.result, denied.detail.status], ['user.create', 'denied', 401]);
  assert.deepStrictEqual([aborted.action, aborted.result], ['run.start', 'aborted']);
});

test('upper case and trailing slashes reach the same routes, so they are recorded the same', async () => {
  await call('PUT', '/API/Labs/c.lab.yml/');
  await settle();
  const [e] = audit.query();
  assert.deepStrictEqual([e.action, e.target, e.result], ['lab.save', 'c.lab.yml', 'ok']);
});

test('reads and non-API paths are not recorded', async () => {
  const before = audit.query().length;
  await call('GET', '/api/labs');
  await call('POST', '/login', {});
  await settle();
  assert.strictEqual(audit.query().length, before);
});
