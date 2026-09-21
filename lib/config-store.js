const fs = require('fs');
const path = require('path');

// Persisted on the same volume as lab state (LABS_DIR) so it survives pod
// restarts/reschedules without needing its own separate PVC. 0700/0600
// perms are the "safely" part of "stores the keys locally and safely" --
// not encrypted at rest (would need a KMS/vault dependency this homelab
// tool doesn't otherwise need), but not world-readable either, and the
// real token secret is never echoed back to the browser once saved.
const CONFIG_DIR = path.join(process.env.LABS_DIR || '/labs', '.config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'proxmox.json');

const KNOWN_KINDS = ['paloalto_panos', 'paloalto_panorama', 'checkpoint_gaia', 'f5_bigip_ve', 'fortios', 'fortimanager', 'cisco_n9kv', 'cisco_c8000v', 'cisco_ftd', 'cisco_fmc', 'generic_qcow2', 'generic_iso'];

// templateVersions is two levels deep ({ [kind]: { [label]: vmid } }) -- a
// plain top-level spread merge (like `templates` gets away with, being only
// one level) would replace a whole kind's version map wholesale instead of
// adding to it, silently discarding every other label that kind already
// had. Merge each named kind's own map instead.
function mergeTemplateVersions(current, partial) {
  const result = { ...current };
  for (const [kind, versions] of Object.entries(partial || {})) {
    result[kind] = { ...(current[kind] || {}), ...versions };
  }
  return result;
}

// Env vars remain a valid way to bootstrap config (handy for local
// dev/testing, or an office deployment that prefers everything as
// k8s/OpenShift Secrets up front) -- but they're now just the *initial*
// defaults, not a hard requirement at boot. Whatever's saved via the
// Settings UI takes precedence from then on.
function envDefaults() {
  const templates = {};
  for (const kind of KNOWN_KINDS) {
    const envName = `TEMPLATE_ID_${kind.toUpperCase()}`;
    if (process.env[envName]) templates[kind] = process.env[envName];
  }
  return {
    host: process.env.PROXMOX_HOST || '',
    node: process.env.PROXMOX_NODE || '',
    tokenId: process.env.PROXMOX_TOKEN_ID || '',
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET || '',
    // Console access (termproxy/vncwebsocket) specifically -- Proxmox has a
    // confirmed bug/limitation (bugzilla #6079) where API tokens aren't
    // accepted for this one endpoint category, even though the token above
    // works fine for everything else in this app. Needs a real Proxmox
    // username+password to obtain a session ticket (PVEAuthCookie) just for
    // opening a console; everything else keeps using the API token.
    pveUsername: process.env.PROXMOX_USERNAME || '',
    pvePassword: process.env.PROXMOX_PASSWORD || '',
    verifyTls: process.env.PROXMOX_VERIFY_TLS !== 'false',
    // Proxmox storage ID where golden templates + lab clone disks live --
    // e.g. a directory storage carved out on a dedicated SSD (see README's
    // "Disk storage" section). Empty means "whatever Proxmox defaults to"
    // (usually the template's own source storage for clones).
    diskStorage: process.env.PROXMOX_DISK_STORAGE || '',
    // Where template-builder.js's VMID auto-pick looks for a free slot --
    // deliberately its own range, distinct from both lab-manager.js's
    // ephemeral lab-clone range (9000-9999) and wherever manually-built VMs
    // already live on a given node, so golden templates don't end up
    // interleaved with either. 100-299 is just a default; change it in
    // Settings to whatever numbering convention this Proxmox node already
    // uses -- template-builder.js also accepts an exact per-build VMID
    // override that ignores this range entirely.
    templateVmidStart: parseInt(process.env.TEMPLATE_VMID_START, 10) || 100,
    templateVmidEnd: parseInt(process.env.TEMPLATE_VMID_END, 10) || 299,
    templates,
    // Every build a kind has ever had, kept even after `templates[kind]`
    // moves on to a newer default -- { [kind]: { [versionLabel]: vmid } }.
    // `templates[kind]` itself stays "the default vmid a lab uses when its
    // YAML doesn't name a version" (unchanged meaning from before this
    // existed); this is purely additive history/selection on top of that.
    // Never populated from env vars -- there's no sane env-var shape for a
    // nested per-kind label map, and this only ever grows from real builds
    // (or the one-time backfill in load(), below) anyway.
    templateVersions: {},
    // Caps the byte rate of the templates-modal upload write (see lib/
    // upload-throttle.js) -- 0 means unlimited/off. Exists because this
    // app's node-local PVC storage can share a physical disk with etcd on
    // resource-constrained nodes (e.g. this homelab's Raspberry Pi k3s
    // cluster); a full-speed multi-GB write can starve etcd's fsyncs badly
    // enough to flip the node NotReady mid-upload. Read live by
    // upload-throttle.js on every upload, not cached at boot, so changing
    // this takes effect on the very next upload with no redeploy.
    uploadRateLimitMbps: parseInt(process.env.UPLOAD_RATE_LIMIT_MBPS, 10) || 0,
    // Base domain for the embedded-GUI reverse proxy (lib/gui-proxy.js) --
    // e.g. "gui.labber.example.com". Requires a wildcard DNS record plus a
    // reverse-proxy/Ingress rule for `*.<guiDomain>` pointing at this app's
    // GUI_PROXY_PORT, set up outside this app (see README) -- empty means
    // the feature is simply off, gui-proxy.js never starts its listener.
    guiDomain: process.env.GUI_DOMAIN || '',
  };
}

let cached = null;

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

// One-time, additive-only migration for kinds that already had a template
// built before templateVersions existed: seeds a version labeled "original"
// pointing at the same vmid `templates[kind]` already has, so it shows up
// in the version picker immediately instead of only being reachable as the
// nameless default. Never overwrites an existing entry, never touches
// `templates[kind]` itself -- safe to run on every load(), idempotent.
function backfillOriginalVersions(config) {
  for (const [kind, vmid] of Object.entries(config.templates)) {
    if (!vmid) continue;
    if (!config.templateVersions[kind]) config.templateVersions[kind] = {};
    if (!config.templateVersions[kind].original) config.templateVersions[kind].original = vmid;
  }
  return config;
}

function load() {
  if (cached) return cached;
  ensureDir();
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const defaults = envDefaults();
    cached = backfillOriginalVersions({
      ...defaults,
      ...onDisk,
      templates: { ...defaults.templates, ...(onDisk.templates || {}) },
      templateVersions: mergeTemplateVersions(defaults.templateVersions, onDisk.templateVersions),
    });
  } catch (e) {
    cached = backfillOriginalVersions(envDefaults());
  }
  return cached;
}

function save(partial) {
  ensureDir();
  const current = load();
  const next = {
    ...current,
    ...partial,
    templates: { ...current.templates, ...(partial.templates || {}) },
    templateVersions: mergeTemplateVersions(current.templateVersions, partial.templateVersions),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  return next;
}

// A build's one save point: records the new vmid under its version label
// (never overwriting a different label -- routes/templates.js's own
// up-front collision check is what decides whether *this* label is allowed
// to move) and, since every build is meant to become the new default per
// the labber-pve versioning design, always repoints `templates[kind]` at it
// too. Replacing an existing label's vmid intentionally does not touch
// whatever VM the old vmid pointed to in Proxmox -- see project notes:
// auto-destroying it isn't always safe (Proxmox itself refuses to destroy a
// template with live linked clones) and silently deleting a still-good
// template over a typo'd label would be a worse failure mode than a manual
// Proxmox-side cleanup later.
function saveTemplateVersion(kind, label, vmid) {
  return save({
    templates: { [kind]: String(vmid) },
    templateVersions: { [kind]: { [label]: String(vmid) } },
  });
}

function isConfigured() {
  const c = load();
  return !!(c.host && c.node && c.tokenId && c.tokenSecret);
}

function get() {
  return load();
}

// Safe to send to the browser: real secret is masked, never round-tripped.
function getSafe() {
  const c = load();
  return {
    host: c.host,
    node: c.node,
    tokenId: c.tokenId,
    tokenSecret: c.tokenSecret ? '••••••••' : '',
    pveUsername: c.pveUsername,
    pvePassword: c.pvePassword ? '••••••••' : '',
    verifyTls: c.verifyTls,
    diskStorage: c.diskStorage,
    templateVmidStart: c.templateVmidStart,
    templateVmidEnd: c.templateVmidEnd,
    templates: c.templates,
    templateVersions: c.templateVersions,
    uploadRateLimitMbps: c.uploadRateLimitMbps,
    guiDomain: c.guiDomain,
    configured: isConfigured(),
  };
}

module.exports = { get, getSafe, save, saveTemplateVersion, isConfigured, KNOWN_KINDS };
