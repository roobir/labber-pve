const express = require('express');

// The one API in this app that deliberately bypasses session auth -- meant
// for an external consumer with no login of its own (e.g. a personal
// homepage's lab-status widget), gated instead by an admin-controlled
// enabled/disabled toggle and an optional IP
// allowlist (see /api/settings/api in server.js). Off by default: with no
// api-settings.json yet, api-settings.js's getSettings() returns
// { enabled: false }, so this 404s until an admin deliberately opts in.
//
// Checks both X-Real-IP and X-Forwarded-For (first hop) before falling back
// to the raw socket address -- unlike old labber (a fixed nginx-on-host
// reverse proxy always setting X-Real-IP), labber-pve's deployment target
// varies (k3s ingress, Docker behind a different proxy, bare `docker run`),
// so which header actually carries the real client IP isn't a single known
// quantity here.
function clientIp(req) {
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  if (req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

function gate(apiSettings) {
  return (req, res, next) => {
    const settings = apiSettings.getSettings();
    if (!settings.enabled) {
      return res.status(404).json({ error: 'not found' });
    }
    if (settings.allowedIps.length > 0 && !settings.allowedIps.includes(clientIp(req))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

function buildPublicRoutes({ apiSettings, getStats }) {
  const router = express.Router();

  router.get('/api/public/stats', gate(apiSettings), async (req, res) => {
    try {
      res.json(await getStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildPublicRoutes };
