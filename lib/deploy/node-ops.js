const pve = require('../proxmox-client');
const configStore = require('../config-store');
const { toDnsSafeName } = require('../dns-safe-name');
const { writeState } = require('../lab-files');
const { withLock } = require('../async-lock');
const { allocateVmid, VMID_LOCK_KEY } = require('./vmid');

// Clones one node from its vendor's golden template, records it in the lab's
// state, and applies its per-node settings. `hooks.cloned(vmid)` lets the
// caller print its own progress between the clone and the settings call.
async function cloneNode({ name, labName, nodeName, nodeSpec, profile, state, hooks = {} }) {
  const diskStorage = configStore.get().diskStorage;
  const full = !!nodeSpec.full;
  const vmid = await withLock(VMID_LOCK_KEY, async () => {
    const id = await allocateVmid(`${labName}:${nodeName}`);
    await pve.cloneVm({
      templateId: profile.templateId,
      newId: id,
      // Same DNS-hostname validation template-builder.js hit -- nodeName is a
      // free-form YAML map key and could contain underscores/spaces/anything.
      name: toDnsSafeName(`labber-pve-${labName}-${nodeName}`),
      full,
      // Confirmed against a real PVE node: `storage` is rejected for linked
      // clones ("parameter 'storage' not allowed for linked clones") -- a
      // linked clone's overlay always lives beside the template's disk. Only
      // full clones can target a different storage.
      ...(full && diskStorage ? { targetStorage: diskStorage } : {}),
    });
    return id;
  });
  state.nodes[nodeName] = { vmid, kind: nodeSpec.kind, version: nodeSpec.version };
  // A previously-saved mgmt IP (lab-state.js's setNodeMgmtIp persists it into
  // the lab file) carries into a fresh deploy: most appliance images have no
  // guest agent to detect an IP from, so retyping it after every redeploy is
  // avoidable friction.
  if (nodeSpec.mgmtIp) {
    state.nodes[nodeName].mgmtIp = nodeSpec.mgmtIp;
    state.nodes[nodeName].mgmtPort = nodeSpec.mgmtPort || 443;
  }
  writeState(name, state); // persist progressively so a mid-failure destroy has something real to clean up
  if (hooks.cloned) hooks.cloned(vmid);

  // Per-node cores/memory override (a clone otherwise inherits the vendor
  // template's fixed hw profile), applied right after the clone because PVE's
  // clone endpoint has no cores/memory params. `agent: 1` only lets PVE
  // *attempt* the guest-agent IP lookup; harmless when no agent runs. Pinning
  // the SMBIOS UUID is what lets a UUID-keyed vendor license survive a
  // destroy+redeploy (see lib/node-identity.js).
  const hwOverride = { agent: '1' };
  if (nodeSpec.cores) hwOverride.cores = nodeSpec.cores;
  if (nodeSpec.memory) hwOverride.memory = nodeSpec.memory;
  if (nodeSpec.uuid) hwOverride.smbios1 = `uuid=${nodeSpec.uuid}`;
  await pve.setVmConfig(vmid, hwOverride);
  return vmid;
}

// Hard-stop then delete a VM, tolerating one that is already stopped or gone
// (deleted by hand in the Proxmox UI, or an earlier teardown got partway):
// that must not abort the rest of a teardown, though any other API error should.
async function removeVm(nodeName, nodeState, onProgress, { announceDelete, prefix }) {
  try {
    await pve.stopVm(nodeState.vmid, { graceful: false });
  } catch (e) {
    // already stopped/gone -- fine, still attempt delete below
  }
  if (announceDelete) onProgress(`deleting ${nodeName}...`);
  try {
    await pve.deleteVm(nodeState.vmid);
  } catch (e) {
    if (!/does not exist/i.test(e.message)) throw e;
    onProgress(`${prefix}${nodeName} (vmid ${nodeState.vmid}) already gone, skipping`);
  }
}

module.exports = { cloneNode, removeVm };
