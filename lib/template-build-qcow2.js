const fs = require('fs');
const path = require('path');
const pve = require('./proxmox-client');
const configStore = require('./config-store');
const { resolveVmidAndName, baseVmParams } = require('./template-build-common');

// A ready-to-boot qcow2/raw disk image, attached via import-from (PVE does
// the format conversion itself) and templated immediately -- the normal
// case for every vendor kind except the ISO-installer-based ones (see
// template-build-iso.js). emit() reports both a human-readable line (for
// the scrolling log) and a { phase, progress } pair (for an actual progress
// bar) -- progress is a 0-100 number where it's measurable (the upload leg)
// or null for "something's happening, no percentage available". line is
// optional so progress-only ticks (upload byte counters) don't spam the log.
async function buildFromQcow2({ kind, filePath, originalFilename, name, requestedVmid, versionLabel }, emit, profile) {
  const hw = profile.hw;
  const diskStorage = configStore.get().diskStorage;
  if (!diskStorage) throw new Error('No disk storage configured -- set one on the Settings page first');

  const { vmid, vmName } = await resolveVmidAndName({ kind, requestedVmid, name });
  // PVE's own upload endpoint (content=import) validates the filename
  // extension against its own whitelist -- .raw/.qcow2/.vmdk/etc -- before
  // any format conversion happens, and rejects unrecognized ones (like the
  // .img extension SONiC and some other vendors ship raw disk images with)
  // with a 400 "invalid filename or wrong extension", even though .img is
  // the same raw binary format as .raw. Normalize just that one extension
  // so the upload reaches PVE's import-from conversion at all.
  const safeBase = path.basename(originalFilename)
    .replace(/\.img$/i, '.raw')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadFilename = `tpl-${vmid}-${safeBase}`;
  const { size: fileSize } = fs.statSync(filePath);

  try {
    emit(`uploading ${originalFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB) to storage "${diskStorage}"...`, 'uploading', 0);
    let lastPct = -1;
    const importVolid = await pve.uploadImportFile(diskStorage, filePath, uploadFilename, {
      onProgress: (sent, total) => {
        const pct = total ? Math.round((sent / total) * 100) : null;
        if (pct !== lastPct) {
          lastPct = pct;
          emit(null, 'uploading', pct);
        }
      },
      // PVE's own server-side copy into its import/ directory, once the
      // upload itself lands -- same task/log the Proxmox GUI's Task Viewer
      // shows ("starting file import from...", "command: cp ...", "TASK OK").
      onLogLine: (line) => emit(`  [proxmox] ${line}`, 'uploading', 100),
    });
    emit(`  -> staged as ${importVolid}`, 'uploading', 100);

    emit(`creating VM ${vmid} (${vmName})...`, 'creating-vm', null);
    await pve.createVm(vmid, baseVmParams(vmName, hw, diskStorage));

    emit(`importing disk into ${vmid}:${hw.diskBus} (storage "${diskStorage}")...`, 'importing-disk', null);
    await pve.importDisk(
      vmid,
      { bus: hw.diskBus, targetStorage: diskStorage, importVolid },
      (line) => emit(`  [proxmox] ${line}`, 'importing-disk', null)
    );

    emit('setting boot order...', 'setting-boot-order', null);
    await pve.setBootOrder(vmid, hw.diskBus);

    emit(`converting ${vmid} to a Proxmox template...`, 'converting-to-template', null);
    await pve.convertToTemplate(vmid);

    configStore.saveTemplateVersion(kind, versionLabel, vmid);
    emit(`done -- vmid ${vmid} saved as "${kind}" version "${versionLabel}"`, 'done', 100);
    return { vmid, status: 'done' };
  } catch (err) {
    emit(`ERROR: ${err.message}`, 'error', null);
    err.vmid = vmid;
    throw err;
  }
}

module.exports = { buildFromQcow2 };
