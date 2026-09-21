const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Bearer tokens for the /api/relay/* HTTP relay (lib/api-relay.js) --
// separate from user-store.js's dashboard login accounts: these authenticate
// automation/API clients (curl, scripts, CI), not humans clicking through
// the UI, and carry no session. Same on-disk posture as user-store.js/
// config-store.js: JSON file on the shared LABS_DIR/.config volume, 0600/0700.
//
// Token shape: "lbr_<id>_<secret>" -- the id prefix lets verify() find the
// matching record in O(1) instead of bcrypt-comparing the secret against
// every stored hash (bcrypt is deliberately slow; doing that for every
// token on every relay request would add up as the token list grows). Only
// the bcrypt hash of the secret half is ever persisted -- the raw token is
// returned exactly once, at creation time, same "can't be recovered later,
// only reissued" posture as any other API key/PAT scheme.
const TOKENS_DIR = path.join(process.env.LABS_DIR || '/labs', '.config');
const TOKENS_PATH = path.join(TOKENS_DIR, 'api-tokens.json');

const TOKEN_RE = /^lbr_([0-9a-f]{12})_(.+)$/;

function ensureDir() {
  fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: 0o700 });
}

let cached = null;

function persist() {
  ensureDir();
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(cached, null, 2), { mode: 0o600 });
}

function load() {
  if (cached) return cached;
  ensureDir();
  try {
    cached = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
  } catch (e) {
    cached = [];
    persist();
  }
  return cached;
}

// Safe to send to the browser -- no hash, no secret.
function list() {
  return load().map(({ id, label, labScope, createdAt, lastUsedAt }) => ({ id, label, labScope, createdAt, lastUsedAt }));
}

async function create(label, labScope) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) throw new Error('Label is required');
  const cleanScope = String(labScope || '').trim() || null;

  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const secretHash = await bcrypt.hash(secret, 10);

  const tokens = load();
  tokens.push({
    id,
    label: cleanLabel,
    labScope: cleanScope,
    secretHash,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  persist();

  // token is the only time the raw, usable value is ever returned --
  // callers must show/copy it now, it's unrecoverable after this.
  return { id, label: cleanLabel, labScope: cleanScope, token: `lbr_${id}_${secret}` };
}

function revoke(id) {
  const tokens = load();
  const idx = tokens.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Token "${id}" not found`);
  tokens.splice(idx, 1);
  persist();
}

// lastUsedAt is best-effort observability for the Settings token list, not
// anything auth depends on -- but it's written on every single relay
// request, and rewriting the whole tokens file that often is real disk
// churn on the kind of node this app is designed to be gentle with (see
// lib/upload-throttle.js on etcd contention). Keep the in-memory value
// current and only flush to disk once a minute per token.
const LAST_USED_FLUSH_MS = 60 * 1000;

function touchLastUsed(record) {
  const now = Date.now();
  const previous = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  record.lastUsedAt = new Date(now).toISOString();
  if (now - previous >= LAST_USED_FLUSH_MS) persist();
}

// Parses a raw "lbr_<id>_<secret>" bearer value and bcrypt-verifies it
// against the matching stored record. Returns the safe (no-hash) record on
// success, null on any failure (unknown id, wrong secret, malformed token)
// -- callers don't need to distinguish why, only whether to let the
// request through. Records lastUsedAt on success (best-effort observability
// for the Settings token list, not load-bearing for auth itself).
async function verify(rawToken) {
  const m = TOKEN_RE.exec(String(rawToken || ''));
  if (!m) return null;
  const [, id, secret] = m;

  const tokens = load();
  const record = tokens.find((t) => t.id === id);
  if (!record) return null;

  const ok = await bcrypt.compare(secret, record.secretHash);
  if (!ok) return null;

  touchLastUsed(record);
  return { id: record.id, label: record.label, labScope: record.labScope };
}

module.exports = { list, create, revoke, verify };
