const express = require('express');
const yaml = require('js-yaml');
const labManager = require('../lib/lab-manager');
const vendors = require('../lib/vendor-profiles');

// Lab-file CRUD, aggregate status, and the vendor-kind list -- everything
// the dashboard's grid + the Labs modal's file list/editor need. Deploy/
// destroy themselves run over /ws/lab (see lib/lab-bridge.js), not REST --
// both take real time (cloning + booting real VMs) and the dashboard's UI is
// built around watching that happen live, same as containerlab's own
// deploy/destroy output in clab-dashboard.
function buildLabsRoutes({ requireAuth, getStats }) {
  const router = express.Router();

  router.get('/api/labs', requireAuth, (req, res) => {
    res.json(labManager.listLabs());
  });

  // Wizard entry point (see public/js/labs.js) -- structured JSON in, a new
  // *.lab.yml on disk out. Kept distinct from PUT /api/labs/:name (which
  // only ever edits a file already listed by listLabs()) so a wizard
  // mistake can't clobber a hand-written lab of the same name.
  router.post('/api/labs', requireAuth, (req, res) => {
    const { name, nodes, links } = req.body || {};
    try {
      const filename = labManager.createLab(name, { nodes, links });
      res.json({ ok: true, name: filename });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/labs/:name', requireAuth, (req, res) => {
    try {
      res.type('text/plain').send(labManager.readLab(req.params.name));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.put('/api/labs/:name', requireAuth, express.text({ type: '*/*' }), (req, res) => {
    try {
      labManager.validateTopology(yaml.load(req.body));
    } catch (err) {
      return res.status(400).json({ error: `Invalid lab YAML: ${err.message}` });
    }
    try {
      labManager.writeLab(req.params.name, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Deletes the .lab.yml file itself -- rejected (400) if the lab still has
  // deployed state, distinct from destroy() (which runs over /ws/lab and
  // tears down the actual VMs/bridges but leaves the file in place).
  router.delete('/api/labs/:name', requireAuth, (req, res) => {
    try {
      labManager.deleteLab(req.params.name);
      res.json({ ok: true });
    } catch (err) {
      const status = err.message.includes('still deployed') ? 400 : 404;
      res.status(status).json({ error: err.message });
    }
  });

  // Backs the dashboard's live view -- frontend polls this on an interval
  // rather than a push/event stream, simplest thing that works at homelab
  // scale (a handful of labs, not hundreds).
  router.get('/api/status', requireAuth, async (req, res) => {
    try {
      const labs = await labManager.getAllStatuses();
      const totalNodes = Object.values(labs).reduce(
        (sum, l) => sum + (l.deployed ? Object.keys(l.nodes).length : 0),
        0
      );
      const bootedNodes = Object.values(labs).reduce(
        (sum, l) => sum + (l.deployed ? Object.values(l.nodes).filter((n) => n.status === 'running').length : 0),
        0
      );
      res.json({ labs, totalNodes, bootedNodes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/vendors', requireAuth, (req, res) => {
    res.json(vendors.listKinds());
  });

  // Structured (already-validated) topology JSON for the topology graph
  // view -- reuses the exact same parseTopology() the PUT route above and
  // deploy() itself already rely on, so the client never needs its own
  // YAML parser just to draw a graph.
  router.get('/api/labs/:name/topology', requireAuth, (req, res) => {
    try {
      res.json(labManager.parseTopology(req.params.name));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Same combined snapshot as /api/public/stats (lib/public-routes.js),
  // just always available to a logged-in user regardless of that route's
  // enabled toggle -- backs the dashboard's own stats-bar CPU/mem/disk
  // tiles.
  router.get('/api/stats', requireAuth, async (req, res) => {
    try {
      res.json(await getStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildLabsRoutes };
