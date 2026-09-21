const fs = require('fs');
const path = require('path');

// Same LABS_DIR/.config volume + 0600/0700 perms as config-store.js's
// proxmox.json -- survives pod restarts/reschedules without a separate PVC.
// Controls two independent, unauthenticated-until-opted-in features, both
// off by default:
//   - enabled/allowedIps: the /api/public/stats endpoint (public-routes.js)
//   - relayEnabled: the /api/relay/* automation gateway (api-relay.js),
//     itself still gated per-request by a bearer token (api-tokens.js) --
//     this flag is just a single admin-facing kill switch independent of
//     having to find and revoke every issued token.
const CONFIG_DIR = path.join(process.env.LABS_DIR || '/labs', '.config');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'api-settings.json');

const DEFAULTS = { enabled: false, allowedIps: [], relayEnabled: false };

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function getSettings() {
  ensureDir();
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

// Partial-update by design (checks `!== undefined` per field rather than
// always overwriting the whole object) -- the stats-API form and the relay
// form (Settings -> Public API panel) POST to this same endpoint
// independently, each only sending the field(s) it owns. Without this, the
// second form's save would silently reset whatever the first form had set.
function saveSettings({ enabled, allowedIps, relayEnabled } = {}) {
  ensureDir();
  const current = getSettings();
  const settings = {
    enabled: enabled !== undefined ? !!enabled : current.enabled,
    allowedIps:
      allowedIps !== undefined
        ? (Array.isArray(allowedIps) ? allowedIps.map((ip) => String(ip).trim()).filter(Boolean) : [])
        : current.allowedIps,
    relayEnabled: relayEnabled !== undefined ? !!relayEnabled : current.relayEnabled,
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

module.exports = { getSettings, saveSettings };
