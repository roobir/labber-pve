// Who is on which node's serial console right now. A Proxmox serial console
// is a single socket on the VM, so a person typing while a runbook is
// driving the same console would interleave keystrokes and corrupt the run.
// In-memory only (like sessions and login throttling): the app runs as one
// replica, and a restart kills every console session anyway.
//
// Two kinds of holder per node:
//   - at most one runbook run (exclusive: blocks humans and other runs)
//   - any number of humans (block a run from starting unless forced)
// A person who finds a runbook in control can take over, which aborts the
// run and waits for it to let go of the console before handing it over.

const TAKEOVER_WAIT_MS = 15 * 1000;
const nodes = new Map(); // key -> { runbook: holder|null, humans: Map(id -> {user, since}) }

function lockKey(lab, node) {
  return `${lab}/${node}`;
}

function entry(key) {
  if (!nodes.has(key)) nodes.set(key, { runbook: null, humans: new Map() });
  return nodes.get(key);
}

function prune(key) {
  const e = nodes.get(key);
  if (e && !e.runbook && e.humans.size === 0) nodes.delete(key);
}

function publicRunbook(holder) {
  if (!holder) return null;
  return { runId: holder.runId, runbook: holder.runbook, user: holder.user, since: holder.since };
}

function humansOf(key) {
  const e = nodes.get(key);
  return e ? [...e.humans.values()].map(({ user, since }) => ({ user, since })) : [];
}

function runbookHolder(key) {
  const e = nodes.get(key);
  return e ? publicRunbook(e.runbook) : null;
}

// holder: { runId, runbook, user, abort(reason) }. Returns
// { ok: true, release } or { ok: false, holder } describing who is in the way.
function acquireRunbook(key, holder, { force = false } = {}) {
  const e = entry(key);
  if (e.runbook) {
    return { ok: false, holder: { type: 'runbook', ...publicRunbook(e.runbook) } };
  }
  if (e.humans.size > 0 && !force) {
    return { ok: false, holder: { type: 'user', users: humansOf(key) } };
  }
  let done;
  const released = new Promise((resolve) => { done = resolve; });
  e.runbook = { ...holder, since: new Date().toISOString(), released };
  const mine = e.runbook;
  return {
    ok: true,
    release() {
      if (e.runbook === mine) e.runbook = null;
      done();
      prune(key);
    },
  };
}

// Registers an open human console session; returns the function that ends it.
function joinHuman(key, user) {
  const e = entry(key);
  const id = Symbol('console-session');
  e.humans.set(id, { user, since: new Date().toISOString() });
  return () => {
    e.humans.delete(id);
    prune(key);
  };
}

// Aborts the runbook holding `key` and resolves once it has released the
// console (or after a timeout, so a wedged run can't block the takeover).
async function takeover(key, byUser) {
  const e = nodes.get(key);
  const holder = e && e.runbook;
  if (!holder) return;
  holder.abort(`console taken over by ${byUser}`);
  await Promise.race([
    holder.released,
    new Promise((resolve) => setTimeout(resolve, TAKEOVER_WAIT_MS)),
  ]);
}

// Flat view for the presence indicator: [{ key, user, since }] of humans.
function humanSessions() {
  const out = [];
  for (const [key, e] of nodes) {
    for (const { user, since } of e.humans.values()) out.push({ key, user, since });
  }
  return out;
}

module.exports = { lockKey, runbookHolder, acquireRunbook, joinHuman, takeover, humansOf, humanSessions };
