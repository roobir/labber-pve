const fs = require('fs');
const path = require('path');
const pve = require('./proxmox-client');
const reservations = require('./reservations');
const { listLabs, readState, parseTopology } = require('./lab-files');
const LABS_DIR = process.env.LABS_DIR || '/labs';


// Does the lab file ask for any post-deploy bootstrap? (drives the dashboard's
// "bootstrap" button; a broken/unreadable file just means "no"). The dashboard
// asks for every lab every few seconds, so the answer is remembered until the
// lab file changes (its modification time) rather than parsing the YAML again.
const bootstrapCache = new Map(); // labFile -> { mtimeMs, has }

function hasBootstrap(labFile) {
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(path.join(LABS_DIR, labFile)).mtimeMs;
  } catch (e) {
    return false;
  }
  const hit = bootstrapCache.get(labFile);
  if (hit && hit.mtimeMs === mtimeMs) return hit.has;
  let has = false;
  try {
    has = Object.values(parseTopology(labFile).nodes).some((n) => (n.bootstrap || []).length > 0);
  } catch (e) {
    has = false;
  }
  bootstrapCache.set(labFile, { mtimeMs, has });
  return has;
}

// --- Status / polling ---------------------------------------------------------
// Backs the dashboard's headline "N instances booted" metric plus per-lab
// per-node status.
function describeNodes(state, statusOf) {
  const nodes = {};
  for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
    nodes[nodeName] = {
      vmid: nodeState.vmid,
      kind: nodeState.kind,
      status: statusOf(nodeState.vmid),
      mgmtIp: nodeState.mgmtIp || null,
      mgmtPort: nodeState.mgmtPort || null,
    };
  }
  return nodes;
}

function labStatusFrom(name, state, statusOf) {
  if (!state) return { deployed: false, reservation: reservations.get(name) };
  return { deployed: true, nodes: describeNodes(state, statusOf), bootstrap: state.bootstrap || null, bootstrapConfigured: hasBootstrap(name), reservation: reservations.get(name) };
}

// One lab, asked of Proxmox VM by VM: exact and live (the console uses it to
// decide whether a node is running right now).
async function getLabStatus(name) {
  const state = readState(name);
  const live = {};
  if (state) {
    await Promise.all(Object.values(state.nodes).map(async (n) => {
      try {
        live[n.vmid] = (await pve.getVmStatus(n.vmid)).status;
      } catch (e) {
        live[n.vmid] = 'unknown';
      }
    }));
  }
  return labStatusFrom(name, state, (vmid) => live[vmid]);
}

// Every lab for the dashboard poll. Proxmox is asked ONCE for the status of
// all VMs on the node (not once per VM per lab), and that answer is shared for
// a couple of seconds by everything that asks -- the dashboard's two polls,
// every open tab, the public stats API -- instead of each repeating the calls.
const VM_LIST_TTL_MS = 2000;
let vmList = null; // { at, promise }

function vmStatusMap() {
  if (!vmList || Date.now() - vmList.at > VM_LIST_TTL_MS) {
    const entry = { at: Date.now() };
    entry.promise = pve.listVms()
      .then((vms) => new Map(vms.map((vm) => [Number(vm.vmid), vm.status])))
      .catch(() => {
        if (vmList === entry) vmList = null; // do not cache a failure
        return new Map();
      });
    vmList = entry;
  }
  return vmList.promise;
}

// Call after starting/stopping a VM so the next poll shows it straight away.
function invalidateVmStatuses() {
  vmList = null;
}

async function getAllStatuses() {
  const statuses = await vmStatusMap();
  const statusOf = (vmid) => statuses.get(Number(vmid)) || 'unknown';
  const results = {};
  for (const labFile of listLabs()) {
    results[labFile] = labStatusFrom(labFile, readState(labFile), statusOf);
  }
  return results;
}

module.exports = { getLabStatus, getAllStatuses, invalidateVmStatuses };
