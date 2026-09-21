const fs = require('fs');
const path = require('path');
const pve = require('./proxmox-client');
const configStore = require('./config-store');
const { resolveVmidAndName, baseVmParams } = require('./template-build-common');

// An install ISO (Check Point Gaia, or a generic Linux ISO install) -- there's
// no disk to import, so this creates a blank disk + mounts the ISO as a
// CD-ROM + boots it, then stops at "awaiting-install" instead of
// auto-templating, since completing the interactive installer over console
// is a real manual step no upload alone can skip. A separate
// finalizeTemplate() call (POST /api/templates/finalize) converts it once
// that's done.
async function buildFromIso({ kind, filePath, originalFilename, name, requestedVmid, diskSizeGB }, emit, profile) {
  const hw = profile.hw;
  const diskStorage = configStore.get().diskStorage;
  if (!diskStorage) throw new Error('No disk storage configured -- set one on the Settings page first');

  const { vmid, vmName } = await resolveVmidAndName({ kind, requestedVmid, name });
  const safeBase = path.basename(originalFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadFilename = `tpl-${vmid}-${safeBase}`;
  const size = Number.isInteger(diskSizeGB) && diskSizeGB > 0 ? diskSizeGB : profile.defaultDiskSizeGB || 65;
  const { size: fileSize } = fs.statSync(filePath);

  try {
    emit(`uploading ${originalFilename} (${(fileSize / 1024 / 1024).toFixed(1)} MB) to storage "${diskStorage}" (ISO)...`, 'uploading', 0);
    let lastPct = -1;
    const isoVolid = await pve.uploadIsoFile(diskStorage, filePath, uploadFilename, {
      onProgress: (sent, total) => {
        const pct = total ? Math.round((sent / total) * 100) : null;
        if (pct !== lastPct) {
          lastPct = pct;
          emit(null, 'uploading', pct);
        }
      },
      onLogLine: (line) => emit(`  [proxmox] ${line}`, 'uploading', 100),
    });
    emit(`  -> staged as ${isoVolid}`, 'uploading', 100);

    emit(`creating VM ${vmid} (${vmName}) with a blank ${size}GB disk...`, 'creating-vm', null);
    await pve.createVm(vmid, {
      ...baseVmParams(vmName, hw, diskStorage),
      [hw.diskBus]: `${diskStorage}:${size}`,
      ide2: `${isoVolid},media=cdrom`,
    });

    emit('setting boot order (disk, then CD-ROM)...', 'setting-boot-order', null);
    await pve.setBootOrder(vmid, `${hw.diskBus};ide2;net0`);

    emit(`starting ${vmid} so the installer can run over console...`, 'starting', null);
    await pve.startVm(vmid);

    emit(
      `VM ${vmid} is running with the installer ISO mounted -- open its console, complete the install, ` +
        `shut the VM down, then click "finalize as template".`,
      'awaiting-install',
      100
    );
    return { vmid, status: 'awaiting-install' };
  } catch (err) {
    emit(`ERROR: ${err.message}`, 'error', null);
    err.vmid = vmid;
    throw err;
  }
}

module.exports = { buildFromIso };
