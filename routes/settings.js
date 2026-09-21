const express = require('express');
const configStore = require('../lib/config-store');
const proxmox = require('../lib/proxmox-client');
const apiSettings = require('../lib/api-settings');

const SECRET_MASK = '••••••••';

// The GET response masks secret fields (config-store.getSafe()); resolve
// what the *real* value should end up being from a save/test request
// without ever trusting the masked placeholder as a literal value. Shared
// by the API token secret and the console-access Proxmox password -- both
// round-trip through the browser the same masked way.
function resolveSecret(bodyValue, currentValue) {
  if (!bodyValue || bodyValue === SECRET_MASK) return currentValue;
  return bodyValue;
}

// Same "fall back to whatever's already saved" resolution as resolveSecret
// above, for a field that arrives as a string over JSON and needs to parse
// cleanly to a positive integer or not be applied at all -- an object
// spread that included undefined/NaN here would silently clobber the
// previously-saved range instead of leaving it alone.
function resolveVmidBound(bodyValue, currentValue) {
  const n = parseInt(bodyValue, 10);
  return Number.isInteger(n) && n > 0 ? n : currentValue;
}

// Same fall-back-if-invalid shape as resolveVmidBound, but 0 is a valid,
// meaningful value here (uploadRateLimitMbps: "unlimited") rather than
// something to reject -- resolveVmidBound's `n > 0` would make 0
// unreachable once anything else had ever been saved.
function resolveNonNegativeInt(bodyValue, currentValue) {
  const n = parseInt(bodyValue, 10);
  return Number.isInteger(n) && n >= 0 ? n : currentValue;
}

// Proxmox connection + template VMIDs (configured post-deploy, via this
// app's own UI rather than required at boot) plus the public-stats-API
// enable/allowlist toggle -- both are "operator config for this app
// itself," kept in one router.
function buildSettingsRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/settings', requireAuth, (req, res) => {
    res.json(configStore.getSafe());
  });

  router.post('/api/settings', requireAuth, (req, res) => {
    const body = req.body || {};
    try {
      const current = configStore.get();
      configStore.save({
        host: body.host,
        node: body.node,
        tokenId: body.tokenId,
        tokenSecret: resolveSecret(body.tokenSecret, current.tokenSecret),
        pveUsername: body.pveUsername,
        pvePassword: resolveSecret(body.pvePassword, current.pvePassword),
        verifyTls: body.verifyTls !== false,
        diskStorage: body.diskStorage,
        templateVmidStart: resolveVmidBound(body.templateVmidStart, current.templateVmidStart),
        templateVmidEnd: resolveVmidBound(body.templateVmidEnd, current.templateVmidEnd),
        templates: body.templates,
        guiDomain: body.guiDomain,
        uploadRateLimitMbps: resolveNonNegativeInt(body.uploadRateLimitMbps, current.uploadRateLimitMbps),
      });
      res.json(configStore.getSafe());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Tests against whatever's in the request body (which may be a mix of new
  // values and the masked secret placeholder for fields left unchanged) --
  // never persists, just gives the Settings page immediate pass/fail
  // feedback before the user commits to saving.
  router.post('/api/settings/test', requireAuth, async (req, res) => {
    const body = req.body || {};
    try {
      const version = await proxmox.testConnection({
        host: body.host || configStore.get().host,
        tokenId: body.tokenId || configStore.get().tokenId,
        tokenSecret: resolveSecret(body.tokenSecret, configStore.get().tokenSecret),
        verifyTls: body.verifyTls !== false,
      });
      res.json({ ok: true, version });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/api/settings/api', requireAuth, (req, res) => {
    res.json(apiSettings.getSettings());
  });

  router.post('/api/settings/api', requireAuth, (req, res) => {
    const { enabled, allowedIps, relayEnabled } = req.body || {};
    res.json(apiSettings.saveSettings({ enabled, allowedIps, relayEnabled }));
  });

  return router;
}

module.exports = { buildSettingsRoutes };
