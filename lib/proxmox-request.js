const fs = require('fs');
const { Transform } = require('stream');
const { Agent, request } = require('undici');
const FormData = require('form-data');
const configStore = require('./config-store');

// --- Low-level request builder -----------------------------------------------
// Built fresh from whatever config is current at call time (not cached at
// require-time) so a Settings-page change takes effect on the very next API
// call, no restart needed. Cheap enough at homelab-scale call volume that
// rebuilding the dispatcher/Agent per request isn't worth optimizing away.
function buildRequester(c) {
  const base = `${c.host.replace(/\/+$/, '')}/api2/json`;
  const authHeader = `PVEAPIToken=${c.tokenId}=${c.tokenSecret}`;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: c.verifyTls } });

  return async function pve(method, path, params) {
    const url = new URL(`${base}${path}`);
    let body;

    if (params && (method === 'GET' || method === 'DELETE')) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
    } else if (params) {
      body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) body.set(k, v);
      }
    }

    const res = await request(url, {
      method,
      dispatcher,
      headers: {
        Authorization: authHeader,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? body.toString() : undefined,
    });

    const text = await res.body.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`Non-JSON response from Proxmox (${res.statusCode}): ${text.slice(0, 200)}`);
    }

    if (res.statusCode >= 400) {
      const detail = json.errors ? JSON.stringify(json.errors) : text;
      throw new Error(`Proxmox API ${method} ${path} -> ${res.statusCode}: ${detail}`);
    }

    return json.data;
  };
}

// Config required for real VM/network operations (node-scoped) -- throws a
// clear, catchable "go configure it" error instead of the old require-time
// crash if Settings hasn't been filled in yet.
function currentConfig() {
  const c = configStore.get();
  if (!c.host || !c.node || !c.tokenId || !c.tokenSecret) {
    throw new Error('Proxmox is not configured yet -- set it up in Settings first');
  }
  return c;
}

function pve(method, path, params) {
  const c = currentConfig();
  return buildRequester(c)(method, `${path.replace('{node}', c.node)}`, params);
}

// Used by the Settings page's "test connection" button against
// not-yet-saved values -- doesn't touch configStore or require a node,
// since /version is a global (non-node-scoped) endpoint.
async function testConnection({ host, tokenId, tokenSecret, verifyTls }) {
  const requester = buildRequester({ host, tokenId, tokenSecret, verifyTls });
  return requester('GET', '/version');
}

// Default stream highWaterMark is 16KB (64KB for fs read streams) -- fine
// for typical API bodies, but multiplies TLS per-record overhead badly for
// a multi-GB upload (hundreds of thousands of tiny chunks/records instead
// of thousands of large ones), which matters more than usual here since
// this app may run on modest hardware (e.g. an arm64 node) doing real CPU
// work for the encryption itself, not just I/O waiting.
const UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1MB

// Wraps a read stream in a pass-through Transform that counts bytes as they
// flow through -- NOT the same as listening for 'data' directly on the read
// stream. Attaching a 'data' listener to a stream switches it into flowing
// mode immediately, which drains it into that listener regardless of
// whether anything else (form-data's own internal consumption) is ready to
// read yet; since a stream's bytes can only really be consumed once, that
// races form-data out of ever seeing the real content, sends only the
// Content-Length header's *claim* of a full-size body while the actual body
// comes up short, and Proxmox's server hangs waiting for bytes that never
// arrive (this exact bug shipped briefly: 100% "progress" reported, no file
// ever landed on the Proxmox side). Piping through a Transform instead means
// nothing reads the file until form-data/undici actually pull from the
// Transform's output side, at the real pace data leaves this process.
function countingStream(readStream, onProgress, total) {
  let sent = 0;
  return readStream.pipe(
    new Transform({
      highWaterMark: UPLOAD_CHUNK_SIZE,
      transform(chunk, enc, cb) {
        sent += chunk.length;
        onProgress(sent, total);
        cb(null, chunk);
      },
    })
  );
}

// Separate from buildRequester() because file upload needs a real
// multipart/form-data body (form-data package) instead of the
// urlencoded-or-querystring shape every other call here uses. Proxmox VE's
// upload endpoint doesn't accept chunked transfer-encoding, so the form's
// length has to be computed up front (knownLength on the file part, since
// it's already sitting on local disk courtesy of multer) and sent as a real
// Content-Length header rather than letting the body stream chunk itself.
// No timeout override on this Agent's connect options (undici's defaults
// are per-connect, not per-request) -- the request() call below relies on
// undici's default body/headers timeouts, generous enough (5 min each) for
// homelab-scale images; a genuinely huge upload over a slow link may need
// these raised further.
async function pveUpload(path, { filePath, filename, fields, onProgress }) {
  const c = currentConfig();
  const base = `${c.host.replace(/\/+$/, '')}/api2/json`;
  const authHeader = `PVEAPIToken=${c.tokenId}=${c.tokenSecret}`;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: c.verifyTls } });

  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  const { size } = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath, { highWaterMark: UPLOAD_CHUNK_SIZE });
  const uploadStream = onProgress ? countingStream(fileStream, onProgress, size) : fileStream;
  form.append('filename', uploadStream, { filename, knownLength: size });

  const length = await new Promise((resolve, reject) => {
    form.getLength((err, len) => (err ? reject(err) : resolve(len)));
  });

  const res = await request(new URL(`${base}${path.replace('{node}', c.node)}`), {
    method: 'POST',
    dispatcher,
    headers: { Authorization: authHeader, ...form.getHeaders(), 'content-length': String(length) },
    body: form,
  });

  const text = await res.body.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`Non-JSON response from Proxmox upload (${res.statusCode}): ${text.slice(0, 200)}`);
  }
  if (res.statusCode >= 400) {
    throw new Error(`Proxmox upload -> ${res.statusCode}: ${json.errors ? JSON.stringify(json.errors) : text}`);
  }
  return json.data;
}

module.exports = { pve, currentConfig, testConnection, pveUpload };
