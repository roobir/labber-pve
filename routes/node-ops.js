const express = require('express');
const labManager = require('../lib/lab-manager');
const proxmox = require('../lib/proxmox-client');
const nodeIdentity = require('../lib/node-identity');

// Per-node operational actions layered onto an already-deployed lab's
// state -- mgmt IP, identity (uuid/mac), and power control. Distinct from
// the topology-level lab CRUD in routes/labs.js and from deploy()/destroy()
// themselves (which act on the whole lab, over /ws/lab).
function buildNodeOpsRoutes({ requireAuth }) {
  const router = express.Router();

  // --- Mgmt IP: manual entry + best-effort guest-agent auto-detect --------
  router.get('/api/labs/:name/nodes/:node/detect-ip', requireAuth, async (req, res) => {
    try {
      const candidates = await labManager.detectNodeIp(req.params.name, req.params.node);
      if (candidates.length === 0) {
        return res.status(404).json({ error: 'No guest-agent IPs found -- agent may not be installed/running on this image, enter the IP manually' });
      }
      res.json({ ips: candidates });
    } catch (err) {
      res.status(502).json({ error: `Guest agent unavailable: ${err.message}` });
    }
  });

  router.post('/api/labs/:name/nodes/:node/mgmt-ip', requireAuth, (req, res) => {
    try {
      const result = labManager.setNodeMgmtIp(req.params.name, req.params.node, req.body?.ip, req.body?.port);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Identity: expose + anchor the SMBIOS UUID / NIC MAC(s) -------------
  // Several vendor licenses are keyed to one or both of these, and Proxmox
  // re-randomizes them on every clone by default (see lib/node-identity.js).
  // GET always reads live from Proxmox (never from stale local state) --
  // "pinned" here means "present in this node's .lab.yml entry", i.e. it'll
  // survive the next destroy+redeploy, not just true-right-now.
  router.get('/api/labs/:name/nodes/:node/identity', requireAuth, async (req, res) => {
    try {
      const vmid = labManager.getNodeVmid(req.params.name, req.params.node);
      const live = nodeIdentity.parseIdentity(await proxmox.getVmConfig(vmid));
      const topo = labManager.parseTopology(req.params.name);
      const pinnedNode = topo.nodes[req.params.node] || {};
      res.json({
        vmid,
        uuid: live.uuid,
        uuidPinned: !!pinnedNode.uuid,
        macs: live.macs,
        pinnedMacs: pinnedNode.mac || {},
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Two request shapes: `{ anchor: true }` captures whatever's currently
  // live on the real VM (pinned already or still Proxmox-assigned) and
  // writes it into the lab file verbatim -- the actual "keep the license
  // working across a rebuild" action. Explicit `{ uuid, mac }` instead
  // edits-and-applies: validated, pushed onto the live VM immediately (no
  // redeploy needed to see it take effect), and persisted into the lab file
  // the same way anchor is.
  router.post('/api/labs/:name/nodes/:node/identity', requireAuth, async (req, res) => {
    const { anchor, uuid, mac } = req.body || {};
    try {
      const vmid = labManager.getNodeVmid(req.params.name, req.params.node);
      let pinUuid = uuid;
      let pinMac = mac;

      if (anchor) {
        const live = nodeIdentity.parseIdentity(await proxmox.getVmConfig(vmid));
        pinUuid = live.uuid || undefined;
        pinMac = live.macs;
      } else {
        if (uuid !== undefined && !nodeIdentity.UUID_RE.test(uuid)) {
          return res.status(400).json({ error: 'uuid must look like a standard UUID (8-4-4-4-12 hex)' });
        }
        if (mac) {
          for (const [iface, m] of Object.entries(mac)) {
            if (!nodeIdentity.MAC_RE.test(m)) {
              return res.status(400).json({ error: `mac for "${iface}" must look like aa:bb:cc:dd:ee:ff` });
            }
          }
        }
        await nodeIdentity.applyIdentity(vmid, { uuid, macs: mac });
      }

      const pinned = labManager.setNodeIdentityPin(req.params.name, req.params.node, { uuid: pinUuid, mac: pinMac });
      res.json({ ok: true, pinned });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Power: start/shutdown an already-deployed node for maintenance -----
  // Distinct from deploy()/destroy() (which clone/wire/boot or tear down the
  // whole lab) -- this only starts or gracefully shuts down one node's
  // already-existing VM, e.g. to apply a config change or free host
  // resources without losing the lab's wiring/state. Graceful (ACPI
  // shutdown), unlike destroy()'s hard stop, since this isn't about to
  // delete the VM.
  router.post('/api/labs/:name/nodes/:node/power', requireAuth, async (req, res) => {
    const action = req.body?.action;
    if (action !== 'start' && action !== 'stop') {
      return res.status(400).json({ error: 'action must be "start" or "stop"' });
    }
    try {
      const vmid = labManager.getNodeVmid(req.params.name, req.params.node);
      if (action === 'start') await proxmox.startVm(vmid);
      else await proxmox.stopVm(vmid, { graceful: true });
      res.json({ ok: true, vmid, action });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildNodeOpsRoutes };
