const net = require('../network-manager');
const { writeState } = require('../lab-files');

const anyCreated = (state) => Object.values(state.bridges).some((b) => b.created);

async function applyNetwork(onProgress) {
  onProgress('applying network changes...');
  await net.applyPendingChanges();
}

// deploy: provision every link's bridge (or reuse an external one).
async function provisionBridges({ name, labName, topo, state, onProgress }) {
  for (const link of topo.links || []) {
    onProgress(link.external ? `link "${link.name}": reusing external bridge ${link.bridge}` : `link "${link.name}": provisioning bridge...`);
    const { iface, created } = await net.ensureLinkBridge(labName, link);
    state.bridges[link.name] = { iface, created };
    writeState(name, state);
    onProgress(`  -> ${iface}`);
  }
  if (anyCreated(state)) await applyNetwork(onProgress);
}

// destroy: remove every bridge this lab created (external ones are not ours).
async function teardownCreatedBridges(state, onProgress) {
  for (const [linkName, bridge] of Object.entries(state.bridges)) {
    if (bridge.created) {
      onProgress(`removing bridge ${bridge.iface} (link "${linkName}")...`);
      await net.teardownBridge(bridge.iface);
    }
  }
  if (anyCreated(state)) await applyNetwork(onProgress);
}

// update: new link names get a fresh bridge, removed ones tear theirs down,
// unchanged ones keep their iface (unlike deploy, this must NOT re-allocate a
// bridge for a link name it has seen before). A link that switches to/from
// `external` gets its auto-provisioned bridge torn down / a fresh one allocated.
async function reconcileBridges({ name, labName, topo, state, onProgress }) {
  let changed = false;
  const topoLinkNames = new Set((topo.links || []).map((l) => l.name));
  for (const link of topo.links || []) {
    const existing = state.bridges[link.name];
    if (link.external) {
      if (existing && existing.created) {
        onProgress(`link "${link.name}": now external -- tearing down previously auto-created bridge ${existing.iface}`);
        await net.teardownBridge(existing.iface);
        changed = true;
      }
      state.bridges[link.name] = { iface: link.bridge, created: false };
    } else if (existing && existing.created) {
      state.bridges[link.name] = existing; // unchanged, reuse iface as-is
    } else {
      onProgress(`link "${link.name}": provisioning bridge...`);
      const { iface, created } = await net.ensureLinkBridge(labName, link);
      state.bridges[link.name] = { iface, created };
      onProgress(`  -> ${iface}`);
      changed = true;
    }
  }
  for (const linkName of Object.keys(state.bridges)) {
    if (topoLinkNames.has(linkName)) continue;
    const bridge = state.bridges[linkName];
    if (bridge.created) {
      onProgress(`removing bridge ${bridge.iface} (link "${linkName}" removed)...`);
      await net.teardownBridge(bridge.iface);
      changed = true;
    }
    delete state.bridges[linkName];
  }
  writeState(name, state);
  if (changed) await applyNetwork(onProgress);
}

module.exports = { provisionBridges, teardownCreatedBridges, reconcileBridges };
