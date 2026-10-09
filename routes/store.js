const express = require('express');
const store = require('../lib/runbooks/store');
const library = require('../lib/runbooks/library');

// The Store: named secrets / values / licenses that runbooks reference by
// name. Lists never include secret values; GET /:name is the explicit
// "reveal" (also what the edit form loads).
function buildStoreRoutes({ requireAuth }) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => {
    try {
      res.json(fn(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  router.get('/api/store', requireAuth, wrap(() => store.list()));
  router.get('/api/store/:name', requireAuth, wrap((req) => store.get(req.params.name)));
  router.get('/api/store/:name/usage', requireAuth, wrap((req) => library.referencesToStoreEntry(req.params.name)));
  router.put('/api/store/:name', requireAuth, wrap((req) => store.upsert(req.params.name, req.body || {}, req.session.username)));
  router.post('/api/store/:name/restore', requireAuth, wrap((req) =>
    store.restore(req.params.name, Number(req.body.index), req.session.username)));
  router.delete('/api/store/:name', requireAuth, wrap((req) => {
    store.remove(req.params.name);
    return { ok: true };
  }));

  return router;
}

module.exports = { buildStoreRoutes };
