const crypto = require('crypto');
const library = require('./library');
const store = require('./store');
const engine = require('./engine');
const labDeps = require('./lab-deps');
const history = require('./run-history');
const { primaryTarget, resolveInputs } = require('./inputs');
const { createRedactor } = require('./redact');
const consoleLocks = require('../console-locks');
const { openConsoleSession } = require('../console-session');

// Run manager: starts runs, keeps their event log in memory (so a browser
// can attach late, or after minimizing the window), holds the node's console
// lock for the duration, and writes a redacted record to history when a run
// ends. Secrets are masked in every event before it is stored or sent.

const MAX_CONSOLE_BYTES = 256 * 1024;
const MAX_FINISHED_IN_MEMORY = 20;
const runs = new Map(); // runId -> run

const defaultDeps = {
  labs: labDeps,
  store: { get: store.get, resolveAll: store.resolveAll, upsert: store.upsert },
  openConsole: openConsoleSession,
};

const summary = ({ id, runbook, version, user, target, state, startedAt, endedAt, error }) =>
  ({ id, runbook, version, user, target, state, startedAt, endedAt, error });

// Console output is bulky: keep only the most recent MAX_CONSOLE_BYTES for
// late attachers, but never drop log/step events.
function record(run, redactor, event) {
  const safe = { ...event, at: Date.now() };
  if (safe.line) safe.line = redactor.apply(safe.line);
  if (safe.data) safe.data = redactor.apply(safe.data);
  run.events.push(safe);
  if (safe.type === 'console') {
    run.consoleBytes += safe.data.length;
    while (run.consoleBytes > MAX_CONSOLE_BYTES) {
      const oldest = run.events.findIndex((e) => e.type === 'console');
      run.consoleBytes -= run.events.splice(oldest, 1)[0].data.length;
    }
  }
  for (const fn of run.listeners) fn(safe);
}

function evictOldFinished() {
  const finished = [...runs.values()].filter((r) => r.state !== 'running');
  for (const r of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_IN_MEMORY))) runs.delete(r.id);
}

function acquireConsole(run, def, abortRun, force) {
  if (!run.target || !def.steps.some((s) => s.console)) return () => {};
  const key = consoleLocks.lockKey(run.target.lab, run.target.node);
  const lock = consoleLocks.acquireRunbook(
    key,
    { runId: run.id, runbook: `${run.runbook} ${run.version}`, user: run.user, abort: abortRun },
    { force }
  );
  if (!lock.ok) throw Object.assign(new Error('console is in use'), { status: 409, holder: lock.holder });
  return lock.release;
}

// -> run summary. Throws { status: 409, holder } if the console is busy.
function start({ name, version, inputs = {}, user, force, deps = defaultDeps }) {
  const resolved = library.resolveVersion(name, version);
  const { def, text } = library.get(name, resolved);
  library.parseAndValidate(text);
  resolveInputs(def, inputs, deps); // bad inputs fail the request now, not as a failed run

  const run = {
    id: crypto.randomUUID(), runbook: name, version: resolved, user,
    target: primaryTarget(def, inputs), state: 'running', startedAt: new Date().toISOString(),
    endedAt: null, error: null, events: [], consoleBytes: 0, listeners: new Set(),
  };
  run.finished = new Promise((resolve) => { run.settle = resolve; });
  const redactor = createRedactor();
  const abortController = new AbortController();
  const emit = (event) => record(run, redactor, event);
  run.abortRun = (why) => { run.abortReason = why; abortController.abort(); };

  const release = acquireConsole(run, def, run.abortRun, force);
  runs.set(run.id, run);
  emit({ type: 'log', line: `run started by ${user}: ${name} ${resolved}` });

  engine
    .execute({ def, given: inputs, deps, emit, signal: abortController.signal, registerSecret: redactor.add, user })
    .then(() => { run.state = 'ok'; })
    .catch((err) => {
      const aborted = abortController.signal.aborted;
      run.state = aborted ? 'aborted' : 'failed';
      run.error = redactor.apply(aborted ? run.abortReason || 'aborted' : err.message);
    })
    .finally(() => {
      release();
      run.endedAt = new Date().toISOString();
      emit({ type: 'done', state: run.state, error: run.error });
      history.persist({ ...summary(run), events: run.events.filter((e) => e.type !== 'console') });
      run.settle(summary(run));
      evictOldFinished();
    });

  return summary(run);
}

// Resolves with the run's summary once it has ended (any outcome).
function finished(runId) {
  const run = runs.get(runId);
  return run ? run.finished : Promise.reject(new Error('unknown run'));
}

function abort(runId, why) {
  const run = runs.get(runId);
  if (!run || run.state !== 'running') throw new Error('no such running run');
  run.abortRun(why);
}

// Calls fn(event) for everything so far, then for each new event. Returns
// an unsubscribe function, or null if the run is unknown.
function subscribe(runId, fn) {
  const run = runs.get(runId);
  if (!run) return null;
  run.events.forEach(fn);
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

function listRecent() {
  const live = [...runs.values()].map(summary);
  const seen = new Set(live.map((r) => r.id));
  const saved = history.readAll().filter((r) => !seen.has(r.id)).map(({ events, ...rest }) => rest);
  return [...live, ...saved].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}

function getRecord(runId) {
  const live = runs.get(runId);
  if (live) return { ...summary(live), events: live.events.filter((e) => e.type !== 'console') };
  return history.read(runId);
}

module.exports = { start, abort, finished, subscribe, listRecent, getRecord };
