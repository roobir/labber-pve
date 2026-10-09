// Turns the raw values a user submitted into the typed values a run uses,
// checking each against the runbook's declared inputs. Store-type inputs are
// resolved to the stored entry's value (a string, or a license's fields).

function resolveOne(input, raw, deps) {
  switch (input.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`"${input.id}" must be a number`);
      return n;
    }
    case 'select':
      if (!input.options.map(String).includes(String(raw))) throw new Error(`"${input.id}" must be one of: ${input.options.join(', ')}`);
      return String(raw);
    case 'store': {
      const entry = deps.store.get(String(raw));
      if (input.storeType && entry.type !== input.storeType) {
        throw new Error(`"${input.id}": store entry "${raw}" is a ${entry.type}, expected ${input.storeType}`);
      }
      return entry.type === 'license' ? { ...entry.license } : entry.value;
    }
    case 'target': {
      const { lab, node } = raw || {};
      const found = lab && node && deps.labs.getNode(lab, node);
      if (!found) throw new Error(`"${input.id}": pick a deployed lab and node`);
      const kinds = [].concat(input.kind || []);
      if (kinds.length && !kinds.includes(found.kind)) throw new Error(`"${input.id}": ${node} is ${found.kind}, this runbook needs ${kinds.join(' or ')}`);
      return { lab, node };
    }
    default:
      return String(raw);
  }
}

// -> { values, targets: { inputId: {lab,node} }, secretInputs: Set(inputId) }
function resolveInputs(def, given, deps) {
  const values = {};
  const targets = {};
  const secretInputs = new Set();
  for (const input of def.inputs || []) {
    let raw = given[input.id];
    if (raw === undefined || raw === '') raw = input.default;
    if (raw === undefined || raw === '') {
      if (input.optional) continue;
      throw new Error(`"${input.label || input.id}" is required`);
    }
    values[input.id] = resolveOne(input, raw, deps);
    if (input.type === 'target') targets[input.id] = values[input.id];
    const isSecretStore = input.type === 'store' && deps.store.get(String(raw)).type !== 'text';
    if (input.type === 'secret' || isSecretStore) secretInputs.add(input.id);
  }
  return { values, targets, secretInputs };
}

// The lab/node a run will act on by default (the first target input) --
// known before the run starts so its console lock can be taken up front.
function primaryTarget(def, given) {
  const input = (def.inputs || []).find((i) => i.type === 'target');
  const raw = input && given[input.id];
  return raw && raw.lab && raw.node ? { lab: raw.lab, node: raw.node } : null;
}

module.exports = { resolveInputs, primaryTarget };
