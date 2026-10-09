const express = require('express');
const reservations = require('../lib/reservations');

// Lab reservations are notices, not locks -- any logged-in user may reserve,
// take over or release any lab. See lib/reservations.js.
function buildReservationsRoutes({ requireAuth }) {
  const router = express.Router();

  router.post('/api/labs/:name/reservation', requireAuth, (req, res) => {
    try {
      const { hours, note } = req.body || {};
      res.json(reservations.reserve(req.params.name, req.session.username, hours, note));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/labs/:name/reservation', requireAuth, (req, res) => {
    const released = reservations.release(req.params.name);
    if (released && released.by !== req.session.username) {
      console.log(`reservation of ${req.params.name} by ${released.by} released by ${req.session.username}`);
    }
    res.json({ ok: true, released });
  });

  return router;
}

module.exports = { buildReservationsRoutes };
