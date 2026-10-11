const express = require('express');
const catalog = require('../lib/template-catalog');

// The template editor's API (Settings -> Templates); see lib/template-catalog.js.
function buildTemplateCatalogRoutes({ requireAuth }) {
  const router = express.Router();

  // Every route answers with the whole catalog after an edit, so the page
  // simply re-renders from it.
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req);
      res.json(await catalog.catalog());
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, usedBy: err.usedBy || null });
    }
  };

  router.get('/api/template-catalog', requireAuth, handle(async () => {}));

  router.get('/api/template-catalog/:kind/check', requireAuth, async (req, res) => {
    try {
      res.json(await catalog.check(req.params.kind, req.query.vmid));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/api/template-catalog/:kind/versions', requireAuth, handle((req) => catalog.addVersion(req.params.kind, req.body || {})));
  router.post('/api/template-catalog/:kind/versions/:label/default', requireAuth, handle(async (req) => catalog.setDefault(req.params.kind, req.params.label)));
  router.post('/api/template-catalog/:kind/versions/:label/rename', requireAuth, handle(async (req) => catalog.renameVersion(req.params.kind, req.params.label, req.body || {})));
  router.delete('/api/template-catalog/:kind/versions/:label', requireAuth, handle(async (req) => catalog.removeVersion(req.params.kind, req.params.label, { force: req.query.force === '1' })));

  return router;
}

module.exports = { buildTemplateCatalogRoutes };
