const fs = require('fs');
const path = require('path');
const R = require('./library-read');
const { BUILTIN_DIR } = require('./paths');

// Copies the runbooks shipped in the image (runbooks/builtin/<name>/
// <version>.yml + .meta.json) into the app's own storage on boot, so
// everything lives, is backed up, and can be copied/versioned in one place.
// A version that already exists is never overwritten -- a locked built-in is
// immutable, and a draft may have been edited by a user since it was seeded.
// Shipping a fix means shipping a new version.

function seedBuiltins() {
  if (!fs.existsSync(BUILTIN_DIR)) return 0;
  let seeded = 0;
  for (const name of fs.readdirSync(BUILTIN_DIR)) {
    const dir = path.join(BUILTIN_DIR, name);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const version = file.slice(0, -4);
      if (R.readMeta(name, version)) continue;

      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${version}.meta.json`), 'utf-8'));
      R.writeAtomic(R.ymlPath(name, version), text);
      R.writeMeta(name, version, {
        ...meta,
        builtin: true,
        ...(meta.status === 'locked' ? { hash: R.sha256(text), lockedAt: meta.lockedAt || new Date().toISOString() } : {}),
      });
      seeded += 1;
    }
  }
  return seeded;
}

module.exports = { seedBuiltins };
