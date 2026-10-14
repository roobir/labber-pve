const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshLabsDir } = require('./helpers');

const dir = freshLabsDir();
const { summary, kindOf } = require('../lib/audit/summary');

const now = new Date('2026-10-14T12:00:00Z');
const at = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
function write(entries) {
  fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
  for (const e of entries) {
    const day = e.time.slice(0, 10);
    fs.appendFileSync(path.join(dir, '.audit', `${day}.jsonl`), `${JSON.stringify({ ip: '', target: '', result: 'ok', ...e })}\n`);
  }
}

test('what counts, and as which kind', () => {
  assert.strictEqual(kindOf({ action: 'auth.login', result: 'ok' }), null);
  assert.strictEqual(kindOf({ action: 'lab.deploy', result: 'started' }), null);
  assert.strictEqual(kindOf({ action: 'lab.deploy', result: 'failed' }), 'labs');
  assert.strictEqual(kindOf({ action: 'node.power', result: 'ok' }), 'labs');
  assert.strictEqual(kindOf({ action: 'console.open', result: 'ok' }), 'consoles');
  assert.strictEqual(kindOf({ action: 'console.close', result: 'ok' }), null);
  assert.strictEqual(kindOf({ action: 'run.start', result: 'ok' }), 'runbooks');
  assert.strictEqual(kindOf({ action: 'runbook.lock', result: 'ok' }), 'runbooks');
  assert.strictEqual(kindOf({ action: 'store.save', result: 'ok' }), 'other');
  assert.strictEqual(kindOf({ action: 'backup.run', result: 'ok' }), 'other');
});

test('per-period ranking: 7 days, 30 days, everything kept', () => {
  write([
    { time: at(1), user: 'ahmed', action: 'lab.deploy', result: 'started' },
    { time: at(1), user: 'ahmed', action: 'lab.deploy' },
    { time: at(1), user: 'ahmed', action: 'console.open' },
    { time: at(2), user: 'ahmed', action: 'console.close' },
    { time: at(2), user: 'nico', action: 'lab.save' },
    { time: at(3), user: 'nico', action: 'auth.login' },
    { time: at(20), user: 'nico', action: 'run.start' },
    { time: at(20), user: 'nico', action: 'store.save' },
    { time: at(25), user: 'nico', action: 'lab.save' },
    { time: at(60), user: 'sara', action: 'lab.save' },
    { time: at(60), user: 'sara', action: 'lab.save' },
    { time: at(61), user: 'sara', action: 'runbook.save' },
    { time: at(61), user: 'sara', action: 'template.build' },
    { time: at(62), user: 'sara', action: 'console.open' },
  ]);
  const { periods, kinds } = summary(now);
  assert.deepStrictEqual(kinds, ['labs', 'runbooks', 'consoles', 'other']);
  assert.deepStrictEqual(periods.week.map((r) => [r.user, r.total]), [['ahmed', 2], ['nico', 1]]);
  assert.deepStrictEqual(periods.week[0].kinds, { labs: 1, runbooks: 0, consoles: 1, other: 0 });
  assert.deepStrictEqual(periods.month.map((r) => [r.user, r.total]), [['nico', 4], ['ahmed', 2]]);
  assert.deepStrictEqual(periods.all.map((r) => [r.user, r.total]), [['sara', 5], ['nico', 4], ['ahmed', 2]]);
  assert.deepStrictEqual(periods.all[0].kinds, { labs: 2, runbooks: 1, consoles: 1, other: 1 });
});

test('ties are ordered by name; an empty log gives empty periods', () => {
  write([{ time: at(0), user: 'zed', action: 'lab.save' }, { time: at(0), user: 'amy', action: 'store.save' }]);
  assert.deepStrictEqual(summary(now).periods.week.slice(0, 2).map((r) => r.user), ['ahmed', 'amy']);
  fs.rmSync(path.join(dir, '.audit'), { recursive: true });
  assert.deepStrictEqual(summary(now).periods, { week: [], month: [], all: [] });
});
