// HTTP API relay for automation/API clients (curl, scripts, CI) -- distinct
// from lib/gui-proxy.js, which exists to make a *browser* iframe work
// (strips X-Frame-Options, rewrites Set-Cookie SameSite, mangles F5's login
// HTML). None of that belongs here: an API client sends its own auth to the
// target device and expects its request/response forwarded byte-for-byte,
// so this proxy does no header/body rewriting at all. Both share the same
// `labManager.getNodeTarget()` lookup (lab/node -> live mgmt IP), just for
// two different consumers.
//
// Mounted on the *main* app port/domain (see server.js), not a second
// listener like gui-proxy -- this only needs to forward plain HTTP(S)
// requests, which a URL path on the existing 443 Ingress handles for free
// (no new wildcard DNS/cert/Ingress rule, unlike gui-proxy's subdomain
// scheme). Route shape: /api/relay/<lab>/<node>/<rest of path>, forwarded
// to https://<node mgmt ip>:<node mgmt port>/<rest of path>.
//
// Deliberately pass-through, not credential-injecting: this app does not
// store or send the target device's own credentials. Your automation's
// request carries whatever auth the device itself expects (basic auth, an
// API key header, ...) exactly as it would calling the device directly --
// this relay only solves *reachability* (no VPN/route to the lab's
// management network needed from wherever the automation runs), not
// credential management.
const https = require('https');
const express = require('express');
const httpProxy = require('http-proxy');

const DEFAULT_TARGET_PORT = 443;
const ROUTE_RE = /^\/([^/]+)\/([^/]+)(\/.*)?$/;

// Same keep-alive-agent reasoning as gui-proxy.js: without it, node-http-proxy
// opens a brand-new TCP+TLS handshake to the target mgmt IP for every single
// request. rejectUnauthorized stays false -- self-signed certs are the norm
// for vendor appliance mgmt APIs, same trust model as gui-proxy and as this
// app's own direct "web ui" new-tab links.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20, rejectUnauthorized: false });
const proxy = httpProxy.createProxyServer({ secure: false, changeOrigin: true, agent: keepAliveAgent });

proxy.on('error', (err, req, res) => {
  console.error(`api-relay: proxy error for ${req.method} ${req.url} -- ${err.code || ''} ${err.message}`);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `relay error: ${err.code || err.message}` }));
  }
});

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (e) {
    return segment;
  }
}

// The enabled-check and the token-check are split into two `router.use()`
// calls rather than one, purely so a disabled relay always 404s before ever
// looking at the relay-token header -- same "off means every request 404s,
// not that the route doesn't exist" pattern as public-routes.js and
// gui-proxy.js.
function buildApiRelayRoutes({ apiTokens, apiSettings, labManager }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!apiSettings.getSettings().relayEnabled) {
      return res.status(404).json({ error: 'not found' });
    }
    next();
  });

  // Deliberately its own header, not `Authorization` -- this relay's own
  // auth has to coexist with whatever auth the target *device* also expects
  // in the same request (many vendor REST APIs use `Authorization: Basic`
  // or `Authorization: Bearer <device token>` themselves), and this relay
  // forwards the request otherwise untouched. Reusing `Authorization` for
  // the relay's own token would silently clobber the device's own
  // credential the moment both need to be present in the same request.
  // Stripped from the outgoing request below so it never leaks upstream.
  router.use((req, res, next) => {
    const raw = req.headers['x-labber-relay-token'];
    if (!raw) return res.status(401).json({ error: 'missing X-Labber-Relay-Token header' });

    apiTokens
      .verify(raw)
      .then((record) => {
        if (!record) return res.status(401).json({ error: 'invalid or revoked token' });
        req.apiToken = record;
        next();
      })
      .catch(next);
  });

  router.use((req, res) => {
    // req.url is relative to this router's /api/relay mount point here:
    // "/<lab>/<node>[/<rest...>]". Mounted before express.json() in
    // server.js, so the request body (if any) is still an untouched raw
    // stream -- proxy.web() pipes it straight through rather than this app
    // parsing and re-serializing it.
    const match = ROUTE_RE.exec(req.url);
    if (!match) {
      return res.status(400).json({ error: 'expected /api/relay/<lab>/<node>/<path>' });
    }
    const lab = decodeSegment(match[1]);
    const node = decodeSegment(match[2]);

    if (req.apiToken.labScope && req.apiToken.labScope !== lab) {
      return res.status(403).json({ error: `this token is scoped to lab "${req.apiToken.labScope}"` });
    }

    const target = labManager.getNodeTarget(lab, node);
    if (!target) {
      return res.status(404).json({ error: `no mgmt IP set for "${lab}/${node}" (unknown lab/node, or no mgmt IP saved on its dashboard card yet)` });
    }

    req.url = match[3] || '/';
    delete req.headers['x-labber-relay-token'];
    proxy.web(req, res, { target: `https://${labManager.formatHostPort(target.ip, target.port || DEFAULT_TARGET_PORT)}` });
  });

  return router;
}

module.exports = { buildApiRelayRoutes };
