const fs = require('fs');
const path = require('path');
const pve = require('./proxmox-client');
const vendors = require('./vendor-profiles');
const configStore = require('./config-store');

// Checked BEFORE the browser starts uploading a template image. Everything
// here used to surface only after the whole file (often several GB) had been
// uploaded to labber-pve -- or after a second full upload to Proxmox. Errors
// stop the upload; warnings are shown and the upload goes ahead.
//
// -> { errors: [...], warnings: [...], conflict: bool }
const IMPORT_EXT = /\.(qcow2|raw|img|vmdk)$/i;
const GB = 1024 ** 3;
const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

async function preflight({ kind, versionLabel, replaceExisting, vmid, fileName, fileSize, diskSizeGB, uploadDir }) {
  const errors = [];
  const warnings = [];
  let conflict = false;

  const profile = vendors.getProfile(kind);
  if (!profile) return { errors: [`unknown device kind "${kind}"`], warnings, conflict };
  const label = String(versionLabel || '').trim();
  if (!label) errors.push('a version label is required');
  else if (vendors.getProfile(kind, label)?.templateId && replaceExisting !== true) {
    conflict = true;
    errors.push(`version "${label}" already exists for this kind -- tick "replace existing version" to overwrite`);
  }

  // The device kind decides how the file is used, so the file must suit it.
  const name = String(fileName || '');
  const size = Number(fileSize) || 0;
  if (profile.installFromIso && !/\.iso$/i.test(name)) errors.push(`${profile.label || kind} templates are built from an install ISO -- choose a .iso file`);
  if (!profile.installFromIso && !IMPORT_EXT.test(name)) errors.push('choose a disk image (.qcow2, .raw, .img or .vmdk) -- this kind is not installed from an ISO');

  // Room to stage the upload on labber-pve's own volume first.
  try {
    const st = fs.statfsSync(uploadDir);
    const free = st.bavail * st.bsize;
    if (size && free < size) errors.push(`labber-pve's data volume has ${gb(free)} free, the file is ${gb(size)}`);
  } catch (err) {
    // statfs unsupported here -- not worth blocking on
  }

  const storage = configStore.get().diskStorage;
  if (!storage) {
    errors.push('no disk storage configured -- set one in Settings first');
  } else {
    await checkProxmox({ profile, storage, size, diskSizeGB, vmid, errors, warnings });
  }
  return { errors, warnings, conflict };
}

async function checkProxmox({ profile, storage, size, diskSizeGB, vmid, errors, warnings }) {
  let storages;
  try {
    storages = await pve.listStorages();
  } catch (err) {
    errors.push(`can't reach Proxmox: ${err.message}`);
    return;
  }
  const cfg = storages.find((s) => s.storage === storage);
  if (!cfg) {
    errors.push(`disk storage "${storage}" no longer exists in Proxmox -- pick another in Settings`);
    return;
  }
  const needs = profile.installFromIso ? 'iso' : 'import';
  if (!String(cfg.content || '').split(',').includes(needs)) {
    errors.push(`storage "${storage}" does not accept "${needs}" content -- enable it under Datacenter -> Storage -> ${storage} -> Content`);
  }
  try {
    const st = await pve.getStorageStatus(storage);
    // A disk image is staged, then copied into the template's own disk (which
    // can be larger than the compressed file); an ISO install adds a blank disk.
    const extra = profile.installFromIso ? (Number(diskSizeGB) || profile.defaultDiskSizeGB || 65) * GB : size;
    if (size && st.avail < size) errors.push(`storage "${storage}" has ${gb(st.avail)} free, the file is ${gb(size)}`);
    else if (size && st.avail < size + extra) warnings.push(`storage "${storage}" has ${gb(st.avail)} free -- the build may need about ${gb(size + extra)}`);
  } catch (err) {
    warnings.push(`couldn't read free space on "${storage}": ${err.message}`);
  }
  if (vmid) {
    const id = parseInt(vmid, 10);
    if (!Number.isInteger(id) || id < 100) {
      errors.push(`VMID "${vmid}" is not valid (whole number, 100 or more)`);
    } else {
      const [vms, cts] = await Promise.all([pve.listVms(), pve.listContainers()]);
      if ([...vms, ...cts].some((v) => Number(v.vmid) === id)) errors.push(`VMID ${id} is already in use in Proxmox`);
    }
  }
}

// Staged uploads belong to in-memory jobs, so after a restart nothing will
// ever use (or delete) what is left in the upload folder.
function sweepStaleUploads(uploadDir) {
  let removed = 0;
  for (const f of fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []) {
    fs.rmSync(path.join(uploadDir, f), { force: true, recursive: true });
    removed++;
  }
  if (removed) console.log(`templates: removed ${removed} stale staged upload(s) from ${uploadDir}`);
}

module.exports = { preflight, sweepStaleUploads };
