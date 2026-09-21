const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const vendors = require('../lib/vendor-profiles');
const templateBuilder = require('../lib/template-builder');
const { throttledDiskStorage } = require('../lib/upload-throttle');

// Builds a golden template from an uploaded qcow2/iso. Uploaded files land
// transiently under labsDir/.tmp/uploads (disk storage, not memory -- these
// can be multi-GB) before template-builder.js streams them on to Proxmox
// and deletes the local copy. Same volume as LABS_DIR so it works
// unmodified in the k8s/OpenShift deployment (single PVC, no second mount
// needed).
function buildTemplatesRoutes({ requireAuth, labsDir }) {
  const uploadDir = path.join(labsDir, '.tmp', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: throttledDiskStorage({ uploadDir }),
    limits: { fileSize: 32 * 1024 * 1024 * 1024 }, // 32GB guard rail, not an expected real size
  });

  const router = express.Router();

  // Upload itself is a normal blocking multipart POST (multer streams
  // straight to uploadDir, not memory), but the actual Proxmox-side work --
  // restream to storage, create VM, import disk (or attach as CD-ROM for an
  // ISO-based kind), template it -- runs as a background job since it can
  // take minutes; the response here is just the jobId, and the frontend
  // polls /api/templates/build/:jobId the same way dashboard.js already
  // polls /api/status. Field name stayed "qcow2" for both file types rather
  // than renaming the route/multer config just for ISOs.
  router.post('/api/templates/build', requireAuth, upload.single('qcow2'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "qcow2")' });
    const cleanup = () => fs.rm(req.file.path, { force: true }, () => {});
    const { kind, name, vmid, diskSizeGB, replaceExisting } = req.body || {};
    const versionLabel = (req.body?.versionLabel || '').trim();
    if (!kind) {
      cleanup();
      return res.status(400).json({ error: 'kind is required' });
    }
    if (!versionLabel) {
      cleanup();
      return res.status(400).json({ error: 'a version label is required' });
    }
    // Checked up front, before a possibly multi-GB/multi-minute build ever
    // starts -- finding out a label collided only at the final save step
    // (after the whole upload + import + template conversion already ran)
    // would waste exactly the kind of time this app is trying to save.
    const existingVmid = vendors.getProfile(kind, versionLabel)?.templateId;
    if (existingVmid && replaceExisting !== 'true') {
      cleanup();
      return res.status(409).json({
        error: `version "${versionLabel}" already exists for this kind (vmid ${existingVmid}) -- check "replace existing version" to overwrite`,
        conflict: true,
      });
    }
    try {
      const jobId = templateBuilder.startBuildJob({
        kind,
        filePath: req.file.path,
        originalFilename: req.file.originalname,
        name,
        vmid: vmid || undefined, // blank string from the form -> auto-pick, not "invalid VMID """
        diskSizeGB: diskSizeGB ? parseInt(diskSizeGB, 10) : undefined,
        versionLabel,
      });
      res.json({ jobId });
    } catch (err) {
      cleanup();
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/templates/build/:jobId', requireAuth, (req, res) => {
    const job = templateBuilder.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Unknown job' });
    res.json(job);
  });

  // Converts an "awaiting-install" VM (see template-builder.js's
  // buildFromIso) into a real template once the interactive installer is
  // done and the VM is shut down -- only reachable this way, no
  // auto-finalize, since there's no way to know the install actually
  // finished otherwise.
  router.post('/api/templates/finalize', requireAuth, async (req, res) => {
    const vmid = parseInt(req.body?.vmid, 10);
    const kind = req.body?.kind;
    const versionLabel = (req.body?.versionLabel || '').trim();
    if (!Number.isInteger(vmid) || vmid <= 0) return res.status(400).json({ error: 'invalid vmid' });
    if (!vendors.getProfile(kind)) return res.status(400).json({ error: 'unknown device kind' });
    if (!versionLabel) return res.status(400).json({ error: 'a version label is required' });
    try {
      await templateBuilder.finalizeTemplate(vmid, kind, versionLabel);
      res.json({ ok: true, vmid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildTemplatesRoutes };
