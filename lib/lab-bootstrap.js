const { parseTopology, readState, writeState } = require('./lab-files');
const runs = require('./runbooks/runs');
const library = require('./runbooks/library');
const store = require('./runbooks/store');

// Runs each node's `bootstrap:` runbooks after a lab is built and started
// (see lab-bootstrap-schema.js for the file syntax). Nodes run in parallel
// (capped); one node's list runs in order. Progress is saved in the lab's
// deploy state so a failed bootstrap can be retried from where it stopped --
// runbooks like f5-first-boot are not safe to run twice on the same node.
//
// state.bootstrap = { status: running|ok|failed, nodes: { <node>: {
//   done: <entries completed>, failed: null | { index, runbook, error, runId } } } }

const MAX_PARALLEL_NODES = 3;
const BUSY_RETRIES = 6;
const BUSY_WAIT_MS = 10 * 1000;
const inFlight = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entriesOf = (topo) => Object.entries(topo.nodes).filter(([, n]) => (n.bootstrap || []).length);

// Fail before anything is built: every named runbook and Store entry must exist.
function preflight(topo) {
  for (const [nodeName, spec] of entriesOf(topo)) {
    for (const entry of spec.bootstrap) {
      const version = library.resolveVersion(entry.runbook, entry.version);
      const { def } = library.get(entry.runbook, version);
      for (const input of def.inputs || []) {
        const given = (entry.inputs || {})[input.id] ?? input.default;
        if (input.type === 'store' && given !== undefined) store.get(String(given));
      }
      if (!(def.inputs || []).some((i) => i.type === 'target')) {
        throw new Error(`${nodeName}: runbook "${entry.runbook}" has no target input, so it cannot be bootstrapped onto a node`);
      }
    }
  }
}

function patchState(name, change) {
  const state = readState(name);
  if (!state) throw new Error('lab was destroyed while bootstrapping');
  change(state);
  writeState(name, state);
}

async function startRun(name, nodeName, entry, user) {
  const version = library.resolveVersion(entry.runbook, entry.version);
  const targetInput = library.get(entry.runbook, version).def.inputs.find((i) => i.type === 'target');
  const inputs = { [targetInput.id]: { lab: name, node: nodeName }, ...(entry.inputs || {}) };
  for (let attempt = 1; ; attempt++) {
    try {
      return runs.start({ name: entry.runbook, version, inputs, user });
    } catch (err) {
      if (err.status !== 409 || attempt >= BUSY_RETRIES) throw err;
      await sleep(BUSY_WAIT_MS); // someone is on this console; give them a moment
    }
  }
}

async function runEntry(name, nodeName, entry, user, onProgress) {
  const label = `[${nodeName}] ${entry.runbook}`;
  const started = await startRun(name, nodeName, entry, user);
  const unsubscribe = runs.subscribe(started.id, (e) => {
    if (e.type === 'step' && e.state !== 'running' && e.state !== 'skipped') onProgress(`${label}: ${e.name} ${e.state === 'ok' ? '✓' : '✗'}`);
  });
  const result = await runs.finished(started.id);
  if (unsubscribe) unsubscribe();
  return { ...result, runId: started.id };
}

async function runNode(name, nodeName, entries, user, onProgress) {
  const progress = () => readState(name).bootstrap.nodes[nodeName];
  for (let i = progress().done; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.wait) {
      onProgress(`[${nodeName}] waiting ${entry.wait}s before ${entry.runbook}`);
      await sleep(entry.wait * 1000);
    }
    onProgress(`[${nodeName}] running ${entry.runbook}...`);
    let result;
    try {
      result = await runEntry(name, nodeName, entry, user, onProgress);
    } catch (err) {
      result = { state: 'failed', error: err.message };
    }
    if (result.state === 'ok') {
      patchState(name, (s) => { s.bootstrap.nodes[nodeName].done = i + 1; });
      continue;
    }
    onProgress(`[${nodeName}] ${entry.runbook} ${result.state}: ${result.error}`);
    if (entry.onFail === 'continue') {
      patchState(name, (s) => { s.bootstrap.nodes[nodeName].done = i + 1; });
      continue;
    }
    patchState(name, (s) => { s.bootstrap.nodes[nodeName].failed = { index: i, runbook: entry.runbook, error: result.error, runId: result.runId || null }; });
    return false;
  }
  return true;
}

// -> { ok, failures: ["node1: f5-first-boot ..."] }. Safe to call again after
// a failure: finished entries are skipped, failed nodes resume at the failure.
async function run(name, { user, onProgress = () => {} }) {
  if (inFlight.has(name)) throw new Error(`bootstrap is already running for "${name}"`);
  inFlight.add(name);
  try {
    const topo = parseTopology(name);
    preflight(topo);
    const nodes = entriesOf(topo);
    if (!nodes.length) return { ok: true, failures: [] };

    patchState(name, (s) => {
      const prev = (s.bootstrap || {}).nodes || {};
      s.bootstrap = { status: 'running', nodes: Object.fromEntries(nodes.map(([n]) => [n, { done: (prev[n] || {}).done || 0, failed: null }])) };
    });

    const queue = nodes.slice();
    const results = [];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        results.push([item[0], await runNode(name, item[0], item[1].bootstrap, user, onProgress)]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_NODES, nodes.length) }, worker));

    const failures = results.filter(([, ok]) => !ok).map(([n]) => {
      const f = readState(name).bootstrap.nodes[n].failed;
      return `${n}: ${f.runbook} -- ${f.error}`;
    });
    patchState(name, (s) => { s.bootstrap.status = failures.length ? 'failed' : 'ok'; });
    return { ok: !failures.length, failures };
  } finally {
    inFlight.delete(name);
  }
}

module.exports = { run, preflight };
