const pve = require('../proxmox-client');
const vendors = require('../vendor-profiles');
const identity = require('../node-identity');
const { writeState } = require('../lab-files');

// update step 3: compare every surviving node against its LIVE Proxmox config
// and patch only what differs from the saved YAML, marking those nodes dirty
// (they get a stop+start at the end). Live config is the diff source of truth,
// the same idiom node-identity.js uses for the anchor feature, rather than a
// second "last applied spec" kept in state.json.
async function reconcileNodes({ name, topo, state, nodeHw, cfgByNode, dirty, added, onProgress }) {
  for (const [nodeName, nodeState] of Object.entries(state.nodes)) {
    const nodeSpec = topo.nodes[nodeName];
    if (nodeState.kind !== nodeSpec.kind) {
      throw new Error(`Node "${nodeName}": kind changed from "${nodeState.kind}" to "${nodeSpec.kind}" -- destroy and redeploy instead of update`);
    }
    // Same "can't patch a different golden disk in place" reasoning: a version
    // change means cloning from another template, not a hardware tweak.
    // `|| undefined` on both sides treats a missing key and an empty string
    // as the same "default version".
    if ((nodeState.version || undefined) !== (nodeSpec.version || undefined)) {
      throw new Error(`Node "${nodeName}": version changed from "${nodeState.version || '(default)'}" to "${nodeSpec.version || '(default)'}" -- destroy and redeploy instead of update`);
    }
    const hw = (nodeHw[nodeName] = vendors.requireProfile(nodeSpec.kind, nodeSpec.version).hw);
    // Nodes added in step 1 have no live config to diff yet; they go straight
    // to wiring, where a missing snapshot counts as "always differs".
    if (added.has(nodeName)) continue;

    const cfg = (cfgByNode[nodeName] = await pve.getVmConfig(nodeState.vmid));
    await patchHardware({ nodeName, nodeState, nodeSpec, hw, cfg, dirty, onProgress });
    await patchIdentity({ nodeName, nodeState, nodeSpec, cfg, dirty, onProgress });

    // mgmt IP -- bookkeeping only, no VM patch/restart needed.
    if (nodeSpec.mgmtIp && nodeSpec.mgmtIp !== nodeState.mgmtIp) {
      nodeState.mgmtIp = nodeSpec.mgmtIp;
      nodeState.mgmtPort = nodeSpec.mgmtPort || 443;
      writeState(name, state);
    }
  }
}

async function patchHardware({ nodeName, nodeState, nodeSpec, hw, cfg, dirty, onProgress }) {
  const patch = {};
  const desiredCores = nodeSpec.cores || hw.cores;
  const desiredMemory = nodeSpec.memory || hw.memory;
  if (Number(cfg.cores) !== desiredCores) patch.cores = desiredCores;
  if (Number(cfg.memory) !== desiredMemory) patch.memory = desiredMemory;
  if (!Object.keys(patch).length) return;
  onProgress(`${nodeName}: hw changed (cores ${cfg.cores}->${desiredCores}, memory ${cfg.memory}->${desiredMemory}MB)`);
  await pve.setVmConfig(nodeState.vmid, patch);
  dirty.add(nodeName);
}

// uuid/mac: only fields explicitly pinned in the YAML are touched.
async function patchIdentity({ nodeName, nodeState, nodeSpec, cfg, dirty, onProgress }) {
  const live = identity.parseIdentity(cfg);
  if (nodeSpec.uuid && live.uuid !== nodeSpec.uuid) {
    onProgress(`${nodeName}: uuid changed -- pinning ${nodeSpec.uuid}`);
    await identity.applyIdentity(nodeState.vmid, { uuid: nodeSpec.uuid });
    dirty.add(nodeName);
  }
  if (!nodeSpec.mac) return;
  const macDiff = {};
  for (const [iface, mac] of Object.entries(nodeSpec.mac)) {
    if (live.macs[iface] !== mac) macDiff[iface] = mac;
  }
  if (!Object.keys(macDiff).length) return;
  onProgress(`${nodeName}: mac changed on ${Object.keys(macDiff).join(', ')}`);
  await identity.applyIdentity(nodeState.vmid, { macs: macDiff });
  // Keep the snapshot in sync with the mac(s) just pushed: the wiring diff
  // reuses it, and would otherwise see the old mac and write the NIC twice.
  for (const [iface, mac] of Object.entries(macDiff)) cfg[iface] = identity.buildNicValue(cfg[iface], mac);
  dirty.add(nodeName);
}

module.exports = { reconcileNodes };
