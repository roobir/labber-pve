const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { RUNBOOKS_DIR } = require('./paths');
const { validateDefinition } = require('./schema');

// Read side of the runbook library: on-disk layout, listing, loading.
// Mutations (create / save / version / lock / delete) are in library.js.
//
// On-disk layout, one directory per runbook name:
//   <name>/<version>.yml         the definition, exactly as the author wrote it
//   <name>/<version>.meta.json   status (draft|locked), authorship, and for
//                                locked versions a content hash + changelog
// Locked versions are immutable here: nothing in this module (or the app)
// edits or deletes one. An admin with shell access to the volume still can,
// which is deliberate; a hash mismatch is surfaced as `integrity:"modified"`.

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}$/;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const versionKey = (v) => v.split('.').map(Number);
const byVersionDesc = (a, b) => versionKey(b)[0] - versionKey(a)[0] || versionKey(b)[1] - versionKey(a)[1];

function check(name, version) {
  if (!NAME_RE.test(name)) throw new Error('name: lowercase letters, digits and - only (2-63 chars)');
  if (version !== undefined && !VERSION_RE.test(version)) throw new Error('version must look like 1.0');
}

const dirOf = (name) => path.join(RUNBOOKS_DIR, name);
const ymlPath = (name, v) => path.join(dirOf(name), `${v}.yml`);
const metaPath = (name, v) => path.join(dirOf(name), `${v}.meta.json`);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

function readMeta(name, version) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(name, version), 'utf-8'));
  } catch (e) {
    return null;
  }
}

const writeMeta = (name, version, meta) => writeAtomic(metaPath(name, version), JSON.stringify(meta, null, 2));

function versionsOf(name) {
  try {
    return fs.readdirSync(dirOf(name)).filter((f) => f.endsWith('.yml')).map((f) => f.slice(0, -4)).sort(byVersionDesc);
  } catch (e) {
    return [];
  }
}

function describe(name, version) {
  const meta = readMeta(name, version);
  if (!meta) return null;
  const text = fs.readFileSync(ymlPath(name, version), 'utf-8');
  let def = {};
  try { def = yaml.load(text) || {}; } catch (e) { /* surfaced when opened */ }
  const modified = meta.status === 'locked' && sha256(text) !== meta.hash;
  return { name, version, text, def, meta, integrity: modified ? 'modified' : 'ok' };
}

function brief(d) {
  return {
    version: d.version,
    status: d.meta.status,
    title: d.def.title || '',
    vendor: d.def.vendor || '',
    description: d.meta.description || '',
    verified: d.meta.verified || '',
    builtin: !!d.meta.builtin,
    integrity: d.integrity,
    lockedAt: d.meta.lockedAt,
    lockedBy: d.meta.lockedBy,
    updatedBy: d.meta.updatedBy || d.meta.createdBy,
  };
}

function list() {
  if (!fs.existsSync(RUNBOOKS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(RUNBOOKS_DIR).filter((n) => NAME_RE.test(n)).sort()) {
    const versions = versionsOf(name).map((v) => describe(name, v)).filter(Boolean).map(brief);
    if (versions.length) out.push({ name, versions });
  }
  return out;
}

function get(name, version) {
  check(name, version);
  const d = describe(name, version);
  if (!d) throw new Error(`no runbook ${name} ${version}`);
  return d;
}

// "latest" = highest locked version; falls back to highest draft only when
// nothing is locked yet (so a fresh draft is runnable for testing).
function resolveVersion(name, version) {
  if (version && version !== 'latest') return version;
  const all = versionsOf(name);
  const locked = all.find((v) => (readMeta(name, v) || {}).status === 'locked');
  const pick = locked || all[0];
  if (!pick) throw new Error(`no runbook named "${name}"`);
  return pick;
}

function parseAndValidate(text) {
  let def;
  try {
    def = yaml.load(text);
  } catch (e) {
    throw Object.assign(new Error(`YAML error: ${e.message}`), { details: [`YAML error: ${e.message}`] });
  }
  return validateDefinition(def);
}

// Which runbooks mention a store entry? (shown before deleting/renaming it)
function referencesToStoreEntry(entryName) {
  const re = new RegExp(`(?<![\\w-])${entryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  const used = [];
  for (const { name, versions } of list()) {
    for (const v of versions) {
      if (re.test(get(name, v.version).text)) used.push(`${name} ${v.version}`);
    }
  }
  return used;
}

module.exports = {
  NAME_RE, check, sha256, ymlPath, metaPath, writeAtomic, readMeta, writeMeta, versionsOf,
  describe, brief, list, get, resolveVersion, parseAndValidate, referencesToStoreEntry,
};
