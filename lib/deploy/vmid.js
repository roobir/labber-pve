const pve = require('../proxmox-client');

// Shared across every lab -- VMIDs are a single global Proxmox namespace,
// not per-lab, so two different labs' deploys can't be allowed to compute
// "free" VMIDs concurrently either (see allocateVmid()'s own comment).
const VMID_LOCK_KEY = 'vmid-alloc';

const VMID_RANGE_START = 9000; // stays clear of manually-assigned low VMIDs
const VMID_RANGE_END = 9999;

// Same deterministic-hash-then-linear-probe approach as network-manager's
// bridge numbers, just against real VM/CT IDs instead of interface names.
function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

async function allocateVmid(seed) {
  // PVE's VMID namespace is shared between QEMU VMs and LXC containers --
  // listVms() alone missed containers, so a "free" pick here could collide
  // with an existing CT ("unable to create VM <n> -- CT <n> already
  // exists"). See lib/proxmox-vm.js's listContainers() for the full story.
  //
  // This function only *picks* an id -- it doesn't reserve it (nothing is
  // actually taken until the caller's cloneVm() completes). Every call site
  // wraps the pick-then-clone pair together in the VMID_LOCK_KEY lock for
  // exactly that reason: without it, two concurrent deploys/updates could
  // both list the same "taken" set and pick the same free id.
  const [vms, cts] = await Promise.all([pve.listVms(), pve.listContainers()]);
  const taken = new Set([...vms, ...cts].map((v) => v.vmid));
  let n = VMID_RANGE_START + (hashSeed(seed) % (VMID_RANGE_END - VMID_RANGE_START));

  for (let attempts = 0; attempts < VMID_RANGE_END - VMID_RANGE_START; attempts++) {
    if (!taken.has(n)) return n;
    n = n + 1 >= VMID_RANGE_END ? VMID_RANGE_START : n + 1;
  }
  throw new Error(`No free VMIDs available (${VMID_RANGE_START}-${VMID_RANGE_END} exhausted)`);
}

module.exports = { allocateVmid, VMID_LOCK_KEY };
