const fs = require('fs');
const crypto = require('crypto');

const pve = require('./proxmox-client');
const vendors = require('./vendor-profiles');
const configStore = require('./config-store');
const { buildFromQcow2 } = require('./template-build-qcow2');
const { buildFromIso } = require('./template-build-iso');

// Two ways an uploaded file becomes a golden template, entirely through the
// API (no host filesystem/SSH access, matching this app's "plain HTTPS API
// client" design -- see README): buildFromQcow2() (the normal case) or
// buildFromIso() (Check Point Gaia, generic Linux ISO installs) -- see
// those two files for the actual build steps. This file just dispatches
// between them and tracks the resulting background job.
async function buildTemplate({ kind, filePath, originalFilename, name, vmid: requestedVmid, diskSizeGB, versionLabel }, onEvent = () => {}) {
  const emit = (line, phase, progress) => onEvent({ line, phase, progress });
  const profile = vendors.getProfile(kind);
  if (!profile) throw new Error(`Unknown device kind: ${kind}`);

  if (profile.installFromIso) {
    return buildFromIso({ kind, filePath, originalFilename, name, requestedVmid, diskSizeGB, versionLabel }, emit, profile);
  }
  return buildFromQcow2({ kind, filePath, originalFilename, name, requestedVmid, versionLabel }, emit, profile);
}

// Converts an "awaiting-install" VM (see buildFromIso) into a real template
// once the user has finished the interactive installer and shut it down --
// Proxmox's own `qm template` requires the VM to be stopped, so a failure
// here most likely just means it's still running. versionLabel is whatever
// the original /api/templates/build request specified -- the frontend
// carries it across to this separate, later finalize call the same way it
// already does for kind (see public/js/templates.js's currentKind).
async function finalizeTemplate(vmid, kind, versionLabel) {
  await pve.convertToTemplate(vmid);
  configStore.saveTemplateVersion(kind, versionLabel, vmid);
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

function startBuildJob({ kind, filePath, originalFilename, name, vmid, diskSizeGB, versionLabel }) {
  const id = crypto.randomUUID();
  const job = { id, status: 'running', log: [], vmid: null, error: null, phase: 'uploading', progress: 0 };
  jobs.set(id, job);

  const onEvent = ({ line, phase, progress }) => {
    if (line) job.log.push(line);
    job.phase = phase;
    job.progress = progress;
  };

  buildTemplate({ kind, filePath, originalFilename, name, vmid, diskSizeGB, versionLabel }, onEvent)
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
      fs.rm(filePath, { force: true }, () => {});
    });

  return id;
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { buildTemplate, finalizeTemplate, startBuildJob, getJob };
