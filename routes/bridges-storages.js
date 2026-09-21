const express = require('express');
const net = require('../lib/network-manager');
const proxmox = require('../lib/proxmox-client');

// Storage (list/carve out a directory storage) and bridge (list/create
// vmbrN interfaces) discovery -- both back the lab wizard's dropdowns and
// the Settings page's storage picker, and both are thin wrappers around
// proxmox-client.js/network-manager.js rather than app-level logic of their
// own.
function buildBridgesStoragesRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/storages', requireAuth, async (req, res) => {
    try {
      res.json(await proxmox.listStorages());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Carves a new directory storage out of an existing mounted path, e.g.
  // parent "Storage" at /mnt/pve/Storage + subfolder "labber" -> storage
  // "Labber" at /mnt/pve/Storage/labber. PVE creates the directory itself
  // (create-base-path) -- this app never touches the node's filesystem
  // directly, same "pure API client" constraint as everything else here.
  router.post('/api/storages', requireAuth, async (req, res) => {
    const { id, parentPath, subfolder } = req.body || {};
    if (!id || !parentPath || !subfolder) {
      return res.status(400).json({ error: 'id, parentPath, and subfolder are required' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9_-]+$/.test(subfolder)) {
      return res.status(400).json({ error: 'id and subfolder must be alphanumeric/underscore/hyphen only' });
    }
    try {
      // parentPath is meant to be one of the real paths from the "parent
      // storage" dropdown (populated from listStorages() itself) -- checked
      // against that same list rather than trusted as an arbitrary client-
      // supplied string, since Proxmox will mkdir whatever path this becomes
      // (create-base-path:1). Without this, a crafted request could point a
      // new storage (and therefore a real directory) at any path on the
      // node.
      const storages = await proxmox.listStorages();
      if (!storages.some((s) => s.path === parentPath)) {
        return res.status(400).json({ error: 'parentPath must match an existing storage\'s real path' });
      }
      const fullPath = `${parentPath.replace(/\/+$/, '')}/${subfolder}`;
      await proxmox.createDirStorage({ id, path: fullPath, content: 'images,import,iso' });
      res.json({ ok: true, id, path: fullPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Backs the lab wizard's "which bridge for this external link" picker --
  // lets a node with 9-10 already hand-built bridges (vmbr2/vmbr4/vmbr5/...)
  // be selected by name+comment instead of typed blind, plus a way to add a
  // new one from the same form if none of the existing ones fit.
  router.get('/api/bridges', requireAuth, async (req, res) => {
    try {
      res.json(await net.listBridges());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/bridges', requireAuth, async (req, res) => {
    const { iface, comments } = req.body || {};
    if (!/^vmbr\d+$/.test(iface || '')) {
      return res.status(400).json({ error: 'iface must look like vmbrN (e.g. vmbr8)' });
    }
    try {
      await net.createNamedBridge(iface, comments);
      res.json({ ok: true, iface });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildBridgesStoragesRoutes };
