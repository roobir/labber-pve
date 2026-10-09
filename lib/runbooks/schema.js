const { typeOf, STEP_KEYS, CONTROL_KEYS } = require('./steps');
const { references } = require('./template');

// Validates a parsed runbook definition and reports *every* problem at once
// (one pass of "fix these 4 things" beats four round-trips).
//
//   title: F5 first boot            # shown in the library
//   vendor: f5_bigip_ve             # informational; also filters target pickers
//   inputs:
//     - { id: target, type: target, kind: f5_bigip_ve }
//     - { id: password, type: store, storeType: secret, default: password-simple }
//   steps:
//     - { id: login, name: Log in, console: [...] }

const INPUT_TYPES = ['string', 'secret', 'number', 'text', 'select', 'target', 'store'];
const STORE_TYPES = ['secret', 'text', 'license'];
const ID_RE = /^[A-Za-z][\w-]{0,40}$/;

function validateInputs(inputs, errors) {
  const seen = new Set();
  inputs.forEach((input, i) => {
    const at = `input ${i + 1}`;
    if (!input || !ID_RE.test(input.id || '')) return errors.push(`${at}: needs an id (letters, digits, - and _)`);
    if (seen.has(input.id)) errors.push(`${at}: duplicate id "${input.id}"`);
    seen.add(input.id);
    if (!INPUT_TYPES.includes(input.type)) errors.push(`input "${input.id}": type must be one of ${INPUT_TYPES.join(', ')}`);
    if (input.type === 'select' && !(Array.isArray(input.options) && input.options.length)) {
      errors.push(`input "${input.id}": select needs options`);
    }
    if (input.type === 'store' && input.storeType && !STORE_TYPES.includes(input.storeType)) {
      errors.push(`input "${input.id}": storeType must be one of ${STORE_TYPES.join(', ')}`);
    }
  });
}

function validateSteps(steps, inputIds, errors) {
  const seen = new Set();
  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    if (!step || !ID_RE.test(step.id || '')) return errors.push(`${at}: needs an id (letters, digits, - and _)`);
    if (seen.has(step.id)) errors.push(`${at}: duplicate id "${step.id}"`);
    seen.add(step.id);

    const type = typeOf(step);
    if (!type) {
      const extra = Object.keys(step).filter((k) => !CONTROL_KEYS.includes(k));
      return errors.push(`step "${step.id}": needs exactly one of ${STEP_KEYS.join(', ')} (found: ${extra.join(', ') || 'none'})`);
    }
    for (const msg of type.validate(step[type.key])) errors.push(`step "${step.id}": ${msg}`);
    if (step.target && !inputIds.has(step.target)) errors.push(`step "${step.id}": target "${step.target}" is not an input`);
    if (step.when && !(step.when.path && ('equals' in step.when || 'exists' in step.when))) errors.push(`step "${step.id}": when needs path and equals (or exists)`);
  });
}

function validateDefinition(def) {
  const errors = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw Object.assign(new Error('runbook must be a YAML mapping'), { details: ['runbook must be a YAML mapping'] });
  }
  const inputs = def.inputs || [];
  if (!Array.isArray(inputs)) errors.push('inputs must be a list');
  else validateInputs(inputs, errors);
  if (!Array.isArray(def.steps) || def.steps.length === 0) errors.push('steps must be a non-empty list');
  else validateSteps(def.steps, new Set(inputs.map((i) => i && i.id)), errors);

  if (!errors.length) {
    const ids = new Set(inputs.map((i) => i.id));
    for (const ref of references(def.steps, 'inputs')) {
      if (!ids.has(ref)) errors.push(`a step uses {{inputs.${ref}}} but there is no input "${ref}"`);
    }
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { details: errors });
  return def;
}

module.exports = { validateDefinition, INPUT_TYPES, STORE_TYPES };
