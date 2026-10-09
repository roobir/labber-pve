// Step type registry. A step is `id` + (optional) `name`/`when`/
// `continueOnError`/`target` + exactly one key naming its type.
const steps = [require('./console'), require('./http'), require('./lab'), require('./store'), require('./wait')];

const BY_KEY = Object.fromEntries(steps.map((s) => [s.key, s]));
const CONTROL_KEYS = ['id', 'name', 'when', 'continueOnError', 'target'];

function typeOf(step) {
  const keys = Object.keys(step).filter((k) => !CONTROL_KEYS.includes(k));
  return keys.length === 1 ? BY_KEY[keys[0]] || null : null;
}

module.exports = { typeOf, STEP_KEYS: Object.keys(BY_KEY), CONTROL_KEYS };
