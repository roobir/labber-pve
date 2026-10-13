// Writes a value into the Store -- e.g. a configuration captured from a
// device, so a later runbook (f5-load-config) can load it back.
//
//   store:
//     save:
//       name: "{{inputs.entry_name}}"          # created if new
//       value: "{{steps.read.out.config}}"
//       group: lab                             # optional
//       description: "captured from node1"    # optional
//       overwrite: "{{inputs.overwrite}}"      # yes | true; default: refuse to replace
//       type: secret                           # optional: text (default) | secret
//
// Deliberately narrow: it writes `text` entries, or -- with `type: secret` --
// a secret captured from a device (an F5 master key, say), which is masked
// in logs. It never touches a license, and it can only replace a secret that
// sits in the same, named group, so a runbook cannot overwrite the passwords
// you keep in the Store. Replacing an existing entry needs `overwrite`, and
// the Store keeps the previous value in its history either way.

const truthy = (v) => v === true || ['yes', 'true'].includes(String(v).toLowerCase());

function validate(spec) {
  if (!spec || typeof spec !== 'object' || Object.keys(spec).join() !== 'save') return ['store needs exactly: save'];
  const { name, value } = spec.save || {};
  return name && value !== undefined ? [] : ['store.save needs a name and a value'];
}

async function run(spec, rt) {
  const { name, value, group, description, overwrite, type = 'text' } = rt.render(spec.save);
  if (!['text', 'secret'].includes(type)) throw new Error(`store.save.type must be text or secret, not "${type}"`);
  if (!String(value).trim()) throw new Error(`nothing to save -- the captured value for "${name}" is empty`);
  if (type === 'secret') {
    rt.secret(value);
    if (!String(group || '').trim()) throw new Error('store.save with type secret needs a group');
  }

  let existing = null;
  try {
    existing = rt.deps.store.get(name);
  } catch (e) {
    // no such entry yet -- this creates it
  }
  if (existing && existing.type !== type) throw new Error(`"${name}" is a ${existing.type} entry; this runbook writes a ${type} entry -- choose another name`);
  if (existing && type === 'secret' && existing.group !== group) {
    throw new Error(`"${name}" is a secret in group "${existing.group || '(none)'}"; a runbook may only replace secrets in its own group ("${group}") -- choose another name`);
  }
  if (existing && !truthy(overwrite)) {
    throw new Error(`Store entry "${name}" already exists -- choose another name, or set overwrite to yes (its previous value is kept in history)`);
  }

  rt.deps.store.upsert(name, {
    type,
    value,
    group: group !== undefined ? group : existing ? existing.group : '',
    description: description !== undefined ? description : existing ? existing.description : '',
  }, rt.user);

  const bytes = Buffer.byteLength(value, 'utf-8');
  rt.log(`${existing ? 'updated' : 'created'} Store entry "${name}" (${(bytes / 1024).toFixed(1)} KB)`);
  return { out: { name, bytes } };
}

module.exports = { key: 'store', validate, run };
