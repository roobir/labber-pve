const express = require('express');
const userStore = require('../lib/user-store');

// Dashboard login accounts -- see lib/user-store.js for the persisted
// JSON-file store this sits on top of. Deliberately flat (no roles): same
// "single trusted homelab" posture as the rest of this app's auth, just
// multiple people/devices able to log in under their own name instead of
// one shared admin credential.
function buildUsersRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/users', requireAuth, (req, res) => {
    res.json(userStore.list());
  });

  router.post('/api/users', requireAuth, async (req, res) => {
    const { username, password } = req.body || {};
    try {
      const user = await userStore.addUser(username, password);
      res.json({ ok: true, ...user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Blocked separately from user-store.js's own "last user standing" guard
  // -- this one is session-aware (knows who's asking), which user-store.js
  // itself has no access to.
  router.delete('/api/users/:username', requireAuth, (req, res) => {
    if (req.params.username === req.session.username) {
      return res.status(400).json({ error: "Can't remove the account you're currently logged in as" });
    }
    try {
      userStore.removeUser(req.params.username);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildUsersRoutes };
