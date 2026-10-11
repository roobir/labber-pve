const fs = require('fs');
const path = require('path');
const { RUNS_DIR } = require('./paths');

// readAll() returns summaries (no events); read(id) returns the full record.
// Finished runs, as redacted JSON files in RUNS_DIR (console output is not
// kept, only the step/log events). Newest MAX_RECORDS_KEPT survive.

const MAX_RECORDS_KEPT = 100;

function persist(record) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, `${record.id}.json`), JSON.stringify(record));
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length <= MAX_RECORDS_KEPT) return;
  const oldestFirst = files
    .map((f) => ({ f, t: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  for (const { f } of oldestFirst.slice(0, files.length - MAX_RECORDS_KEPT)) fs.rmSync(path.join(RUNS_DIR, f), { force: true });
}

// The Runs tab lists these every few seconds. Each record holds a run's whole
// event log, so re-reading and parsing up to 100 of them per poll (on the
// event loop) was the heaviest thing the page did. Summaries are cached per
// file and a file is only parsed again when its modification time changes.
const cache = new Map(); // file -> { mtimeMs, summary }

function readAll() {
  try {
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      const full = path.join(RUNS_DIR, f);
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (e) {
        continue; // pruned between readdir and stat
      }
      let hit = cache.get(f);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        try {
          const { events, ...summary } = JSON.parse(fs.readFileSync(full, 'utf-8'));
          hit = { mtimeMs, summary };
          cache.set(f, hit);
        } catch (e) {
          continue;
        }
      }
      out.push(hit.summary);
    }
    for (const f of cache.keys()) if (!files.includes(f)) cache.delete(f);
    return out;
  } catch (e) {
    return [];
  }
}

function read(runId) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${path.basename(runId)}.json`), 'utf-8'));
}

module.exports = { persist, readAll, read };
