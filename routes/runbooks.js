const express = require('express');
const library = require('../lib/runbooks/library');
const runs = require('../lib/runbooks/runs');
const labDeps = require('../lib/runbooks/lab-deps');
const store = require('../lib/runbooks/store');

// Runbook library (drafts, versions, locking) and runs. Validation errors
// from the library carry a `details` list so the editor can show every
// problem at once.
function fail(res, err, status = 400) {
  res.status(err.status || status).json({ error: err.message, details: err.details, holder: err.holder });
}

function buildRunbooksRoutes({ requireAuth }) {
  const router = express.Router();
  const user = (req) => req.session.username;
  const wrap = (fn) => (req, res) => {
    try {
      res.json(fn(req));
    } catch (err) {
      fail(res, err);
    }
  };

  router.get('/api/runbooks', requireAuth, wrap(() => library.list()));
  router.get('/api/runbook-targets', requireAuth, wrap(() => labDeps.listTargets()));
  router.get('/api/runbook-store-options', requireAuth, wrap(() => store.list()));

  router.get('/api/runbooks/:name/:version', requireAuth, wrap((req) => {
    const d = library.get(req.params.name, req.params.version);
    return { name: d.name, version: d.version, text: d.text, meta: d.meta, integrity: d.integrity, definition: d.def };
  }));

  router.post('/api/runbooks', requireAuth, wrap((req) => library.create(req.body.name, req.body.text, user(req))));
  router.put('/api/runbooks/:name/:version', requireAuth, wrap((req) =>
    library.saveDraft(req.params.name, req.params.version, req.body.text, user(req))));
  router.post('/api/runbooks/:name/:version/new-version', requireAuth, wrap((req) =>
    library.newVersion(req.params.name, req.params.version, user(req))));
  router.post('/api/runbooks/:name/:version/copy', requireAuth, wrap((req) =>
    library.copyAs(req.params.name, req.params.version, req.body.newName, user(req))));
  router.post('/api/runbooks/:name/:version/lock', requireAuth, wrap((req) =>
    library.lock(req.params.name, req.params.version, user(req), req.body || {})));
  router.delete('/api/runbooks/:name/:version', requireAuth, wrap((req) => {
    library.removeDraft(req.params.name, req.params.version);
    return { ok: true };
  }));

  router.post('/api/runs', requireAuth, (req, res) => {
    try {
      const { name, version, inputs, force } = req.body || {};
      res.json(runs.start({ name, version, inputs, force: !!force, user: user(req) }));
    } catch (err) {
      fail(res, err);
    }
  });
  router.get('/api/runs', requireAuth, wrap(() => runs.listRecent()));
  router.get('/api/runs/:id', requireAuth, wrap((req) => runs.getRecord(req.params.id)));

  return router;
}

module.exports = { buildRunbooksRoutes };
