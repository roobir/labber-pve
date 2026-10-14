const { clientIp } = require('../client-ip');
const { describe } = require('./actions');
const audit = require('./log');

// Records every change made through the REST API (anything but GET / HEAD /
// OPTIONS under /api/) once its reply has gone out, with how it ended:
//   ok        2xx / 3xx
//   denied    401 / 403 (not signed in, or not allowed)
//   failed    any other 4xx / 5xx (the reply's status is kept as detail)
//   aborted   the connection closed before a reply was sent
// Registered after the session and body parsers, before every route, so it
// sees the signed-in user and the parsed body (describe() decides which body
// fields, if any, may be logged). /api/relay/* is mounted earlier and audits
// itself -- see lib/api-relay.js.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function outcome(res) {
  if (!res.writableFinished) return 'aborted';
  if (res.statusCode < 400) return 'ok';
  if (res.statusCode === 401 || res.statusCode === 403) return 'denied';
  return 'failed';
}

function auditMiddleware(req, res, next) {
  if (READ_METHODS.has(req.method)) return next();
  // Express matches routes case-insensitively and ignores one trailing
  // slash, so `POST /API/labs/` reaches the same route as `/api/labs`: the
  // check here (and describe()) must be just as loose or it could be skipped.
  const urlPath = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  if (!urlPath.toLowerCase().startsWith('/api/')) return next();

  const user = req.session && req.session.username;
  const ip = clientIp(req);
  res.once('close', () => {
    // The body is only parsed by now for multipart uploads (multer runs
    // inside the route), so describe() is called at the end, not the start.
    const described = describe(req.method, urlPath, req.body);
    if (!described) return;
    const result = outcome(res);
    const detail = { ...(described.detail || {}) };
    if (result === 'failed' || result === 'denied') detail.status = res.statusCode;
    audit.record({ user: user || (req.session && req.session.username), ip, ...described, result, detail });
  });
  next();
}

module.exports = { auditMiddleware, outcome };
