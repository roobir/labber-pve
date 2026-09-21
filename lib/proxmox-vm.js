const { pve } = require('./proxmox-request');
const { waitForTask } = require('./proxmox-tasks');

// --- VM lifecycle -------------------------------------------------------------
async function listVms() {
  return pve('GET', '/nodes/{node}/qemu');
}

// PVE's VMID namespace is shared between QEMU VMs *and* LXC containers on a
// given node -- callers building a "what's taken" set (findFreeVmidInRange
// below) need both, not just listVms()'s qemu-only view, or a picked "free"
// VMID can collide with an existing container ("unable to create VM <n> --
// CT <n> already exists"), confirmed happening for real once this homelab's
// Proxmox node had containers in the same range this app's own template
// VMIDs auto-pick from.
async function listContainers() {
  return pve('GET', '/nodes/{node}/lxc');
}

async function getVmStatus(vmid) {
  return pve('GET', `/nodes/{node}/qemu/${vmid}/status/current`);
}

// Only returns anything useful if qemu-guest-agent is actually installed
// and running *inside* the guest -- true for general-purpose Linux/Windows
// VMs, but none of this app's vendor appliance images (FortiOS, PAN-OS,
// Check Point Gaia, Cisco NX-OSv/IOS-XE/FTDv/FMCv, F5 BIG-IP) are
// general-purpose guests with a package manager to install it on, so this
// is expected to fail/timeout for most of them -- callers should treat
// that as "not available, fall back to manual entry", not a real error.
// `agent: 1` in the VM's own config (set unconditionally at deploy time,
// see lab-manager.js) is required for PVE to even attempt this call --
// without it PVE fails fast with "No QEMU guest agent configured".
async function getAgentInterfaces(vmid) {
  const data = await pve('GET', `/nodes/{node}/qemu/${vmid}/agent/network-get-interfaces`);
  return data.result || [];
}

// --- Host/storage status (stats bar + /api/public/stats) --------------------
// The node's own CPU/load/memory -- standard, long-stable PVE endpoint (not
// flagged as unverified like proxmox-templates.js's import-from flow).
async function getNodeStatus() {
  return pve('GET', '/nodes/{node}/status');
}

// Usage for one specific storage (e.g. the configured disk storage), not the
// node's rootfs -- `total`/`used`/`avail` in bytes. Preferred over rootfs for
// the stats bar/public API since it reflects the disk that labs' clones and
// templates actually consume, which may be a completely different physical
// drive than the node's own root filesystem.
async function getStorageStatus(storageId) {
  return pve('GET', `/nodes/{node}/storage/${storageId}/status`);
}

// full=0 -> linked clone (fast, copy-on-write against the template's disk,
// same idea as labber's old qcow2-overlay approach but handled entirely by
// PVE's own storage layer instead of hand-managed backing files).
async function cloneVm({ templateId, newId, name, full = false, targetStorage }) {
  const upid = await pve('POST', `/nodes/{node}/qemu/${templateId}/clone`, {
    newid: newId,
    name,
    full: full ? 1 : 0,
    ...(targetStorage ? { storage: targetStorage } : {}),
  });
  await waitForTask(upid);
  return newId;
}

// params example: { net0: 'virtio,bridge=vmbrX,firewall=0' }
async function setVmConfig(vmid, params) {
  return pve('PUT', `/nodes/{node}/qemu/${vmid}/config`, params);
}

// Proxmox leaves a VM's non-disk hardware config (cores, memory, cpu, ...)
// freely editable even after `qm template` -- only the disk itself becomes
// a read-only base for linked clones. Backs the Settings page's "edit hw"
// action for an already-built golden template.
async function getVmConfig(vmid) {
  return pve('GET', `/nodes/{node}/qemu/${vmid}/config`);
}

async function startVm(vmid) {
  const upid = await pve('POST', `/nodes/{node}/qemu/${vmid}/status/start`);
  return waitForTask(upid);
}

async function stopVm(vmid, { graceful = true } = {}) {
  const upid = await pve('POST', `/nodes/{node}/qemu/${vmid}/status/${graceful ? 'shutdown' : 'stop'}`);
  return waitForTask(upid);
}

async function deleteVm(vmid) {
  const upid = await pve('DELETE', `/nodes/{node}/qemu/${vmid}`, { purge: 1 });
  return waitForTask(upid);
}

module.exports = {
  listVms,
  listContainers,
  getVmStatus,
  getAgentInterfaces,
  getNodeStatus,
  getStorageStatus,
  cloneVm,
  setVmConfig,
  getVmConfig,
  startVm,
  stopVm,
  deleteVm,
};
