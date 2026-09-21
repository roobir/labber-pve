const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const identity = require('./node-identity');

const LABS_DIR = process.env.LABS_DIR || '/labs';
const STATE_DIR = path.join(LABS_DIR, '.state');

fs.mkdirSync(STATE_DIR, { recursive: true });

// Loose host validation, shared with lab-state.js's setNodeMgmtIp (which
// writes this same string into both runtime state and the lab file
// itself, this module's own validateTopology() is what checks the latter)
// -- this string ends up server-side in a proxied request target
// (lib/gui-proxy.js) as well as directly in a browser URL, so it's
// checked against a plausible-hostname/IPv4/IPv6 character set rather
// than trusted verbatim, without trying to be a full RFC validator.
const HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

// --- Lab file access ---------------------------------------------------------
// Same pattern as clab-dashboard's lab-manager: always re-validate a
// client-supplied name against the real directory listing before touching
// the filesystem with it, rather than trusting it directly.
function listLabs() {
  return fs
    .readdirSync(LABS_DIR)
    .filter((f) => f.endsWith('.lab.yml'))
    .sort();
}

function assertKnownLab(name) {
  if (!listLabs().includes(name)) {
    throw new Error(`Unknown lab file: ${name}`);
  }
}

function readLab(name) {
  assertKnownLab(name);
  return fs.readFileSync(path.join(LABS_DIR, name), 'utf-8');
}

function writeLab(name, content) {
  assertKnownLab(name);
  fs.writeFileSync(path.join(LABS_DIR, name), content, 'utf-8');
}

// Deletes the .lab.yml file itself (distinct from destroy(), which tears
// down the deployed VMs/bridges but leaves the file in place) -- only
// allowed once there's no deployed state left, so a lab's file can't be
// deleted out from under VMs/bridges this app still thinks it owns and
// would otherwise never be able to clean up.
function deleteLab(name) {
  assertKnownLab(name);
  if (readState(name)) {
    throw new Error(`"${name}" is still deployed -- destroy it first`);
  }
  fs.rmSync(path.join(LABS_DIR, name), { force: true });
}

// Unlike writeLab() (edit an existing file), this is the "new lab" wizard's
// entry point -- deliberately the opposite assertion (must NOT already
// exist) so the wizard can't silently clobber a hand-edited lab that
// happens to share its name. Topology comes in as parsed JSON (built by the
// wizard's form), not raw YAML text, and is serialized here with js-yaml so
// the on-disk file always comes out consistently formatted.
function createLab(name, topology) {
  const base = String(name || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(base)) {
    throw new Error('Lab name must be alphanumeric/underscore/hyphen only');
  }
  const filename = `${base}.lab.yml`;
  if (listLabs().includes(filename)) {
    throw new Error(`"${filename}" already exists`);
  }
  validateTopology(topology);
  fs.writeFileSync(path.join(LABS_DIR, filename), yaml.dump(topology), 'utf-8');
  return filename;
}

// --- Deploy state file access -------------------------------------------------
// Low-level state.json read/write/clear -- kept here (not lib/lab-state.js)
// specifically so deleteLab() above can check readState() without a
// lab-files.js <-> lab-state.js require cycle; lib/lab-state.js/lib/lab-
// deploy.js both build their higher-level behavior on top of these three.
// Unlike the lab-file helpers above, these take a name that hasn't
// necessarily been through assertKnownLab() -- getNodeTarget() in
// lib/lab-state.js reconstructs one from a gui-proxy hostname or an
// /api/relay/<lab>/... URL segment, and that segment is URL-decoded, so
// "..%2f.." arrives here as real path separators. Left unguarded, that
// walks out of STATE_DIR and probes for arbitrary .json files on the
// volume. Nothing legitimate needs a separator in a lab name.
function statePath(name) {
  const safe = String(name);
  if (safe.includes('/') || safe.includes('\\') || safe.includes('\0')) {
    throw new Error(`Invalid lab name: ${name}`);
  }
  return path.join(STATE_DIR, `${safe}.json`);
}

function readState(name) {
  try {
    return JSON.parse(fs.readFileSync(statePath(name), 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeState(name, state) {
  fs.writeFileSync(statePath(name), JSON.stringify(state, null, 2), 'utf-8');
}

function clearState(name) {
  fs.rmSync(statePath(name), { force: true });
}

// --- Topology validation -----------------------------------------------------
// Split from parseTopology() so the PUT /api/labs/:name route can validate
// content the same way before it's ever written to disk, not just when a
// deploy is attempted against an already-saved file.
function validateTopology(topo) {
  if (!topo || typeof topo !== 'object') throw new Error('Lab YAML must be a mapping');
  if (!topo.nodes || typeof topo.nodes !== 'object') throw new Error('Lab YAML needs a `nodes:` map');
  for (const [nodeName, nodeSpec] of Object.entries(topo.nodes)) {
    if (!nodeSpec || !nodeSpec.kind) throw new Error(`Node "${nodeName}" needs a \`kind\``);
    // `version` picks a specific named build out of config-store's
    // templateVersions[kind] (see vendor-profiles.js's getProfile) instead
    // of whatever `templates[kind]` currently defaults to -- optional, same
    // as cores/memory below. Only a shape check here (whether the named
    // version actually exists for this kind is a live Proxmox-config
    // question, same category as an unconfigured kind's templateId --
    // deploy-time's requireProfile() already gives a clear error for that).
    if (nodeSpec.version !== undefined && (typeof nodeSpec.version !== 'string' || !nodeSpec.version.trim())) {
      throw new Error(`Node "${nodeName}": \`version\` must be a non-empty string`);
    }
    // cores/memory are optional per-node overrides of the vendor template's
    // own defaults (see lab-deploy.js's deploy() step 1b) -- validated here,
    // not just left to fail as a raw Proxmox API error, since a bad wizard/
    // hand-edit value should be caught before any clone/API call happens.
    if (nodeSpec.cores !== undefined && !(Number.isInteger(nodeSpec.cores) && nodeSpec.cores > 0)) {
      throw new Error(`Node "${nodeName}": \`cores\` must be a positive integer`);
    }
    if (nodeSpec.memory !== undefined && !(Number.isInteger(nodeSpec.memory) && nodeSpec.memory > 0)) {
      throw new Error(`Node "${nodeName}": \`memory\` (MB) must be a positive integer`);
    }
    // `uuid`/`mac` pin the node's SMBIOS UUID / per-interface MAC across
    // redeploys (see lib/node-identity.js) -- optional, same as cores/memory,
    // and typically set via the dashboard's "anchor" action rather than
    // hand-written, but validated here either way since hand-edited YAML is
    // just as valid an input as the wizard.
    if (nodeSpec.uuid !== undefined && !identity.UUID_RE.test(nodeSpec.uuid)) {
      throw new Error(`Node "${nodeName}": \`uuid\` must look like a standard UUID (8-4-4-4-12 hex)`);
    }
    if (nodeSpec.mac !== undefined) {
      if (typeof nodeSpec.mac !== 'object' || nodeSpec.mac === null || Array.isArray(nodeSpec.mac)) {
        throw new Error(`Node "${nodeName}": \`mac\` must be a map of interface -> MAC address`);
      }
      for (const [iface, mac] of Object.entries(nodeSpec.mac)) {
        if (!identity.MAC_RE.test(mac)) {
          throw new Error(`Node "${nodeName}": mac for "${iface}" must look like aa:bb:cc:dd:ee:ff`);
        }
      }
    }
    // mgmtIp/mgmtPort: same "survive a destroy+redeploy" purpose as uuid/mac
    // above, just for the dashboard's manually-entered mgmt IP (lib/lab-
    // state.js's setNodeMgmtIp persists here in addition to runtime state)
    // rather than something Proxmox-level -- most vendor appliance images
    // have no guest agent to auto-detect an IP from, and a static/DHCP-
    // reserved address is common enough that re-typing it after every
    // rebuild is real, avoidable friction.
    if (nodeSpec.mgmtIp !== undefined && !HOST_RE.test(String(nodeSpec.mgmtIp))) {
      throw new Error(`Node "${nodeName}": \`mgmtIp\` looks invalid`);
    }
    if (nodeSpec.mgmtPort !== undefined) {
      const p = Number(nodeSpec.mgmtPort);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) {
        throw new Error(`Node "${nodeName}": \`mgmtPort\` must be between 1 and 65535`);
      }
    }
  }
  for (const link of topo.links || []) {
    if (!link.name) throw new Error('Every link needs a `name`');
    if (link.external && !link.bridge) throw new Error(`Link "${link.name}" is external but has no \`bridge\``);

    // Minimum endpoint count differs (a P2P/shared segment needs 2+; an
    // external link reusing a real bridge is meaningful with just 1 -- e.g.
    // one firewall interface wired straight to an existing vmbr), but an
    // endpoint's *contents* (known node, no duplicates) get checked either
    // way -- external links used to skip this validation entirely, which
    // also meant they silently accepted having zero endpoints (a bridge
    // reference with nothing ever wired to it).
    const minEndpoints = link.external ? 1 : 2;
    if (!link.endpoints || link.endpoints.length < minEndpoints) {
      throw new Error(`Link "${link.name}" needs at least ${minEndpoints} endpoint${minEndpoints > 1 ? 's' : ''}`);
    }
    // Catches both hand-edited YAML and a wizard bug that once defaulted
    // every new endpoint row to the same node -- deploy() would otherwise
    // silently rewire that one node's interface repeatedly instead of
    // erroring, with the other nodes never wired to this link at all.
    const seen = new Set();
    for (const ep of link.endpoints) {
      if (!ep.node || !ep.interface) {
        throw new Error(`Link "${link.name}" has an endpoint missing \`node\` or \`interface\``);
      }
      if (!topo.nodes[ep.node]) {
        throw new Error(`Link "${link.name}" references unknown node "${ep.node}"`);
      }
      const key = `${ep.node}:${ep.interface}`;
      if (seen.has(key)) {
        throw new Error(`Link "${link.name}" has the same endpoint (${ep.node}:${ep.interface}) more than once`);
      }
      seen.add(key);
    }
  }
  return topo;
}

function parseTopology(name) {
  return validateTopology(yaml.load(readLab(name)));
}

module.exports = {
  listLabs,
  readLab,
  writeLab,
  createLab,
  deleteLab,
  readState,
  writeState,
  clearState,
  validateTopology,
  parseTopology,
  HOST_RE,
};
