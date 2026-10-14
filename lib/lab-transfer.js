const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const files = require('./lab-files');
const { checkReferences } = require('./lab-import-check');

// Lab export / import / duplicate: a lab file out to the browser as a
// download, a downloaded (or hand-written) lab file back in as a NEW lab,
// and a copy of a lab as a new lab.
//
// Export is either
//   exact   the saved file byte for byte (comments included) -- a backup, or
//           the same lab moved to another labber instance;
//   clean   without each node's uuid / mac pins and mgmt IP / port -- a copy
//           that can run NEXT TO the original without two VMs sharing an
//           identity, and that first-boot fills in again. When there is
//           nothing to leave out the text is kept as written; otherwise it is
//           re-written by js-yaml, so comments are not kept.
// Duplicate is a clean copy saved straight away as a new lab.
// Import / duplicate never replace an existing lab and check the file
// exactly like a save from the editor. Import keeps the text as written and
// reports (without refusing) runbooks, Store entries or kinds the lab names
// that this instance lacks.

const MAX_IMPORT_BYTES = 1024 * 1024;
const INSTANCE_FIELDS = ['uuid', 'mac', 'mgmtIp', 'mgmtPort'];
const today = () => new Date().toISOString().slice(0, 10);

// -> { text, removed } -- removed: how many fields were left out
function cleanCopy(text) {
  const topo = yaml.load(text);
  let removed = 0;
  for (const spec of Object.values((topo && topo.nodes) || {})) {
    if (!spec || typeof spec !== 'object') continue;
    for (const key of INSTANCE_FIELDS) {
      if (key in spec) {
        delete spec[key];
        removed += 1;
      }
    }
  }
  return { text: removed ? yaml.dump(topo, { lineWidth: 120, noRefs: true }) : text, removed };
}

function cleanHeader(first, removed) {
  return `# ${first}\n${removed ? '# (node uuid / mac pins and management IPs left out)\n' : ''}`;
}

// -> { filename, text }
function exportLab(name, { clean = false } = {}) {
  const text = files.readLab(name); // throws for a name that is not a lab file
  if (!clean) return { filename: name, text };
  const copy = cleanCopy(text);
  return {
    filename: name.replace(/\.lab\.yml$/, '-clean.lab.yml'),
    text: cleanHeader(`${name} -- clean copy exported from labber-pve ${today()}`, copy.removed) + copy.text,
  };
}

function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('the file is empty');
  if (Buffer.byteLength(text, 'utf-8') > MAX_IMPORT_BYTES) throw new Error('a lab file is at most 1 MB');
  try {
    return yaml.load(text);
  } catch (err) {
    throw new Error(`not valid YAML: ${err.message}`);
  }
}

// Saves `text` as the new lab `name` -> its file name. 'wx': fails rather
// than overwrite if the same name appeared since newLabFilename() checked.
function writeNew(name, text) {
  const filename = files.newLabFilename(name);
  try {
    fs.writeFileSync(path.join(files.LABS_DIR, filename), text, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error(`"${filename}" already exists`), { status: 409 });
    throw err;
  }
  return filename;
}

// -> { name: '<lab>.lab.yml', warnings: [...] }
function importLab(name, text) {
  files.newLabFilename(name); // a taken or bad name is reported before the file is checked
  const topo = files.validateTopology(parse(text)); // with {{vars.x}} resolved
  return { name: writeNew(name, text), warnings: checkReferences(topo) };
}

// A clean copy of lab `name` as the new lab `newName` -> { name }
function duplicateLab(name, newName) {
  const copy = cleanCopy(files.readLab(name));
  const text = cleanHeader(`copy of ${name}, made in labber-pve ${today()}`, copy.removed) + copy.text;
  files.validateTopology(yaml.load(text));
  return { name: writeNew(newName, text) };
}

module.exports = { exportLab, importLab, duplicateLab, cleanCopy, MAX_IMPORT_BYTES };
