const pve = require('./proxmox-client');
const { withLock } = require('./async-lock');

// Same reasoning as lab-deploy.js's VMID_LOCK_KEY: allocateBridgeName()
// only picks a free number, it doesn't reserve it -- nothing is actually
// taken until createBridge() completes. Global (not per-lab) since bridge
// interface names are a single node-wide namespace, same as VMIDs.
const BRIDGE_LOCK_KEY = 'bridge-alloc';

// Linux network interface names are capped at 15 bytes (IFNAMSIZ - 1,
// see if.h). "vmbr" + up to 4 digits keeps every generated name well under
// that regardless of how long the lab/link names in the YAML are -- the
// human-readable name lives in the bridge's `comments` field instead, not
// the interface name itself.
const PREFIX = 'vmbr';
const RANGE_START = 100; // low numbers (vmbr0-vmbr9) are conventionally the
// node's real/physical bridges -- stay out of that range entirely.
const RANGE_END = 9999;

function hashSeed(seed) {
  // FNV-1a, good enough distribution for a homelab-scale number of labs/links
  // -- this only needs to avoid *accidental* collisions, not be
  // cryptographically sound.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic first guess from (labName, linkName) so re-running the same
// lab YAML tends to land on the same bridge number even without consulting
// the state file -- collisions (two labs hashing to the same slot) are
// resolved by linear probing against what's actually allocated right now.
async function allocateBridgeName(seed) {
  const existing = new Set((await pve.listNetworkInterfaces()).map((i) => i.iface));
  let n = RANGE_START + (hashSeed(seed) % (RANGE_END - RANGE_START));

  for (let attempts = 0; attempts < RANGE_END - RANGE_START; attempts++) {
    const candidate = `${PREFIX}${n}`;
    if (!existing.has(candidate)) return candidate;
    n = n + 1 >= RANGE_END ? RANGE_START : n + 1;
  }
  throw new Error('No free bridge numbers available (vmbr100-9999 exhausted)');
}

// `external` links reuse a caller-supplied bridge (already exists on the
// node, or shared deliberately across labs) rather than allocating a fresh
// isolated one -- mirrors the `external: true` Docker network pattern used
// elsewhere in this homelab's compose files.
async function ensureLinkBridge(labName, link) {
  if (link.external) {
    return { iface: link.bridge, created: false };
  }

  return withLock(BRIDGE_LOCK_KEY, async () => {
    const iface = await allocateBridgeName(`${labName}:${link.name}`);
    await pve.createBridge(iface, {
      comments: `labber-pve:${labName}:${link.name}`,
    });
    return { iface, created: true };
  });
}

async function applyPendingChanges() {
  await pve.applyNetworkChanges();
}

async function teardownBridge(iface) {
  await pve.deleteBridge(iface);
}

// Every bridge on the node -- both the ones a user already built by hand
// (e.g. vmbr2/vmbr4/vmbr5... for real uplinks/VLANs) and any this app
// auto-provisioned for a lab. Filters listNetworkInterfaces() down from
// every interface type (physical NICs, bonds, VLANs) to just bridges, and
// sorts numerically (vmbr2 before vmbr10) rather than the lexical order
// the raw API response happens to come back in. Backs the lab wizard's
// "which bridge for this external link" picker.
async function listBridges() {
  const ifaces = await pve.listNetworkInterfaces();
  return ifaces
    .filter((i) => i.type === 'bridge')
    .map((i) => ({
      iface: i.iface,
      comments: i.comments || '',
      active: !!i.active,
      bridgePorts: i.bridge_ports || '',
    }))
    .sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

// Deliberately internal-only (no bridgePorts option exposed here, unlike
// createBridge() itself) -- this is the user-facing "create a new bridge to
// pick from" action, and a real physical NIC/VLAN typo here could disrupt
// the node's actual host networking. Auto-provisioned lab bridges already
// go through the plain createBridge() call above, not this one.
async function createNamedBridge(iface, comments) {
  await pve.createBridge(iface, { comments });
  await pve.applyNetworkChanges();
}

module.exports = {
  allocateBridgeName,
  ensureLinkBridge,
  applyPendingChanges,
  teardownBridge,
  listBridges,
  createNamedBridge,
};
