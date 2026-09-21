const express = require('express');
const configStore = require('../lib/config-store');
const proxmox = require('../lib/proxmox-client');

// View/edit an already-built golden template's non-disk hardware config.
// Proxmox leaves this editable even after `qm template` -- only the disk
// itself becomes a read-only base for linked clones. Scoped to vmids this
// app actually knows about (configStore's templates map) rather than an
// arbitrary-vmid editor, matching "adjust a golden template's hardware" as
// asked for rather than a general VM-config editor.
function isKnownTemplateVmid(vmid) {
  const config = configStore.get();
  if (Object.values(config.templates).some((v) => parseInt(v, 10) === vmid)) return true;
  // A version that isn't the current default (config-store's
  // templateVersions can hold several per kind now) is just as much a real,
  // built template as whatever `templates[kind]` currently points to -- it
  // should be hw-editable here too, not just the one currently "active".
  return Object.values(config.templateVersions).some((versions) =>
    Object.values(versions).some((v) => parseInt(v, 10) === vmid)
  );
}

function buildVmsRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/vms/:vmid/config', requireAuth, async (req, res) => {
    const vmid = parseInt(req.params.vmid, 10);
    if (!isKnownTemplateVmid(vmid)) return res.status(404).json({ error: 'Unknown template vmid' });
    try {
      const cfg = await proxmox.getVmConfig(vmid);
      res.json({
        vmid,
        name: cfg.name,
        cores: cfg.cores,
        memory: cfg.memory,
        cpu: cfg.cpu,
        bios: cfg.bios || 'seabios', // PVE omits this key entirely when it's the (seabios) default
        machine: cfg.machine || '',
        scsihw: cfg.scsihw,
        serial0: !!cfg.serial0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/vms/:vmid/config', requireAuth, async (req, res) => {
    const vmid = parseInt(req.params.vmid, 10);
    if (!isKnownTemplateVmid(vmid)) return res.status(404).json({ error: 'Unknown template vmid' });

    const cores = parseInt(req.body.cores, 10);
    const memory = parseInt(req.body.memory, 10);
    const cpu = String(req.body.cpu || '').trim();
    const bios = String(req.body.bios || '').trim();
    const machine = String(req.body.machine || '').trim();
    const scsihw = String(req.body.scsihw || '').trim();

    if (!Number.isInteger(cores) || cores <= 0) return res.status(400).json({ error: 'cores must be a positive integer' });
    if (!Number.isInteger(memory) || memory <= 0) return res.status(400).json({ error: 'memory (MB) must be a positive integer' });
    if (!cpu) return res.status(400).json({ error: 'cpu type is required' });
    if (bios !== 'seabios' && bios !== 'ovmf') return res.status(400).json({ error: 'bios must be seabios or ovmf' });
    if (!scsihw) return res.status(400).json({ error: 'scsihw is required' });

    // machine/serial0 are the two fields that can go from "set" to "absent"
    // -- Proxmox's config PUT needs those cleared via `delete`, not by
    // omitting them from the params (omitting just leaves the old value in
    // place). Deleting a key that isn't currently set is a harmless no-op,
    // so this doesn't need to check whether it was previously present
    // first.
    const toDelete = [];
    const params = { cores, memory, cpu, bios, scsihw };
    if (machine) params.machine = machine;
    else toDelete.push('machine');
    if (req.body.serial0) params.serial0 = 'socket';
    else toDelete.push('serial0');
    if (toDelete.length) params.delete = toDelete.join(',');

    try {
      await proxmox.setVmConfig(vmid, params);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildVmsRoutes };
