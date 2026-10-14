const fs = require('fs');
const path = require('path');

// The audit log: who changed what, when, from where. One JSON object per line
// in <LABS_DIR>/.audit/<YYYY-MM-DD>.jsonl (UTC day), so it lives on the same
// volume as the labs and one backup captures it. Each entry is also printed
// to stdout as `audit {...}`, so the container log (podman / k3s / Loki)
// keeps a copy this app cannot edit.
//
// Entries hold WHAT was done, never the request body: no secret, password or
// Store value is ever written here. Callers pass a small `detail` of named,
// non-secret fields; strings are cut to MAX_TEXT characters.
//
// There is no API to change or delete entries; files older than
// AUDIT_RETENTION_DAYS (default 90) are removed when a new day's file starts.
// Recording never throws -- a full disk must not break the action itself.

const AUDIT_DIR = path.join(process.env.LABS_DIR || '/labs', '.audit');
const RETENTION_DAYS = Math.max(1, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 90);
const TO_STDOUT = process.env.AUDIT_STDOUT !== 'off';
const MAX_TEXT = 200;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

let lastDay = null;

const clip = (v) => (typeof v === 'string' && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);

function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'object' ? clip(JSON.stringify(v)) : clip(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function prune(today) {
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - RETENTION_DAYS * 86400000;
  for (const f of fs.readdirSync(AUDIT_DIR)) {
    const m = FILE_RE.exec(f);
    if (m && new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) fs.rmSync(path.join(AUDIT_DIR, f), { force: true });
  }
}

// record({ user, ip, action, target, result, detail }) -> the stored entry
function record({ user, ip, action, target, result = 'ok', detail } = {}) {
  const entry = {
    time: new Date().toISOString(),
    user: clip(String(user || '-')),
    ip: clip(String(ip || '')),
    action: clip(String(action || 'unknown')),
    target: clip(String(target || '')),
    result: clip(String(result)),
  };
  const extra = cleanDetail(detail);
  if (extra) entry.detail = extra;
  const line = JSON.stringify(entry);
  if (TO_STDOUT) console.log(`audit ${line}`);
  try {
    const day = entry.time.slice(0, 10);
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(path.join(AUDIT_DIR, `${day}.jsonl`), `${line}\n`);
    if (day !== lastDay) {
      lastDay = day;
      prune(day);
    }
  } catch (err) {
    console.error(`audit: could not write the audit log: ${err.message}`);
  }
  return entry;
}

function matches(entry, f) {
  if (f.user && entry.user !== f.user) return false;
  if (f.target && entry.target !== f.target && !entry.target.startsWith(`${f.target}/`)) return false;
  if (f.action && entry.action !== f.action && !entry.action.startsWith(`${f.action}.`)) return false;
  if (f.from && entry.time < f.from) return false;
  if (f.to && entry.time > f.to) return false;
  if (f.q) {
    const hay = `${entry.user} ${entry.ip} ${entry.action} ${entry.target} ${entry.result} ${JSON.stringify(entry.detail || {})}`;
    if (!hay.toLowerCase().includes(f.q.toLowerCase())) return false;
  }
  return true;
}

// Newest first. Filters: user (exact), action (exact or a prefix such as
// "lab"), target (exact, or its children: "x.lab.yml" also matches
// "x.lab.yml/node1"), q (free text), from / to (ISO times). Reads day files
// newest first and stops once `limit` entries matched, so a long history
// stays cheap.
function query(filters = {}) {
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 200, 1), 5000);
  let files = [];
  try {
    files = fs.readdirSync(AUDIT_DIR).filter((f) => FILE_RE.test(f)).sort().reverse();
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const day = FILE_RE.exec(f)[1];
    if (filters.from && `${day}T23:59:59.999Z` < filters.from) break;
    if (filters.to && `${day}T00:00:00.000Z` > filters.to) continue;
    const lines = fs.readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch (e) { continue; } // a torn last line after a crash
      if (matches(entry, filters)) out.push(entry);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Calls visit(entry) for every stored entry on or after `from` (ISO), in no
// particular order -- for summaries, which need all of them, not a page.
function eachEntry(visit, { from } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(AUDIT_DIR).filter((f) => FILE_RE.test(f));
  } catch (e) {
    return;
  }
  for (const f of files) {
    if (from && `${FILE_RE.exec(f)[1]}T23:59:59.999Z` < from) continue;
    for (const line of fs.readFileSync(path.join(AUDIT_DIR, f), 'utf-8').split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (e) { continue; } // a torn line after a crash
      if (!from || entry.time >= from) visit(entry);
    }
  }
}

module.exports = { record, query, eachEntry, AUDIT_DIR, RETENTION_DAYS };
