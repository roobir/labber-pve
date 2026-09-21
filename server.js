const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const { sessionMiddleware, requireAuth, isAuthed, login, logout } = require('./lib/auth');
const labManager = require('./lib/lab-manager');
const hostStats = require('./lib/host-stats');
const statsBuilder = require('./lib/stats');
const apiSettings = require('./lib/api-settings');
const apiTokens = require('./lib/api-tokens');
const { buildPublicRoutes } = require('./lib/public-routes');
const { buildApiRelayRoutes } = require('./lib/api-relay');
const { handleConnection: handleConsoleConnection } = require('./lib/console-bridge');
const guiProxy = require('./lib/gui-proxy');
const { handleConnection: handleLabConnection } = require('./lib/lab-bridge');

const { buildLabsRoutes } = require('./routes/labs');
const { buildNodeOpsRoutes } = require('./routes/node-ops');
const { buildSettingsRoutes } = require('./routes/settings');
const { buildBridgesStoragesRoutes } = require('./routes/bridges-storages');
const { buildTemplatesRoutes } = require('./routes/templates');
const { buildVmsRoutes } = require('./routes/vms');
const { buildUsersRoutes } = require('./routes/users');
const { buildApiTokensRoutes } = require('./routes/api-tokens');

hostStats.start();
const getStats = () => statsBuilder.buildStats({ labManager, hostStats });

const PORT = process.env.PORT || 8080;
const LABS_DIR = process.env.LABS_DIR || '/labs';

const app = express();

// Off by default, because trusting X-Forwarded-* from a client that isn't
// actually behind a proxy would let anyone spoof their source IP (which
// both the login throttle and the public-stats IP allowlist read). Set
// TRUST_PROXY=1 when this really does sit behind one reverse proxy --
// that's also what lets the session cookie's `secure: 'auto'` notice the
// connection is HTTPS and mark itself Secure.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY, 10) || 1);
}

// Mounted before express.json() below, deliberately -- an /api/relay/*
// request's body must reach lib/api-relay.js as an untouched raw stream so
// it can pipe straight through to the proxied device unmodified, instead of
// this app parsing it as JSON (or failing to, for a non-JSON body) and
// having to re-serialize it. Needs no session either (bearer-token auth,
// checked inside the router itself), so it doesn't need sessionMiddleware
// first.
app.use('/api/relay', buildApiRelayRoutes({ apiTokens, apiSettings, labManager }));

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', login);
app.post('/logout', logout);

app.get('/', (req, res) => {
  if (!isAuthed(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route groups (routes/*.js) -- each is a thin Express Router factory over
// the same lib/*.js modules this file used to call directly. Split out so
// no single file mixes app wiring with every route's own logic; see the
// labber-pve full-review plan's file-size pass for the rationale.
app.use(buildLabsRoutes({ requireAuth, getStats }));
app.use(buildNodeOpsRoutes({ requireAuth }));
app.use(buildSettingsRoutes({ requireAuth }));
app.use(buildBridgesStoragesRoutes({ requireAuth }));
app.use(buildTemplatesRoutes({ requireAuth, labsDir: LABS_DIR }));
app.use(buildVmsRoutes({ requireAuth }));
app.use(buildUsersRoutes({ requireAuth }));
app.use(buildApiTokensRoutes({ requireAuth }));

// Unauthenticated, gated by its own enabled toggle -- see lib/public-routes.js.
app.use(buildPublicRoutes({ apiSettings, getStats }));

// --- Error handling ------------------------------------------------------------
// Registered last (Express convention: any 4-arg middleware after every
// route catches whatever's thrown/passed to next(err) upstream) --
// most importantly multer's own errors (aborted mid-upload, file too large,
// an ingress/proxy killing a long-running large-file request), which
// otherwise fall through to Express's default HTML error page instead of
// JSON. Every frontend handler here (fetch and the XHR upload in
// templates.js) assumes a JSON body, so without this an upstream failure
// surfaces only as an opaque "unexpected response from server" instead of
// whatever actually went wrong -- exactly what happened on a large F5
// upload that likely hit a size/timeout limit somewhere between the
// browser and this app.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('Unhandled request error:', err);
  const status = err instanceof multer.MulterError ? 400 : err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- Websockets: console bridge + lab deploy/destroy streaming -----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// express-session needs a res-like object to hook into; the upgrade request
// never gets a real one, so a minimal stub is enough since we're only
// reading req.session here, not writing a new cookie.
const resStub = { getHeader: () => {}, setHeader: () => {}, end: () => {} };

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/console' && req.url !== '/ws/lab') {
    socket.destroy();
    return;
  }
  sessionMiddleware(req, resStub, () => {
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

wss.on('connection', (ws, req) => {
  if (req.url === '/ws/lab') {
    handleLabConnection(ws);
  } else {
    handleConsoleConnection(ws);
  }
});

// Node's own default requestTimeout (5m) was silently killing large qcow2/iso
// template uploads with a 408 -- independent of, and downstream of, every
// npmplus/HAProxy Ingress timeout already raised for the same reason. A
// fixed 30m replacement value was tried first, but that's a *total-duration*
// cap (unlike HAProxy's idle-based timeouts, which a continuously-if-slowly
// trickling upload never trips) -- confirmed hit for real on a slow remote
// upload that ran ~30m before failing. Any fixed cap is fundamentally at
// odds with lib/upload-throttle.js's whole point (deliberately letting an
// upload run slow, e.g. to protect a fragile node's disk, or just a slow
// remote connection) -- a bigger fixed number only moves the same failure
// further out. Disabled entirely instead; multer's own 32GB fileSize limit
// (routes/templates.js) is the real, time-independent abuse guard.
server.requestTimeout = 0; // 0 = disabled, per Node's http.Server docs

server.listen(PORT, () => {
  console.log(`labber-pve listening on port ${PORT}`);
});

guiProxy.start();
