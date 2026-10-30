const fs = require('fs');

// Write to a temp file next to the target, then rename it into place: a
// crash or a full disk mid-write leaves the old file intact instead of a
// truncated one. Same pattern reservations.js, runbooks/store.js and
// backup/settings.js already used -- shared here for every other JSON/YAML
// file this app keeps on the LABS_DIR volume.
function writeFileAtomic(file, data, options) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Reads a JSON file that may legitimately not exist yet (-> fallback()), but
// refuses to treat an unreadable or unparseable one as "not there": the
// callers used to fall back to defaults and then save them over the damaged
// file, which silently wiped every user / token / template mapping.
function readJsonOrDefault(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback();
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}) -- restore it from a backup or fix it by hand; labber-pve will not overwrite it`);
  }
}

module.exports = { writeFileAtomic, readJsonOrDefault };
