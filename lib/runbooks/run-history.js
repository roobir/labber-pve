const fs = require('fs');
const path = require('path');
const { RUNS_DIR } = require('./paths');

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

function readAll() {
  try {
    return fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')));
  } catch (e) {
    return [];
  }
}

function read(runId) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${path.basename(runId)}.json`), 'utf-8'));
}

module.exports = { persist, readAll, read };
