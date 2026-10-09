const fs = require('fs');
const path = require('path');
const R = require('./library-read');

// Write side of the runbook library -- see library-read.js for the on-disk
// layout. Locked versions are immutable here: nothing in this module (or the
// app) edits or deletes one. An admin with shell access to the volume still
// can, which is deliberate; a hash mismatch shows up as integrity:"modified".

const { check, ymlPath, metaPath, readMeta, writeMeta, writeAtomic, versionsOf, describe, brief, get } = R;
const versionKey = (v) => v.split('.').map(Number);

// Create a brand-new runbook (version 1.0, draft) or overwrite an existing
// draft. Refuses to touch a locked version.
function saveDraft(name, version, text, user) {
  check(name, version);
  R.parseAndValidate(text);
  const prev = readMeta(name, version);
  if (prev && prev.status === 'locked') throw new Error(`${name} ${version} is locked -- create a new version or copy it`);
  const now = new Date().toISOString();
  writeAtomic(ymlPath(name, version), text);
  writeMeta(name, version, {
    ...(prev || { createdBy: user, createdAt: now }),
    status: 'draft',
    updatedBy: user,
    updatedAt: now,
  });
  return brief(describe(name, version));
}

function create(name, text, user) {
  check(name);
  if (versionsOf(name).length) throw new Error(`a runbook named "${name}" already exists`);
  return saveDraft(name, '1.0', text, user);
}

// Next minor above every existing version in the same major line
// (1.0 locked -> 1.1; if 1.1 exists already -> 1.2).
function newVersion(name, fromVersion, user) {
  const source = get(name, fromVersion);
  const major = versionKey(fromVersion)[0];
  const minors = versionsOf(name).map(versionKey).filter(([m]) => m === major).map(([, n]) => n);
  const next = `${major}.${Math.max(...minors) + 1}`;
  const created = saveDraft(name, next, source.text, user);
  writeMeta(name, next, { ...readMeta(name, next), basedOn: fromVersion });
  return created;
}

function copyAs(name, fromVersion, newName, user) {
  const source = get(name, fromVersion);
  const created = create(newName, source.text, user);
  writeMeta(newName, '1.0', { ...readMeta(newName, '1.0'), copiedFrom: `${name} ${fromVersion}` });
  return created;
}

// Locking needs a description (what it's for, who it's safe to use on);
// "verified" optionally records what it was tested against.
function lock(name, version, user, { description, changelog, verified }) {
  const d = get(name, version);
  if (d.meta.status === 'locked') throw new Error(`${name} ${version} is already locked`);
  if (!String(description || '').trim()) throw new Error('a description is required to lock a runbook');
  R.parseAndValidate(d.text);
  writeMeta(name, version, {
    ...d.meta,
    status: 'locked',
    description: description.trim(),
    changelog: String(changelog || '').trim(),
    verified: String(verified || '').trim(),
    lockedBy: user,
    lockedAt: new Date().toISOString(),
    hash: R.sha256(d.text),
  });
  return brief(describe(name, version));
}

// Drafts only -- locked versions are never deletable through the app.
function removeDraft(name, version) {
  const d = get(name, version);
  if (d.meta.status === 'locked') throw new Error('locked versions cannot be deleted in the app');
  fs.rmSync(ymlPath(name, version));
  fs.rmSync(metaPath(name, version), { force: true });
  if (!versionsOf(name).length) fs.rmSync(path.dirname(ymlPath(name, version)), { recursive: true, force: true });
}

module.exports = {
  ...R,
  create, saveDraft, newVersion, copyAs, lock, removeDraft,
};
