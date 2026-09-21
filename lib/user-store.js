const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Persisted on the same volume/dir as config-store.js's proxmox.json --
// same "not encrypted at rest, but 0600/0700 so at least not world-
// readable" posture, no separate PVC needed.
//
// Bootstrap: the very first time this loads and no users.json exists yet,
// it seeds a single user from the old single-admin env vars
// (DASHBOARD_USERNAME/DASHBOARD_PASSWORD_HASH) so an upgrade from the
// previous hardcoded-single-admin auth.js never locks the existing admin
// out. Those env vars are only ever read this once -- from then on
// users.json is the sole source of truth, same relationship config-store.js
// already has with its own env-var defaults.
const USERS_DIR = path.join(process.env.LABS_DIR || '/labs', '.config');
const USERS_PATH = path.join(USERS_DIR, 'users.json');

function ensureDir() {
  fs.mkdirSync(USERS_DIR, { recursive: true, mode: 0o700 });
}

function bootstrapDefaults() {
  const username = process.env.DASHBOARD_USERNAME || 'admin';
  const passwordHash = process.env.DASHBOARD_PASSWORD_HASH;
  if (!passwordHash) {
    throw new Error(
      'No users configured yet -- set DASHBOARD_PASSWORD_HASH (bcrypt hash) once to bootstrap the first login, or seed .config/users.json directly'
    );
  }
  return [{ username, passwordHash }];
}

let cached = null;

function persist() {
  ensureDir();
  fs.writeFileSync(USERS_PATH, JSON.stringify(cached, null, 2), { mode: 0o600 });
}

function load() {
  if (cached) return cached;
  ensureDir();
  try {
    cached = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  } catch (e) {
    cached = bootstrapDefaults();
    persist();
  }
  return cached;
}

// Safe to send to the browser -- no password hashes.
function list() {
  return load().map((u) => ({ username: u.username }));
}

function find(username) {
  return load().find((u) => u.username === username) || null;
}

async function verify(username, password) {
  const user = find(username);
  if (!user) return false;
  return bcrypt.compare(password, user.passwordHash);
}

async function addUser(username, password) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
    throw new Error('Username must be 1-64 characters: letters, numbers, dot, underscore, hyphen only');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const users = load();
  if (users.some((u) => u.username === name)) {
    throw new Error(`User "${name}" already exists`);
  }
  const passwordHash = await bcrypt.hash(password, 10);
  users.push({ username: name, passwordHash });
  persist();
  return { username: name };
}

// Guards against ever ending up with zero users (a permanent lockout no
// one could recover from short of hand-editing users.json) -- callers add
// their own extra guard against removing the account currently logged in
// as, but that's a separate, session-aware check this module has no
// access to.
function removeUser(username) {
  const users = load();
  if (users.length <= 1) {
    throw new Error("Can't remove the last remaining user");
  }
  const idx = users.findIndex((u) => u.username === username);
  if (idx === -1) throw new Error(`User "${username}" not found`);
  users.splice(idx, 1);
  persist();
}

module.exports = { list, find, verify, addUser, removeUser };
