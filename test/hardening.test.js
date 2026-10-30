const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshLabsDir } = require('./helpers');

const dir = freshLabsDir();
const { clientIp } = require('../lib/client-ip');
const { crossSiteReason } = require('../lib/same-origin');
const { writeFileAtomic, readJsonOrDefault } = require('../lib/atomic-write');
const { stagedIsoVolid } = require('../lib/template-builder');

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('client IP: proxy headers are believed from a private / loopback peer', () => {
  assert.strictEqual(clientIp(req('10.16.0.5', { 'x-real-ip': '192.168.1.40' })), '192.168.1.40');
  assert.strictEqual(clientIp(req('::ffff:192.168.1.251', { 'x-forwarded-for': '192.168.1.40, 10.0.0.1' })), '192.168.1.40');
  assert.strictEqual(clientIp(req('127.0.0.1', { 'x-real-ip': '1.2.3.4' })), '1.2.3.4');
  assert.strictEqual(clientIp(req('192.168.1.9')), '192.168.1.9');
});

test('client IP: a public peer cannot pick its own address', () => {
  assert.strictEqual(clientIp(req('203.0.113.7', { 'x-real-ip': '10.0.0.1' })), '203.0.113.7');
  assert.strictEqual(clientIp(req('::ffff:198.51.100.2', { 'x-forwarded-for': '1.1.1.1' })), '198.51.100.2');
  process.env.TRUST_PROXY = '1';
  try {
    assert.strictEqual(clientIp(req('203.0.113.7', { 'x-real-ip': '10.0.0.1' })), '10.0.0.1');
  } finally {
    delete process.env.TRUST_PROXY;
  }
});

test('same-origin: the dashboard itself, behind any of its host names, is allowed', () => {
  assert.strictEqual(crossSiteReason({ headers: { host: 'labber.example.com', origin: 'https://labber.example.com' } }), null);
  assert.strictEqual(crossSiteReason({ headers: { host: 'labber-direct.example.com:443', origin: 'https://labber-direct.example.com' } }), null);
  assert.strictEqual(crossSiteReason({ headers: { host: 'labber-pve:80', 'x-forwarded-host': 'labber.example.com', origin: 'https://labber.example.com' } }), null);
  assert.strictEqual(crossSiteReason({ headers: { host: 'localhost:8080', origin: 'http://localhost:8080' } }), null);
  // No Origin / Sec-Fetch-Site at all: curl, scripts -- not a browser page.
  assert.strictEqual(crossSiteReason({ headers: { host: 'labber.example.com' } }), null);
  assert.strictEqual(crossSiteReason({ headers: { host: 'labber.example.com', 'sec-fetch-site': 'same-origin' } }), null);
});

test('same-origin: a web rp appliance page (same site, other host) is refused', () => {
  assert.ok(crossSiteReason({ headers: { host: 'labber.example.com', origin: 'https://lab--fw1.gui.labber.example.com' } }));
  assert.ok(crossSiteReason({ headers: { host: 'labber.example.com', origin: 'null' } }));
  assert.ok(crossSiteReason({ headers: { host: 'labber.example.com', 'sec-fetch-site': 'same-site' } }));
  assert.ok(crossSiteReason({ headers: { host: 'labber.example.com', 'sec-fetch-site': 'cross-site' } }));
});

test('atomic write replaces the file and leaves no temp file behind', () => {
  const file = path.join(dir, 'a.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.deepStrictEqual(readJsonOrDefault(file, () => null), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('a.json')), ['a.json']);
});

test('a missing JSON file gives the default; a damaged one throws instead', () => {
  assert.strictEqual(readJsonOrDefault(path.join(dir, 'nope.json'), () => 'default'), 'default');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"users": [');
  assert.throws(() => readJsonOrDefault(bad, () => 'default'), /not valid JSON/);
});

test('a damaged users.json is never replaced by the bootstrap admin', () => {
  fs.mkdirSync(path.join(dir, '.config'), { recursive: true });
  const usersFile = path.join(dir, '.config', 'users.json');
  fs.writeFileSync(usersFile, '[{"username": "alice"');
  process.env.DASHBOARD_PASSWORD_HASH = '$2a$10$abcdefghijklmnopqrstuuJ8d7ZP9kGQ0jA9xqY2bXz3c4d5e6f7g';
  const userStore = require('../lib/user-store');
  assert.throws(() => userStore.list(), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(usersFile, 'utf-8'), '[{"username": "alice"');
});

test('finalize only removes the ISO this app staged for that vmid', () => {
  assert.strictEqual(stagedIsoVolid('ssd:iso/tpl-123-gaia.iso,media=cdrom,size=4G', 123), 'ssd:iso/tpl-123-gaia.iso');
  assert.strictEqual(stagedIsoVolid('ssd:iso/tpl-1234-gaia.iso,media=cdrom', 123), null);
  assert.strictEqual(stagedIsoVolid('ssd:iso/ubuntu-24.04.iso,media=cdrom', 123), null);
  assert.strictEqual(stagedIsoVolid('none,media=cdrom', 123), null);
  assert.strictEqual(stagedIsoVolid(undefined, 123), null);
});
