// Lab variables: a lab file may declare top-level `vars:` and use
// `{{vars.name}}` in any value, so one file can be copied and re-pointed
// (different external bridge, different license names) by editing a few
// lines at the top. A value that is *only* a placeholder keeps the variable's
// own type (so `cores: "{{vars.cores}}"` can be a number); a placeholder
// inside a longer string is substituted as text. Keys are never rendered.
//
// Rendering returns a copy. Code that writes a lab file back (mgmt IP, UUID/
// MAC pins) must dump the *raw* topology, or the placeholders would be
// flattened into their current values.

const TOKEN = /\{\{\s*vars\.([\w-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*vars\.([\w-]+)\s*\}\}$/;

function renderVars(topo) {
  if (!topo || typeof topo !== 'object') return topo;
  const vars = topo.vars && typeof topo.vars === 'object' ? topo.vars : {};

  const lookup = (name) => {
    if (!(name in vars)) throw new Error(`unknown lab variable "${name}" -- add it under \`vars:\``);
    return vars[name];
  };
  const render = (value) => {
    if (typeof value === 'string') {
      const whole = WHOLE.exec(value);
      return whole ? lookup(whole[1]) : value.replace(TOKEN, (_, name) => String(lookup(name)));
    }
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v)]));
    }
    return value;
  };

  const { vars: _own, ...rest } = topo;
  return { ...render(rest), ...(topo.vars !== undefined ? { vars: topo.vars } : {}) };
}

module.exports = { renderVars };
