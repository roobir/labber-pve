const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { freshLabsDir } = require('./helpers');

const dir = freshLabsDir();
const audit = require('../lib/audit/log');

test('record writes one JSON line per entry into the UTC day file', () => {
  const e = audit.record({ user: 'nico', ip: '10.0.0.1', action: 'lab.save', target: 'a.lab.yml' });
  const file = path.join(dir, '.audit', `${e.time.slice(0, 10)}.jsonl`);
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
  assert.deepStrictEqual(JSON.parse(lines.at(-1)), e);
  assert.strictEqual(e.result, 'ok');
});

test('detail drops empty fields, stringifies objects and clips long text', () => {
  const e = audit.record({ user: 'u', action: 'x', detail: { a: '', b: undefined, c: null, d: { k: 1 }, e: 'y'.repeat(500), f: 0 } });
  assert.deepStrictEqual(Object.keys(e.detail), ['d', 'e', 'f']);
  assert.strictEqual(e.detail.d, '{"k":1}');
  assert.ok(e.detail.e.length <= 201);
  assert.strictEqual(audit.record({ action: 'y', detail: {} }).detail, undefined);
});

test('query: newest first, filters by user, action prefix, text and time', () => {
  audit.record({ user: 'alice', action: 'lab.deploy', target: 'lab-one' });
  audit.record({ user: 'bob', action: 'console.open', target: 'lab-one/node1' });
  audit.record({ user: 'alice', action: 'store.save', target: 'secret-x' });
  assert.strictEqual(audit.query()[0].action, 'store.save');
  assert.deepStrictEqual(audit.query({ user: 'alice' }).map((e) => e.action), ['store.save', 'lab.deploy']);
  assert.deepStrictEqual(audit.query({ action: 'lab' }).map((e) => e.action), ['lab.deploy', 'lab.save']);
  assert.strictEqual(audit.query({ action: 'la' }).length, 0, 'a prefix must end at a dot');
  assert.deepStrictEqual(audit.query({ q: 'NODE1' }).map((e) => e.user), ['bob']);
  assert.strictEqual(audit.query({ from: '2999-01-01' }).length, 0);
  assert.strictEqual(audit.query({ to: '2000-01-01' }).length, 0);
  assert.strictEqual(audit.query({ limit: 2 }).length, 2);
});

test('a torn line (crash mid-write) is skipped, not fatal', () => {
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, '.audit', `${day}.jsonl`), '{"time":"broken\n');
  audit.record({ user: 'after', action: 'z' });
  assert.strictEqual(audit.query()[0].user, 'after');
});

test('retention removes day files older than the limit when a new day starts', () => {
  const old = path.join(dir, '.audit', '2001-01-01.jsonl');
  const notAudit = path.join(dir, '.audit', 'notes.txt');
  fs.writeFileSync(old, '{}\n');
  fs.writeFileSync(notAudit, 'keep me');
  // a fresh process's first write prunes; simulate by re-requiring the module
  delete require.cache[require.resolve('../lib/audit/log')];
  require('../lib/audit/log').record({ action: 'prune-trigger' });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(notAudit), 'only <date>.jsonl files are ever removed');
});

test('a write failure never throws', () => {
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'a file where the directory should be');
  process.env.LABS_DIR = blocker;
  delete require.cache[require.resolve('../lib/audit/log')];
  const fresh = require('../lib/audit/log');
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.doesNotThrow(() => fresh.record({ action: 'x' }));
  } finally {
    console.error = orig;
    process.env.LABS_DIR = dir;
  }
  assert.match(errors[0], /could not write the audit log/);
});

test('target filter: the lab itself and its nodes, not labs with a longer name', () => {
  audit.record({ user: 'u', action: 'lab.save', target: 'lab1.lab.yml' });
  audit.record({ user: 'u', action: 'console.open', target: 'lab1.lab.yml/node1' });
  audit.record({ user: 'u', action: 'lab.save', target: 'lab10.lab.yml' });
  audit.record({ user: 'u', action: 'lab.save', target: 'lab1.lab.yml.bak' });
  assert.deepStrictEqual(audit.query({ target: 'lab1.lab.yml' }).map((e) => e.target), ['lab1.lab.yml/node1', 'lab1.lab.yml']);
});
