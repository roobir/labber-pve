const { request } = require('../http-client');
const { satisfied, parseJson, extractAll, describeFailure } = require('./http-response');
const retryHelper = require('./http-retry');

// HTTP(S) call against the target node's management interface.
//
//   http:
//     method: POST
//     path: /mgmt/tm/sys/license
//     auth: { user: admin, password: "{{store.password-simple}}" }   # basic
//     headers: { X-PAN-KEY: "{{steps.key.out.key}}" }
//     query: { type: op, cmd: "<show>...</show>" }    # URL-encoded for you
//     json: { command: install }                       # or body: "raw text"
//     expect: 200                  # number | [numbers] | { status, match, message }
//                                  # (default: any 2xx; message = what a failure
//                                  # means, shown instead of the raw response)
//     poll: { every: 10, timeout: 600, initialDelay: 30,
//             until: { status: 200, match: "regex on body" } }
//     timeout: 120                 # seconds per request (default 60)
//     retry: { on: [404, 503], match: 'busy', every: 10, timeout: 600 }
//                                  # ask again while the device says it is not ready
//     eachChunk: { value: "{{inputs.cfg | b64}}", size: 60000 }
//                                  # send the request once per piece of a long
//                                  # value, as {{chunk}} ({{chunkIndex}}, {{chunkCount}})
//     extract: { token: { json: "token" }, job: { regex: "<job>(\\d+)</job>" } }
//
// With `poll` the request repeats until `until` is satisfied, tolerating
// connection errors in between (a rebooting device) -- it is how a runbook
// waits for a service to come back.

const POLL_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_S = 60; // license activation etc. can be slow
const DEFAULT_CHUNK_CHARS = 60000; // well under a shell argument's ~128 KB limit

function validate(spec) {
  if (!spec || typeof spec !== 'object') return ['http must be an object'];
  const errors = [];
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) errors.push('http.path must start with "/"');
  if (spec.json !== undefined && spec.body !== undefined) errors.push('http: use either json or body, not both');
  if (spec.poll && !(spec.poll.every > 0 && spec.poll.timeout > 0)) errors.push('http.poll needs every and timeout (seconds)');
  if (spec.eachChunk && !spec.eachChunk.value) errors.push('http.eachChunk needs a value');
  if (spec.retry) errors.push(...retryHelper.validate(spec.retry));
  for (const [name, rule] of Object.entries(spec.extract || {})) {
    if (!rule || (rule.json === undefined) === (rule.regex === undefined)) errors.push(`http.extract.${name}: use exactly one of json or regex`);
  }
  return errors;
}

function buildRequest(spec, target) {
  const headers = { accept: 'application/json, */*', ...(spec.headers || {}) };
  if (spec.auth) {
    headers.authorization = `Basic ${Buffer.from(`${spec.auth.user}:${spec.auth.password}`).toString('base64')}`;
  }
  let body = spec.body;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    headers['content-type'] = 'application/json';
  }
  const qs = spec.query ? `${spec.path.includes('?') ? '&' : '?'}${new URLSearchParams(spec.query)}` : '';
  return {
    scheme: spec.scheme,
    host: target.ip,
    port: spec.port || target.port,
    method: (spec.method || 'GET').toUpperCase(),
    path: spec.path + qs,
    headers,
    body,
  };
}

async function attempt(req, rt, timeoutMs) {
  const res = await request({ ...req, timeoutMs, signal: rt.signal });
  res.json = parseJson(res.body);
  return res;
}

async function pollUntil(req, spec, rt) {
  const { every, timeout, initialDelay = 0, until = { status: 200 } } = spec.poll;
  if (initialDelay) {
    rt.log(`waiting ${initialDelay}s before polling`);
    await rt.sleep(initialDelay * 1000);
  }
  const deadline = Date.now() + timeout * 1000;
  for (let n = 1; ; n++) {
    try {
      const res = await attempt(req, rt, POLL_REQUEST_TIMEOUT_MS);
      rt.log(`poll #${n}: HTTP ${res.status}`);
      if (satisfied(res, until)) return res;
    } catch (err) {
      if (err.message === 'aborted') throw err;
      rt.log(`poll #${n}: ${err.code || err.message}`);
    }
    if (Date.now() + every * 1000 > deadline) throw new Error(`poll gave up after ${timeout}s`);
    await rt.sleep(every * 1000);
  }
}

async function runOnce(rawSpec, rt, extra) {
  const spec = rt.render(rawSpec, extra);
  const target = rt.target();
  if (!target.ip) {
    throw new Error(`${target.node} has no mgmt IP saved yet -- run a first-boot / set-IP runbook, or set it on its dashboard card`);
  }
  const req = buildRequest(spec, target);
  rt.log(`${req.method} ${spec.path} -> ${target.ip}:${req.port}`); // path only: the query may carry credentials

  let res;
  if (spec.poll) {
    res = await pollUntil(req, spec, rt);
  } else {
    const timeoutMs = (spec.timeout || DEFAULT_REQUEST_TIMEOUT_S) * 1000;
    res = await retryHelper.withRetry(() => attempt(req, rt, timeoutMs), spec.retry, rt);
    if (!satisfied(res, spec.expect)) {
      throw new Error(describeFailure(res, spec.expect));
    }
  }
  rt.log(`HTTP ${res.status}`);
  return { status: res.status, body: res.body.slice(0, 20000), json: res.json, out: extractAll(spec.extract, res) };
}

// With `eachChunk`, one request per piece of a long value -- how a big
// payload gets past per-request limits (a shell argument holds ~128 KB).
// The pieces are not logged; only their count.
async function run(rawSpec, rt) {
  const { eachChunk, ...rest } = rawSpec;
  if (!eachChunk) return runOnce(rawSpec, rt, undefined);

  const { value, size } = rt.render(eachChunk);
  const step = Number(size) > 0 ? Number(size) : DEFAULT_CHUNK_CHARS;
  const text = String(value);
  const count = Math.max(1, Math.ceil(text.length / step));
  rt.log(`sending in ${count} part(s) of up to ${step} characters`);
  let last;
  for (let i = 0; i < count; i++) {
    rt.log(`part ${i + 1} of ${count}`);
    last = await runOnce(rest, rt, { chunk: text.slice(i * step, (i + 1) * step), chunkIndex: i, chunkCount: count });
  }
  return last;
}

module.exports = { key: 'http', validate, run };
