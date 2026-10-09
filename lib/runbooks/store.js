const fs = require('fs');
const path = require('path');
const { STORE_PATH } = require('./paths');
const identity = require('../node-identity');

// The Store: named values runbooks reference as {{store.<name>}} (or
// {{store.<name>.<field>}} for licenses) so a runbook never contains a
// password or license itself -- it can be shared, exported and locked
// without leaking anything. Entry types:
//   secret   a password / token (masked in lists, revealed on demand)
//   text     any plain value or multi-line blob
//   license  a BIG-IP style license bound to one node: reg key, license
//            text, add-on keys, and the UUID + MAC it was issued for
// Plain JSON, 0600, on the same volume as the other .config files (a lab
// tool; encryption at rest is a deliberate later step). Each overwrite
// keeps the previous version in `history` so a bad paste can be undone.

const TYPES = ['secret', 'text', 'license'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const HISTORY_LIMIT = 10;
const MAX_VALUE_BYTES = 5 * 1024 * 1024; // a device config, not a disk image

let cached = null;

function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (e) {
    cached = { entries: {} };
  }
  return cached;
}

function persist() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function cleanLicense(l = {}) {
  const addOnKeys = Array.isArray(l.addOnKeys) ? l.addOnKeys : String(l.addOnKeys || '').split(/[\s,]+/);
  const out = {
    regkey: String(l.regkey || '').trim(),
    licenseText: String(l.licenseText || ''),
    addOnKeys: addOnKeys.map((k) => k.trim()).filter(Boolean),
    uuid: String(l.uuid || '').trim(),
    mac: String(l.mac || '').trim(),
  };
  if (!out.regkey && !out.licenseText.trim()) throw new Error('a license needs a registration key or license text');
  if (out.uuid && !identity.UUID_RE.test(out.uuid)) throw new Error('uuid must look like 8-4-4-4-12 hex');
  if (out.mac && !identity.MAC_RE.test(out.mac)) throw new Error('mac must look like aa:bb:cc:dd:ee:ff');
  return out;
}

function snapshot(e) {
  return { value: e.value, license: e.license };
}

function summary(e) {
  const l = e.license;
  return {
    name: e.name,
    type: e.type,
    group: e.group,
    description: e.description,
    updatedAt: e.updatedAt,
    updatedBy: e.updatedBy,
    hasValue: e.type === 'license' ? true : !!e.value,
    historyCount: e.history.length,
    license: l && { uuid: l.uuid, mac: l.mac, regkeyTail: l.regkey.slice(-5), hasText: !!l.licenseText.trim(), addOnCount: l.addOnKeys.length },
  };
}

const list = () => Object.values(load().entries).map(summary).sort((a, b) => a.name.localeCompare(b.name));

function get(name) {
  const e = load().entries[name];
  if (!e) throw new Error(`no store entry named "${name}"`);
  return e;
}

// Create or overwrite. `data.newName` renames (runbooks referencing the old
// name will then fail to resolve -- the UI warns before it gets here).
function upsert(name, data, user) {
  if (!NAME_RE.test(name)) throw new Error('name: letters, digits, - and _ only (max 63)');
  if (!TYPES.includes(data.type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const { entries } = load();
  const prev = entries[name];
  const finalName = data.newName || name;
  if (!NAME_RE.test(finalName)) throw new Error('new name: letters, digits, - and _ only (max 63)');
  if (finalName !== name && entries[finalName]) throw new Error(`"${finalName}" already exists`);

  const next = {
    name: finalName,
    type: data.type,
    group: String(data.group || '').trim(),
    description: String(data.description || '').trim(),
    value: data.type === 'license' ? '' : String(data.value ?? ''),
    license: data.type === 'license' ? cleanLicense(data.license) : null,
    updatedAt: new Date().toISOString(),
    updatedBy: user,
    history: prev ? prev.history.slice() : [],
  };
  if (data.type !== 'license' && !next.value) throw new Error('value is required');
  if (Buffer.byteLength(next.value, 'utf-8') > MAX_VALUE_BYTES) throw new Error('value is larger than 5 MB');
  if (prev) {
    next.history.unshift({ at: prev.updatedAt, by: prev.updatedBy, ...snapshot(prev) });
    next.history.length = Math.min(next.history.length, HISTORY_LIMIT);
    delete entries[name];
  }
  entries[finalName] = next;
  persist();
  return summary(next);
}

function remove(name) {
  const { entries } = load();
  get(name);
  delete entries[name];
  persist();
}

// Brings back history[index] as the current value (current becomes history).
function restore(name, index, user) {
  const e = get(name);
  const old = e.history[index];
  if (!old) throw new Error('no such history entry');
  return upsert(name, { ...e, value: old.value, license: old.license }, user);
}

// Everything a run can reference: { name: string | licenseFields }.
function resolveAll() {
  const out = {};
  for (const e of Object.values(load().entries)) out[e.name] = e.type === 'license' ? { ...e.license } : e.value;
  return out;
}

module.exports = { TYPES, list, get, upsert, remove, restore, resolveAll };
