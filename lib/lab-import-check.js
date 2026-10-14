const library = require('./runbooks/library-read');
const store = require('./runbooks/store');
const vendors = require('./vendor-profiles');

// What an imported lab names that THIS labber does not have: kinds without a
// golden template (or without the template version a node pins), bootstrap
// runbooks or runbook versions, and Store entries the bootstrap runbooks'
// store inputs point at (the value given in the lab, else the runbook's
// default). Only warnings -- the lab is still imported, and the gaps can be
// filled before it is deployed. Takes the validated topology, so
// {{vars.x}} values are already resolved.
//
// One warning per missing thing, naming the nodes that need it -- a Store
// password used by every runbook on every node is reported once, not 20x.

function kindProblem(spec, kinds) {
  const kind = kinds.get(spec.kind);
  if (!kind) return `kind "${spec.kind}" is not one this labber supports`;
  if (spec.version !== undefined && !kind.versions[spec.version]) {
    return `no ${spec.kind} template version "${spec.version}" (Settings -> Templates)`;
  }
  if (spec.version === undefined && !kind.configured) return `no golden template for ${spec.kind} yet (Settings -> Templates)`;
  return null;
}

// -> { problem } or { storeNames: [...] } for one bootstrap entry
function entryNeeds(entry) {
  const versions = library.versionsOf(entry.runbook);
  if (!versions.length) return { problem: `runbook "${entry.runbook}" is not in this library` };
  const wanted = entry.version !== undefined && String(entry.version) !== 'latest' ? String(entry.version) : undefined;
  if (wanted && !versions.includes(wanted)) {
    return { problem: `runbook "${entry.runbook}" version ${wanted} is not here (this labber has ${versions.join(', ')})` };
  }
  let def;
  try {
    def = library.get(entry.runbook, library.resolveVersion(entry.runbook, wanted)).def;
  } catch (err) {
    return { problem: `runbook "${entry.runbook}": ${err.message}` };
  }
  const storeNames = [];
  for (const input of (def && def.inputs) || []) {
    if (input.type !== 'store') continue;
    const given = entry.inputs && entry.inputs[input.id];
    const value = given !== undefined && given !== null ? given : input.default;
    if (value !== undefined && value !== null && value !== '') storeNames.push(String(value));
  }
  return { storeNames };
}

function checkReferences(topo) {
  const kinds = new Map(vendors.listKinds().map((k) => [k.kind, k]));
  const inStore = new Set(store.list().map((e) => e.name));
  const problems = new Map(); // message -> Set(node)
  const note = (message, node) => {
    if (!problems.has(message)) problems.set(message, new Set());
    problems.get(message).add(node);
  };

  for (const [node, spec] of Object.entries(topo.nodes || {})) {
    const kindIssue = kindProblem(spec, kinds);
    if (kindIssue) note(kindIssue, node);
    for (const entry of spec.bootstrap || []) {
      const { problem, storeNames = [] } = entryNeeds(entry);
      if (problem) note(problem, node);
      for (const name of storeNames) if (!inStore.has(name)) note(`Store entry "${name}" is missing`, node);
    }
  }
  return [...problems].map(([message, nodes]) => `${message} -- ${[...nodes].join(', ')}`);
}

module.exports = { checkReferences };
