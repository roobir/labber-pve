const express = require('express');
const apiTokens = require('../lib/api-tokens');

// Session-authed management of the bearer tokens that gate /api/relay/*
// (lib/api-relay.js) -- separate from routes/users.js's dashboard login
// accounts, same relationship as lib/api-tokens.js has to lib/user-store.js.
function buildApiTokensRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/relay-tokens', requireAuth, (req, res) => {
    res.json(apiTokens.list());
  });

  router.post('/api/relay-tokens', requireAuth, async (req, res) => {
    const { label, labScope } = req.body || {};
    try {
      const created = await apiTokens.create(label, labScope);
      res.json({ ok: true, ...created });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/relay-tokens/:id', requireAuth, (req, res) => {
    try {
      apiTokens.revoke(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildApiTokensRoutes };
