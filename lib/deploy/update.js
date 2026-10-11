const pve = require('../proxmox-client');
const vendors = require('../vendor-profiles');
const { parseTopology, readState, writeState } = require('../lab-files');
const { cloneNode, removeVm } = require('./node-ops');
const { reconcileBridges } = require('./bridges');
const { reconcileWiring } = require('./wiring');
const { reconcileNodes } = require('./reconcile-node');
const { describeKind } = require('./deploy');

// Patches an already-deployed lab's VMs to match the current saved YAML
// without re-cloning, so each node keeps its in-guest state (anything
// configured after boot) instead of losing it to a destroy+deploy cycle.
// Only fields that differ get patched and only changed nodes restart
// (stop+start: UUID/hw/wiring are read by the guest at boot, but far cheaper
// than a re-clone plus first-boot for every node).
async function update(name, onProgress = () => {}) {
  const labName = name.replace(/\.lab\.yml$/, '');
  const topo = parseTopology(name);
  const state = readState(name);
  if (!state) throw new Error(`"${name}" is not deployed -- use deploy instead`);

  const ctx = {
    name, labName, topo, state, onProgress,
    dirty: new Set(), // nodes that need a stop+start to apply changes
    added: new Set(), // subset of dirty that are brand new (start only, nothing to stop)
    removed: 0,
    nodeHw: {},
    cfgByNode: {},
  };

  try {
    await addNewNodes(ctx);
    await removeOldNodes(ctx);
    await reconcileNodes(ctx);
    await reconcileBridges(ctx);
    await reconcileWiring(ctx);
    await restartDirty(ctx);

    writeState(name, state);
    onProgress(`lab "${labName}" updated: ${ctx.dirty.size} node(s) restarted, ${ctx.added.size} added, ${ctx.removed} removed`);
    return state;
  } catch (err) {
    onProgress(`ERROR: ${err.message}`);
    throw err;
  }
}

// 1. Nodes in the new topology but not yet deployed: same clone + settings
// sequence as deploy().
async function addNewNodes({ name, labName, topo, state, nodeHw, dirty, added, onProgress }) {
  for (const [nodeName, nodeSpec] of Object.entries(topo.nodes)) {
    if (state.nodes[nodeName]) continue;
    const profile = vendors.requireProfile(nodeSpec.kind, nodeSpec.version);
    nodeHw[nodeName] = profile.hw;
    onProgress(`adding new node ${nodeName} (${describeKind(nodeSpec)})...`);
    await cloneNode({
      name, labName, nodeName, nodeSpec, profile, state,
      hooks: { cloned: (vmid) => onProgress(`  -> ${nodeName} cloned as vmid ${vmid}`) },
    });
    dirty.add(nodeName);
    added.add(nodeName);
  }
}

// 2. Nodes no longer in the new topology: same stop+delete as destroy().
async function removeOldNodes(ctx) {
  const { name, topo, state, onProgress } = ctx;
  for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
    if (topo.nodes[nodeName]) continue;
    onProgress(`removing node ${nodeName} (vmid ${nodeState.vmid})...`);
    await removeVm(nodeName, nodeState, onProgress, { announceDelete: false, prefix: '  -> ' });
    delete state.nodes[nodeName];
    writeState(name, state);
    ctx.removed++;
  }
}

// 6. Restart every node whose config changed: graceful stop (like the
// per-node power route, not destroy's hard stop -- the VM is staying), then
// start. Newly added nodes just start.
async function restartDirty({ state, dirty, added, onProgress }) {
  for (const nodeName of dirty) {
    const nodeState = state.nodes[nodeName];
    if (!nodeState) continue; // removed in step 2, nothing to restart
    if (added.has(nodeName)) {
      onProgress(`starting ${nodeName} (vmid ${nodeState.vmid})...`);
    } else {
      onProgress(`restarting ${nodeName} (vmid ${nodeState.vmid}) to apply changes...`);
      await pve.stopVm(nodeState.vmid, { graceful: true });
    }
    await pve.startVm(nodeState.vmid);
  }
}

module.exports = { update };
