const https = require('https');
const http = require('http');

// Minimal one-shot HTTP(S) client for runbook http steps. Vendor appliances
// ship self-signed management certs, so TLS verification is off -- the same
// trust model as lib/api-relay.js, gui-proxy.js and the dashboard's own
// "web ui" links. No keep-alive: a runbook may span a device reboot.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function request({ scheme = 'https', host, port, method = 'GET', path, headers = {}, body, timeoutMs = 30000, signal }) {
  return new Promise((resolve, reject) => {
    const lib = scheme === 'http' ? http : https;
    const payload = body === undefined ? null : Buffer.from(body, 'utf-8');
    const req = lib.request(
      {
        host,
        port,
        method,
        path,
        agent: scheme === 'http' ? undefined : agent,
        timeout: timeoutMs,
        headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY_BYTES) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);

    if (signal) {
      if (signal.aborted) return req.destroy(new Error('aborted'));
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end(payload || undefined);
  });
}

module.exports = { request };
