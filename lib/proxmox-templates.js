const { pve, pveUpload, currentConfig } = require('./proxmox-request');
const { maybeWaitForTask, maybeWaitForTaskWithLog } = require('./proxmox-tasks');
const { listVms, listContainers } = require('./proxmox-vm');

// --- Template building (upload qcow2 -> golden template) --------------------
// Not PVE's /cluster/nextid: that returns the lowest free ID overall, which
// lands right next to however a node's manually-built VMs are numbered (the
// first real build here picked 101, next to the node's own 100).
//
// Lowest free VMID within [start, end] (config-store's templateVmidStart/
// End) -- template-builder's actual default auto-pick, deliberately its own
// configurable range distinct from both lab-manager's ephemeral 9000-9999
// lab-clone range and wherever manually-built VMs already live, so golden
// templates don't end up interleaved with either. A per-build exact-VMID
// override bypasses this entirely (see template-builder.js).
// `exclude`: ids another in-progress build has already picked but not yet created.
async function findFreeVmidInRange(start, end, exclude = new Set()) {
  // PVE's VMID namespace is shared between QEMU VMs and LXC containers --
  // listVms() alone missed containers, so a "free" pick here could collide
  // with an existing CT ("unable to create VM <n> -- CT <n> already
  // exists"). See lib/proxmox-vm.js's listContainers() for the full story.
  const [vms, cts] = await Promise.all([listVms(), listContainers()]);
  const taken = new Set([...vms, ...cts].map((v) => v.vmid).concat([...exclude]));
  for (let n = start; n <= end; n++) {
    if (!taken.has(n)) return n;
  }
  throw new Error(`No free VMIDs available in range ${start}-${end} -- widen the range in Settings`);
}

// Cluster-wide storage config (includes `path` for dir-type storages) --
// distinct from /nodes/{node}/storage, which reports per-node status/usage
// for the same storage IDs. This is what backs the Settings page's "pick an
// existing storage" dropdown and the "create a new one under it" flow.
async function listStorages() {
  return pve('GET', '/storage');
}

// Directory storage scoped to just this app's node (`nodes`), not shared
// cluster-wide -- matches the "carve a subfolder out of an existing mounted
// storage" use case (e.g. Storage:/mnt/pve/Storage -> Labber:/mnt/pve/Storage/labber).
// `create-base-path: 1` tells PVE to mkdir the path if it doesn't exist yet
// rather than requiring it to be pre-created by hand.
async function createDirStorage({ id, path, content = 'images,import,iso' }) {
  const c = currentConfig();
  return pve('POST', '/storage', {
    storage: id,
    type: 'dir',
    path,
    content,
    nodes: c.node,
    shared: 0,
    'create-base-path': 1,
  });
}

// Shared by uploadImportFile() and uploadIsoFile() below -- only the
// storage `content` type (and therefore the resulting volid's directory)
// differs between staging a qcow2/raw disk image (content=import) and an
// install ISO (content=iso, a natively-supported upload type unlike
// import, but the upload mechanics/progress-tracking are identical).
//
// Two distinct progress signals here, both optional: onProgress tracks the
// HTTP body actually leaving this app towards Proxmox (the browser->app leg
// is already done by the time this runs -- multer already has the whole
// file on local disk); onLogLine streams PVE's own task log for the
// server-side copy into its storage directory once the upload lands (what
// the Proxmox GUI's Task Viewer shows for this same operation).
async function uploadToStorage(storageId, filePath, filename, contentType, { onProgress, onLogLine } = {}) {
  const data = await pveUpload(`/nodes/{node}/storage/${storageId}/upload`, {
    filePath,
    filename,
    fields: { content: contentType },
    onProgress,
  });
  await maybeWaitForTaskWithLog(data, onLogLine);
  return `${storageId}:${contentType}/${filename}`;
}

// Stages an uploaded qcow2/raw image on a directory storage's
// template/import/ area so it can subsequently be referenced as
// `import-from=<storage>:import/<filename>` on a disk -- this is what lets
// Proxmox itself do the format conversion, rather than this app needing
// qemu-img or any host filesystem access.
async function uploadImportFile(storageId, filePath, filename, opts) {
  return uploadToStorage(storageId, filePath, filename, 'import', opts);
}

// Stages an install ISO on a directory storage's iso/ area so it can be
// attached as a CD-ROM (`ide2=<storage>:iso/<filename>,media=cdrom`) --
// backs buildFromIso() in template-builder.js for kinds without a
// ready-to-boot qcow2.
async function uploadIsoFile(storageId, filePath, filename, opts) {
  return uploadToStorage(storageId, filePath, filename, 'iso', opts);
}

// `qm create` equivalent. Disk is deliberately *not* passed here -- it's
// attached as a separate importDisk() config call afterward since import-from
// is itself an async task that needs its own waitForTask, and bundling it
// into the initial create call would make failures harder to attribute.
async function createVm(vmid, params) {
  const data = await pve('POST', '/nodes/{node}/qemu', { vmid, ...params });
  return maybeWaitForTask(data);
}

// bus example: "virtio0" or "scsi0". `import-from` triggers PVE's own
// qcow2/raw -> target-format conversion during the copy -- same mechanism
// the "Import" storage wizard in the web UI uses. onLogLine (optional)
// streams this task's own worker log the same way uploadImportFile() does.
async function importDisk(vmid, { bus, targetStorage, importVolid }, onLogLine) {
  const data = await pve('PUT', `/nodes/{node}/qemu/${vmid}/config`, {
    [bus]: `${targetStorage}:0,import-from=${importVolid}`,
  });
  return maybeWaitForTaskWithLog(data, onLogLine);
}

async function setBootOrder(vmid, bus) {
  return pve('PUT', `/nodes/{node}/qemu/${vmid}/config`, { boot: `order=${bus}` });
}

// Removes an uploaded file (an import/ disk image or an iso/ file) from a
// storage. `volid` is the full id, e.g. "ssd:import/tpl-9100-bigip.qcow2".
async function deleteVolume(storageId, volid) {
  const data = await pve('DELETE', `/nodes/{node}/storage/${storageId}/content/${encodeURIComponent(volid)}`);
  return maybeWaitForTask(data);
}

// An installed-from-ISO VM about to become a template: take the installer ISO
// out of its CD-ROM and boot from its disk only, so clones never reference
// (or depend on) the ISO file.
async function ejectIsoAndBootFromDisk(vmid, diskBus) {
  return pve('PUT', `/nodes/{node}/qemu/${vmid}/config`, { ide2: 'none,media=cdrom', boot: `order=${diskBus}` });
}

// `qm template` equivalent -- irreversible on PVE (converts the VM's disk to
// a read-only base + marks it a template); only call this once importDisk()
// has fully succeeded.
async function convertToTemplate(vmid) {
  const data = await pve('POST', `/nodes/{node}/qemu/${vmid}/template`);
  return maybeWaitForTask(data);
}

module.exports = {
  findFreeVmidInRange,
  listStorages,
  createDirStorage,
  uploadImportFile,
  uploadIsoFile,
  createVm,
  importDisk,
  setBootOrder,
  convertToTemplate,
  deleteVolume,
  ejectIsoAndBootFromDisk,
};
