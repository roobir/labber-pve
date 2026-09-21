const yaml = require('js-yaml');
const pve = require('./proxmox-client');
const { listLabs, readState, writeState, parseTopology, writeLab, validateTopology, HOST_RE } = require('./lab-files');

// --- Status / polling ---------------------------------------------------------
// Backs the dashboard's headline "N instances booted" metric plus per-lab
// per-node status.
async function getLabStatus(name) {
  const state = readState(name);
  if (!state) return { deployed: false };

  const nodes = {};
  for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
    const mgmt = { mgmtIp: nodeState.mgmtIp || null, mgmtPort: nodeState.mgmtPort || null };
    try {
      const status = await pve.getVmStatus(nodeState.vmid);
      nodes[nodeName] = { vmid: nodeState.vmid, kind: nodeState.kind, status: status.status, ...mgmt };
    } catch (e) {
      nodes[nodeName] = { vmid: nodeState.vmid, kind: nodeState.kind, status: 'unknown', ...mgmt };
    }
  }
  return { deployed: true, nodes };
}

async function getAllStatuses() {
  const results = {};
  for (const labFile of listLabs()) {
    results[labFile] = await getLabStatus(labFile);
  }
  return results;
}

// --- Mgmt IP: manual entry + best-effort guest-agent auto-detect --------------
// HOST_RE lives in lab-files.js (validateTopology() needs it too, to check
// a hand-edited/persisted mgmtIp the same way) -- imported above rather
// than duplicated here.

function setNodeMgmtIp(labFile, nodeName, ip, port) {
  const state = readState(labFile);
  if (!state) throw new Error(`"${labFile}" has no deployed state`);
  if (!state.nodes[nodeName]) throw new Error(`Unknown node "${nodeName}" in "${labFile}"`);

  const host = String(ip || '').trim();
  if (!host || !HOST_RE.test(host)) throw new Error('IP/hostname looks invalid');
  const p = port ? parseInt(port, 10) : 443;
  if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('port must be between 1 and 65535');

  state.nodes[nodeName].mgmtIp = host;
  state.nodes[nodeName].mgmtPort = p;
  writeState(labFile, state);

  // Also persist into the lab file itself (not just this deployment's
  // ephemeral runtime state) -- same "survives a destroy+redeploy" pattern
  // as setNodeIdentityPin below, just for the manually-entered mgmt IP
  // instead of uuid/mac. deploy() reads this back (lib/lab-deploy.js) to
  // pre-populate a freshly redeployed node's state with the same IP, so
  // the dashboard's "web ui"/"web rp" options come back without having to
  // type it in again.
  const topo = parseTopology(labFile);
  if (topo.nodes[nodeName]) {
    topo.nodes[nodeName].mgmtIp = host;
    topo.nodes[nodeName].mgmtPort = p;
    validateTopology(topo);
    writeLab(labFile, yaml.dump(topo));
  }

  return { mgmtIp: host, mgmtPort: p };
}

// Backs the dashboard's per-node start/shutdown buttons -- distinct from
// mgmtIp/mgmtPort above (those are for reaching a node's *own* web UI/API,
// this is for controlling the underlying Proxmox VM itself). Same
// readState()+validate pattern as setNodeMgmtIp/getNodeTarget.
function getNodeVmid(labFile, nodeName) {
  const state = readState(labFile);
  if (!state) throw new Error(`"${labFile}" has no deployed state`);
  const node = state.nodes[nodeName];
  if (!node) throw new Error(`Unknown node "${nodeName}" in "${labFile}"`);
  return node.vmid;
}

// Resolves a running node's real target (ip:port) for the gui-proxy's
// Host-header routing (see lib/gui-proxy.js) -- labName is the *bare* lab
// name (no .lab.yml suffix, matching the subdomain convention
// `<labName>--<nodeName>.<guiDomain>`), not the labFile readState()/
// writeState() otherwise expect, so it's reconstructed here rather than
// making every caller remember the suffix. `kind` is included so gui-
// proxy.js can apply kind-specific response handling (currently: F5 BIG-IP's
// login.jsp frame-busting rewrite) without needing a second lookup.
function getNodeTarget(labName, nodeName) {
  const state = readState(`${labName}.lab.yml`);
  if (!state) return null;
  const node = state.nodes[nodeName];
  if (!node || !node.mgmtIp) return null;
  return { ip: node.mgmtIp, port: node.mgmtPort || 443, kind: node.kind };
}

// Writes a uuid/mac pin into the node's entry in the lab's .lab.yml itself
// (not the ephemeral per-deploy state.json, which destroy() wipes) -- this
// is the actual persistence mechanism behind the dashboard's "anchor"
// action: capture whatever's currently live on the real VM (or an explicit
// edited value) so the *next* deploy reuses it instead of getting a fresh
// Proxmox-assigned UUID/MAC. mac entries are merged into any existing pins
// rather than replacing the whole map, so anchoring/editing one interface
// doesn't drop a pin already set on another.
function setNodeIdentityPin(labFile, nodeName, { uuid, mac } = {}) {
  const topo = parseTopology(labFile);
  if (!topo.nodes[nodeName]) throw new Error(`Unknown node "${nodeName}" in "${labFile}"`);
  if (uuid) topo.nodes[nodeName].uuid = uuid;
  if (mac && Object.keys(mac).length) {
    topo.nodes[nodeName].mac = { ...(topo.nodes[nodeName].mac || {}), ...mac };
  }
  validateTopology(topo);
  writeLab(labFile, yaml.dump(topo));
  return topo.nodes[nodeName];
}

// Best-effort only -- see proxmox-vm.js's getAgentInterfaces() comment for
// why most vendor appliance images won't have a guest agent running at all.
// Filters out loopback/link-local/APIPA-ish noise and returns candidates
// for the dashboard to offer as one-click picks (falling back to manual
// entry when this comes back empty or errors).
async function detectNodeIp(labFile, nodeName) {
  const state = readState(labFile);
  if (!state) throw new Error(`"${labFile}" has no deployed state`);
  const nodeState = state.nodes[nodeName];
  if (!nodeState) throw new Error(`Unknown node "${nodeName}" in "${labFile}"`);

  const interfaces = await pve.getAgentInterfaces(nodeState.vmid);
  const candidates = [];
  for (const iface of interfaces) {
    if (iface.name === 'lo') continue;
    for (const addr of iface['ip-addresses'] || []) {
      if (addr['ip-address-type'] !== 'ipv4') continue;
      if (addr['ip-address'].startsWith('127.') || addr['ip-address'].startsWith('169.254.')) continue;
      candidates.push(addr['ip-address']);
    }
  }
  return candidates;
}

// A mgmt IP is free-form (see lab-files.js's HOST_RE, which explicitly
// allows IPv6) but every consumer (gui-proxy.js, api-relay.js, the
// dashboard's "web ui" link) builds a plain `https://<host>:<port>` string
// -- a bare IPv6 literal there is ambiguous/unparseable (the colons collide
// with the port separator), it needs [bracket] wrapping like any URL host.
// IPv4 and hostnames pass through unchanged.
function formatHostPort(host, port) {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${bracketed}:${port}`;
}

module.exports = {
  getLabStatus,
  getAllStatuses,
  setNodeMgmtIp,
  setNodeIdentityPin,
  getNodeVmid,
  getNodeTarget,
  formatHostPort,
  detectNodeIp,
};
