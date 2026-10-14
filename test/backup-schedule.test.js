const test = require('node:test');
const assert = require('node:assert');
const { freshLabsDir } = require('./helpers');

freshLabsDir();
const { nextSlot, dueSlot, next } = require('../lib/backup/schedule');

// All in the process's local time, like the scheduler itself.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const monthly = { frequency: 'monthly', day: 1, time: '02:00' };
const weekly = { frequency: 'weekly', day: 1, time: '02:00' }; // Mondays
const base = { repoUrl: 'https://x/a/b', token: 't', schedule: monthly, scheduleSince: at(2026, 10, 14).toISOString(), lastSlot: null };

test('monthly: the next 1st at 02:00, rolling over months and years', () => {
  assert.deepStrictEqual(nextSlot(monthly, at(2026, 10, 14, 9)), at(2026, 11, 1, 2));
  assert.deepStrictEqual(nextSlot(monthly, at(2026, 11, 1, 1, 59)), at(2026, 11, 1, 2));
  assert.deepStrictEqual(nextSlot(monthly, at(2026, 11, 1, 2)), at(2026, 12, 1, 2), 'strictly after');
  assert.deepStrictEqual(nextSlot(monthly, at(2026, 12, 5)), at(2027, 1, 1, 2));
  assert.deepStrictEqual(nextSlot({ ...monthly, day: 28 }, at(2027, 2, 28, 3)), at(2027, 3, 28, 2));
});

test('weekly: the next Monday at 02:00', () => {
  assert.deepStrictEqual(nextSlot(weekly, at(2026, 10, 14, 9)), at(2026, 10, 19, 2)); // Wed -> Mon
  assert.deepStrictEqual(nextSlot(weekly, at(2026, 10, 19, 1)), at(2026, 10, 19, 2));
  assert.deepStrictEqual(nextSlot(weekly, at(2026, 10, 19, 2)), at(2026, 10, 26, 2));
});

test('nothing is due before the first slot after the schedule was saved', () => {
  assert.strictEqual(dueSlot(base, at(2026, 10, 31, 23)), null);
  assert.deepStrictEqual(dueSlot(base, at(2026, 11, 1, 2, 1)), at(2026, 11, 1, 2));
  assert.deepStrictEqual(next(base, at(2026, 10, 20)), at(2026, 11, 1, 2));
});

test('a slot runs once; after downtime only the latest missed slot runs', () => {
  const ran = { ...base, lastSlot: at(2026, 11, 1, 2).toISOString() };
  assert.strictEqual(dueSlot(ran, at(2026, 11, 20)), null);
  assert.deepStrictEqual(next(ran, at(2026, 11, 20)), at(2026, 12, 1, 2));
  assert.deepStrictEqual(dueSlot(base, at(2027, 2, 10)), at(2027, 2, 1, 2), 'Nov, Dec, Jan, Feb missed -> Feb only');
});

test('off, or no repository / token -> never due', () => {
  assert.strictEqual(dueSlot({ ...base, schedule: { ...monthly, frequency: 'off' } }, at(2027, 1, 1, 3)), null);
  assert.strictEqual(dueSlot({ ...base, token: '' }, at(2027, 1, 1, 3)), null);
  assert.strictEqual(dueSlot({ ...base, repoUrl: '' }, at(2027, 1, 1, 3)), null);
  assert.strictEqual(next({ ...base, token: '' }), null);
});
