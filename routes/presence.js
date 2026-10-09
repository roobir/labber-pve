const express = require('express');
const presence = require('../lib/presence');

// The page heartbeats here (~30s) and gets back who else is online.
function buildPresenceRoutes({ requireAuth }) {
  const router = express.Router();

  router.post('/api/presence', requireAuth, (req, res) => {
    presence.touch(req.session.username);
    res.json({ me: req.session.username, users: presence.list() });
  });

  return router;
}

module.exports = { buildPresenceRoutes };
