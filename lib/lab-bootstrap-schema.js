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
//           onFail: stop        stop (default) | continue

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
  }
}

module.exports = { validateBootstrapConfig };
