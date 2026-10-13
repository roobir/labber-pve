// Validation for the lab-file settings that drive post-deploy bootstrap:
//
//   vars:                       values for {{vars.x}} (see lab-vars.js)
//   onDeployFailure: rollback   rollback (default) | keep -- what to do with a
//                               half-built lab when deploy itself fails
//   onBootstrapFailure: keep    keep (default) | destroy -- what to do with a
//                               built lab when a bootstrap runbook fails
//   nodes:
//     node1:
//       bootstrap:              runbooks run on this node, in order, once it
//         - runbook: f5-first-boot     has been built and started
//           version: "1.0"      optional; default = highest locked version
//           inputs: { license: lic-lab-01 }   the node itself is filled in
//           wait: 30            optional: seconds to pause before this one
//           waitFor: node2      optional: first wait until node2's bootstrap
//                               has finished (a node name, or a list of them)
//           onFail: stop        stop (default) | continue
//       A runbook with a second node input (e.g. f5-cluster-pair's `peer`)
//       takes that node's name as the value: inputs: { peer: node2 }

const VERSION_RE = /^(\d{1,4}\.\d{1,4}|latest)$/;
const RUNBOOK_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

function validateEntry(nodeName, entry, i) {
  const at = `Node "${nodeName}" bootstrap #${i + 1}`;
  if (!isMap(entry) || !RUNBOOK_RE.test(String(entry.runbook || ''))) throw new Error(`${at}: needs \`runbook\` (a runbook name)`);
  if (entry.version !== undefined && !VERSION_RE.test(String(entry.version))) throw new Error(`${at}: \`version\` must look like 1.0 (or "latest")`);
  if (entry.inputs !== undefined && !isMap(entry.inputs)) throw new Error(`${at}: \`inputs\` must be a map`);
  if (entry.wait !== undefined && !(Number.isFinite(entry.wait) && entry.wait >= 0)) throw new Error(`${at}: \`wait\` must be a number of seconds`);
  if (entry.onFail !== undefined && !['stop', 'continue'].includes(entry.onFail)) throw new Error(`${at}: \`onFail\` must be stop or continue`);
  if (entry.waitFor !== undefined) {
    const names = [].concat(entry.waitFor);
    if (!names.length || names.some((n) => typeof n !== 'string' || !n)) throw new Error(`${at}: \`waitFor\` must be a node name or a list of node names`);
    if (names.includes(nodeName)) throw new Error(`${at}: a node cannot wait for itself`);
  }
}

function validateBootstrapConfig(topo) {
  if (topo.vars !== undefined) {
    if (!isMap(topo.vars)) throw new Error('`vars` must be a map of name -> value');
    for (const [k, v] of Object.entries(topo.vars)) {
      if (!/^[\w-]+$/.test(k)) throw new Error(`variable name "${k}" may use letters, digits, - and _ only`);
      if (v !== null && typeof v === 'object') throw new Error(`variable "${k}" must be a single value, not a list or map`);
    }
  }
  if (topo.onDeployFailure !== undefined && !['rollback', 'keep'].includes(topo.onDeployFailure)) {
    throw new Error('`onDeployFailure` must be rollback or keep');
  }
  if (topo.onBootstrapFailure !== undefined && !['keep', 'destroy'].includes(topo.onBootstrapFailure)) {
    throw new Error('`onBootstrapFailure` must be keep or destroy');
  }
  for (const [nodeName, spec] of Object.entries(topo.nodes)) {
    if (spec.bootstrap === undefined) continue;
    if (!Array.isArray(spec.bootstrap)) throw new Error(`Node "${nodeName}": \`bootstrap\` must be a list`);
    spec.bootstrap.forEach((entry, i) => validateEntry(nodeName, entry, i));
    for (const entry of spec.bootstrap) {
      for (const other of [].concat(entry.waitFor || [])) {
        if (!topo.nodes[other]) throw new Error(`Node "${nodeName}": waitFor names "${other}", which is not a node in this lab`);
        if (!(topo.nodes[other].bootstrap || []).length) throw new Error(`Node "${nodeName}": waitFor names "${other}", which has no bootstrap to wait for`);
      }
    }
  }
  bootstrapOrder(topo);
}

// Nodes in the order their bootstraps may start so that every `waitFor`
// points at a node that started earlier; throws on a cycle (A waits for B,
// B waits for A), which could never finish.
function bootstrapOrder(topo) {
  const names = Object.keys(topo.nodes).filter((n) => (topo.nodes[n].bootstrap || []).length);
  const deps = (n) => [...new Set(topo.nodes[n].bootstrap.flatMap((e) => [].concat(e.waitFor || [])))];
  const order = [];
  const state = {};
  const visit = (n, path) => {
    if (state[n] === 'done') return;
    if (state[n] === 'visiting') throw new Error(`bootstrap waitFor loop: ${[...path, n].join(' -> ')}`);
    state[n] = 'visiting';
    for (const d of deps(n)) visit(d, [...path, n]);
    state[n] = 'done';
    order.push(n);
  };
  names.forEach((n) => visit(n, []));
  return order;
}

module.exports = { validateBootstrapConfig, bootstrapOrder };
