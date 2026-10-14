const test = require('node:test');
const assert = require('node:assert');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const { health } = require('../lib/backup/health');

const now = new Date('2026-12-20T12:00:00Z');
const days = (n) => new Date(now - n * 86400000).toISOString();
const base = { repoUrl: 'https://x/a/b', token: 't', schedule: { frequency: 'monthly', day: 1, time: '02:00' }, scheduleSince: days(100), last: null };

test('no warning when backups are not scheduled', () => {
  assert.strictEqual(health({ ...base, repoUrl: '' }, now), null);
  assert.strictEqual(health({ ...base, token: '' }, now), null);
  assert.strictEqual(health({ ...base, schedule: { ...base.schedule, frequency: 'off' }, last: { ok: false, at: days(1), error: 'x' } }, now), null, 'manual-only');
});

test('the last backup failed -> failed, whatever its age', () => {
  const w = health({ ...base, last: { ok: false, at: days(1), error: '401 Bad credentials' } }, now);
  assert.strictEqual(w.state, 'failed');
  assert.match(w.message, /failed: 401 Bad credentials/);
});

test('overdue after 40 days (monthly) or 10 days (weekly) without a good backup', () => {
  assert.strictEqual(health({ ...base, last: { ok: true, at: days(39) } }, now), null);
  assert.strictEqual(health({ ...base, last: { ok: true, at: days(41) } }, now).state, 'overdue');
  const weekly = { ...base, schedule: { ...base.schedule, frequency: 'weekly' } };
  assert.strictEqual(health({ ...weekly, last: { ok: true, at: days(9) } }, now), null);
  assert.match(health({ ...weekly, last: { ok: true, at: days(11) } }, now).message, /No backup since/);
});

test('never backed up: counted from when backups were set up', () => {
  assert.strictEqual(health({ ...base, scheduleSince: days(5) }, now), null);
  assert.match(health(base, now).message, /No backup has run since backups were set up/);
});
