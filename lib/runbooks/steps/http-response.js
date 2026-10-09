const { getPath } = require('../template');

// Reading an HTTP response: does it satisfy an `expect`/`until`, what to show
// when it does not, and pulling named values out of it (`extract`).

function satisfied(res, cond) {
  const c = typeof cond === 'number' || Array.isArray(cond) ? { status: cond } : cond || {};
  if (c.status !== undefined && ![].concat(c.status).includes(res.status)) return false;
  if (c.status === undefined && (res.status < 200 || res.status >= 300)) return false;
  return !c.match || new RegExp(c.match, 'i').test(res.body);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

function extractAll(rules, res) {
  const out = {};
  for (const [name, rule] of Object.entries(rules || {})) {
    if (rule.json !== undefined) {
      const v = getPath(res.json, rule.json);
      if (v !== undefined) out[name] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    } else {
      const m = new RegExp(rule.regex, 'i').exec(res.body);
      if (m) out[name] = (m[1] !== undefined ? m[1] : m[0]).trim();
    }
  }
  return out;
}

// What to show when a response is not the expected one. F5's REST bash/tmsh
// endpoints echo the whole request back before the output, so the first 300
// characters of the raw body would be our own command -- show the device's
// own output (`commandResult`) or error `message` when there is one.
function describeFailure(res, expect) {
  const j = res.json;
  const own = j && (j.commandResult || j.message || (j.error && j.error.message));
  const detail = `HTTP ${res.status} ${String(own || res.body).trim().slice(0, 600)}`;
  // `expect: { message: ... }` lets a runbook say what a failure means in plain words
  return expect && expect.message ? `${expect.message} (${detail})` : `unexpected response: ${detail}`;
}


module.exports = { satisfied, parseJson, extractAll, describeFailure };
