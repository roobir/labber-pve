// "{{inputs.host}}", "{{store.password-simple}}", "{{steps.getip.out.ip}}",
// "{{store.lic-01.licenseText | b64}}", "{{inputs.prefix | netmask}}". A value that can't be resolved is an
// error rather than an empty string: silently sending a blank password or
// registration key to a device is far worse than stopping the run.

const TOKEN_RE = /\{\{\s*([\w.\-\[\]]+?)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

// 24 -> 255.255.255.0 (for CLIs that want a dotted netmask, not a prefix)
function netmask(prefix) {
  const n = Number(prefix);
  if (!Number.isInteger(n) || n < 0 || n > 32) throw new Error(`"${prefix}" is not a prefix length between 0 and 32`);
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 255).join('.');
}

const FILTERS = {
  netmask,
  b64: (v) => Buffer.from(v, 'utf-8').toString('base64'),
  url: (v) => encodeURIComponent(v),
  trim: (v) => v.trim(),
};

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// ctx.onResolve(path, value) lets the engine notice when a secret is
// pulled into a request so it can be redacted from logs afterwards.
function renderString(str, ctx) {
  return str.replace(TOKEN_RE, (_, expr, filter) => {
    const value = getPath(ctx, expr);
    if (value === undefined || value === null) throw new Error(`unknown variable "{{${expr}}}"`);
    if (typeof value === 'object') {
      throw new Error(`"{{${expr}}}" is a group of fields -- pick one (e.g. ${expr}.regkey)`);
    }
    if (ctx.onResolve) ctx.onResolve(expr, String(value));
    let out = String(value);
    if (filter) {
      if (!FILTERS[filter]) throw new Error(`unknown filter "${filter}" in "{{${expr} | ${filter}}}"`);
      out = FILTERS[filter](out);
    }
    return out;
  });
}

function render(value, ctx) {
  if (typeof value === 'string') return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => render(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, ctx)]));
  }
  return value;
}

// Names of every {{inputs.X}} / {{store.X}} a definition mentions, found
// statically (no ctx needed) for validation and the "where is this used"
// check before deleting a store entry.
function references(value, root) {
  const found = new Set();
  const re = new RegExp(`\\{\\{\\s*${root}\\.([\\w\\-]+)`, 'g');
  for (const m of JSON.stringify(value).matchAll(re)) found.add(m[1]);
  return [...found];
}

module.exports = { render, getPath, references };
