const session = require('express-session');
const userStore = require('./user-store');
const { clientIp } = require('./client-ip');
const audit = require('./audit/log');

// Multi-user (see lib/user-store.js) -- the session remembers *which* user
// rather than a single boolean, so requireAuth/isAuthed still answer "is
// someone logged in" for every route that only cares about that, while
// routes/users.js can read req.session.username to stop a user deleting
// the account they're currently signed in as.
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required (random string for signing session cookies)');
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
    // 'auto' marks the cookie Secure only on a connection Express
    // considers HTTPS. Behind a TLS-terminating proxy that's only true
    // once TRUST_PROXY is set (see server.js), which is exactly the
    // deployment where the cookie should be Secure -- and on plain-HTTP
    // local dev it stays unset, so nothing breaks there.
    secure: 'auto',
  },
});

function requireAuth(req, res, next) {
  if (req.session && req.session.username) return next();
  return res.status(401).json({ error: 'not authenticated' });
}

// Same check, usable outside express middleware (e.g. the ws upgrade
// handler, which has the raw request/session but no res.json()).
function isAuthed(req) {
  return !!(req.session && req.session.username);
}

// --- Login throttling ---------------------------------------------------
// The dashboard fronts real Proxmox credentials and lab appliance GUIs, so
// an unlimited-guess login form is worth closing off. Deliberately
// in-memory rather than another JSON file on the shared volume: this is a
// speed bump against online guessing, and losing the counters on restart
// is an acceptable (and self-limiting) trade for not writing to disk on
// every failed attempt.
const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS, 10) || 10;
const LOCKOUT_MS = (parseInt(process.env.LOGIN_LOCKOUT_MINUTES, 10) || 10) * 60 * 1000;
const attempts = new Map(); // ip -> { count, firstAt }

function isLockedOut(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAt > LOCKOUT_MS) {
    attempts.delete(ip);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() - record.firstAt > LOCKOUT_MS) {
    attempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count += 1;
}

async function login(req, res) {
  const { username, password } = req.body || {};
  const ip = clientIp(req);

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'too many failed attempts -- try again later' });
  }

  if (!username || !password || !(await userStore.verify(username, password))) {
    recordFailure(ip);
    // Failed attempts are bounded per IP by the lockout above, so they
    // cannot flood the audit log; attempts made while locked out are not
    // recorded one by one -- the lockout itself is, once. The typed name is
    // kept only if it is a real account: a password typed into the username
    // box by mistake must not end up in the log.
    const who = typeof username === 'string' && userStore.find(username) ? username : '(unknown user)';
    audit.record({ user: who, ip, action: 'auth.login', result: 'failed' });
    if (isLockedOut(ip)) audit.record({ user: who, ip, action: 'auth.lockout', result: 'denied', detail: { minutes: LOCKOUT_MS / 60000 } });
    return res.status(401).json({ error: 'invalid credentials' });
  }

  attempts.delete(ip);

  // Regenerate before storing the username: without this, whatever
  // session id the browser arrived with becomes an authenticated one.
  // Anyone who could plant a known session cookie beforehand (shared
  // machine, an XSS elsewhere on the domain) would then be riding the
  // session the moment the real user logs in.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'could not start session' });
    req.session.username = username;
    audit.record({ user: username, ip, action: 'auth.login' });
    res.json({ ok: true });
  });
}

function logout(req, res) {
  const user = req.session && req.session.username;
  if (user) audit.record({ user, ip: clientIp(req), action: 'auth.logout' });
  req.session.destroy(() => res.json({ ok: true }));
}

module.exports = { sessionMiddleware, requireAuth, isAuthed, login, logout };
