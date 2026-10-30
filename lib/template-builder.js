const fs = require('fs');
const crypto = require('crypto');

const pve = require('./proxmox-client');
const vendors = require('./vendor-profiles');
const configStore = require('./config-store');
const { buildFromQcow2 } = require('./template-build-qcow2');
const { buildFromIso } = require('./template-build-iso');
const { releaseVmid } = require('./template-build-common');

// Two ways an uploaded file becomes a golden template, entirely through the
// API (no host filesystem/SSH access, matching this app's "plain HTTPS API
// client" design -- see README): buildFromQcow2() (the normal case) or
// buildFromIso() (Check Point Gaia, generic Linux ISO installs) -- see
// those two files for the actual build steps. This file just dispatches
// between them and tracks the resulting background job.
//
// hwOverride ({ cores, memory }, either optional) sizes this one template
// version -- only for kinds whose profile allows it (customHw), checked by
// routes/templates.js. A new build starts from the kind's static profile, not
// from whatever size the current default version happens to have.
async function buildTemplate({ kind, filePath, originalFilename, name, vmid: requestedVmid, diskSizeGB, versionLabel, hwOverride = {} }, onEvent = () => {}) {
  const emit = (line, phase, progress) => onEvent({ line, phase, progress });
  const base = vendors.STATIC_PROFILES[kind];
  if (!base) throw new Error(`Unknown device kind: ${kind}`);
  const profile = { ...base, hw: { ...base.hw, ...hwOverride } };

  if (profile.installFromIso) {
    return buildFromIso({ kind, filePath, originalFilename, name, requestedVmid, diskSizeGB, versionLabel, hwOverride }, emit, profile);
  }
  return buildFromQcow2({ kind, filePath, originalFilename, name, requestedVmid, versionLabel, hwOverride }, emit, profile);
}

// Converts an "awaiting-install" VM (see buildFromIso) into a real template
// once the user has finished the interactive installer and shut it down --
// Proxmox's own `qm template` requires the VM to be stopped, so a failure
// here most likely just means it's still running. versionLabel is whatever
// the original /api/templates/build request specified -- the frontend
// carries it across to this separate, later finalize call the same way it
// already does for kind (see public/js/templates.js's currentKind).
async function finalizeTemplate(vmid, kind, versionLabel) {
  // Nothing may change while the installer could still be running: ejecting
  // the ISO from a live install would break it. Templating needs it stopped
  // anyway, so check first and leave the VM untouched otherwise.
  const { status } = await pve.getVmStatus(vmid);
  if (status !== 'stopped') {
    throw new Error(`VM ${vmid} is ${status} -- finish the install, shut the VM down, then finalize`);
  }
  // The installer ISO this app staged for this build (tpl-<vmid>-*.iso, see
  // buildFromIso) is dead weight once the template exists -- removed below.
  // An ISO the user attached by hand has another name and is left alone.
  const staged = stagedIsoVolid((await pve.getVmConfig(vmid)).ide2, vmid);
  const profile = vendors.getProfile(kind);
  if (profile) await pve.ejectIsoAndBootFromDisk(vmid, profile.hw.diskBus);
  await pve.convertToTemplate(vmid);
  configStore.saveTemplateVersion(kind, versionLabel, vmid);
  if (!staged) return {};
  try {
    await pve.deleteVolume(staged.split(':')[0], staged);
    return { removedIso: staged };
  } catch (err) {
    // The template is done either way -- only the clean-up didn't happen.
    return { isoWarning: `template saved, but the installer ISO ${staged} could not be removed (${err.message}) -- delete it from the storage in Proxmox` };
  }
}

// "ssd:iso/tpl-123-gaia.iso,media=cdrom,size=4G" -> "ssd:iso/tpl-123-gaia.iso"
// for this vmid's own staged upload, else null.
function stagedIsoVolid(ide2, vmid) {
  const volid = String(ide2 || '').split(',')[0];
  return new RegExp(`^[^:]+:iso/tpl-${vmid}-[^/]+$`).test(volid) ? volid : null;
}

// --- In-memory job tracking ---------------------------------------------------
// Uploads + imports can take minutes for multi-GB images, too long to hold a
// single HTTP request open behind a k8s ingress -- POST kicks the job off and
// returns a jobId immediately, the frontend polls status the same way
// dashboard.js already polls /api/status. Homelab-scale (a handful of builds,
// never concurrent from more than one browser tab), so an in-memory Map that
// resets on restart is plenty -- no need for the LABS_DIR state-file treatment
// lab-manager.js gives actual deployed lab state.
const jobs = new Map();
const JOB_KEEP_MS = 24 * 60 * 60 * 1000; // finished jobs are forgotten after a day

function pruneJobs() {
  const cutoff = Date.now() - JOB_KEEP_MS;
  for (const [id, job] of jobs) if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
}

function startBuildJob({ kind, filePath, originalFilename, name, vmid, diskSizeGB, versionLabel, hwOverride }) {
  pruneJobs();
  const id = crypto.randomUUID();
  const job = { id, status: 'running', log: [], vmid: null, error: null, phase: 'uploading', progress: 0 };
  jobs.set(id, job);

  const onEvent = ({ line, phase, progress }) => {
    if (line) job.log.push(line);
    job.phase = phase;
    job.progress = progress;
  };

  buildTemplate({ kind, filePath, originalFilename, name, vmid, diskSizeGB, versionLabel, hwOverride }, onEvent)
    .then((result) => {
      job.status = result.status; // 'done' or 'awaiting-install'
      job.vmid = result.vmid;
      job.progress = 100;
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.vmid = err.vmid || null;
    })
    .finally(() => {
      job.finishedAt = Date.now();
      if (job.vmid) releaseVmid(job.vmid); // created (or failed) by now: no longer needs reserving
      fs.rm(filePath, { force: true }, () => {});
    });

  return id;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { buildTemplate, finalizeTemplate, stagedIsoVolid, startBuildJob, getJob };
