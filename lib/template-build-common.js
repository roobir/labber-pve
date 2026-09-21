const pve = require('./proxmox-client');
const configStore = require('./config-store');
const { toDnsSafeName } = require('./dns-safe-name');

// Shared by both build paths (template-build-qcow2.js / template-build-iso.js).
async function resolveVmidAndName({ kind, requestedVmid, name }) {
  let vmid;
  if (requestedVmid) {
    vmid = parseInt(requestedVmid, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      throw new Error(`Invalid VMID: "${requestedVmid}"`);
    }
  } else {
    const { templateVmidStart, templateVmidEnd } = configStore.get();
    vmid = await pve.findFreeVmidInRange(templateVmidStart, templateVmidEnd);
  }
  return { vmid, vmName: toDnsSafeName(name || `labber-tpl-${kind}-${vmid}`) };
}

function baseVmParams(vmName, hw, diskStorage) {
  const nics = {};
  for (let i = 0; i < hw.nics; i++) {
    // placeholder bridge; rewired per-link by lab-deploy.js's deploy() on
    // actual lab deployment
    nics[`net${i}`] = `${hw.nicModel || 'virtio'},bridge=vmbr0,firewall=0`;
  }
  return {
    name: vmName,
    cores: hw.cores,
    memory: hw.memory,
    cpu: hw.cpu,
    bios: hw.bios,
    ostype: hw.ostype,
    ...(hw.scsihw ? { scsihw: hw.scsihw } : {}), // e.g. n9kv's sata0 bus needs no controller type
    ...(hw.machine ? { machine: hw.machine } : {}),
    ...(hw.serial0 ? { serial0: 'socket' } : {}),
    // UEFI kinds (bios: ovmf -- n9kv, c8000v) need a real efidisk0 or every
    // clone boots with Proxmox's TASK WARNING "no efidisk configured! Using
    // temporary efivars disk." -- harmless for a guest that never writes
    // NVRAM, but not guaranteed for every UEFI image, and pure noise
    // otherwise. efitype=4m is the standard modern OVMF vars size;
    // pre-enrolled-keys=0 skips Microsoft's Secure Boot keys, irrelevant
    // for these vendor appliances.
    ...(hw.bios === 'ovmf' ? { efidisk0: `${diskStorage}:1,efitype=4m,pre-enrolled-keys=0` } : {}),
    ...nics,
  };
}

module.exports = { resolveVmidAndName, baseVmParams };
