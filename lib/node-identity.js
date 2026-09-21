const pve = require('./proxmox-client');

// Several vendor licenses (PAN-OS, F5 BIG-IP, Check Point, ...) are keyed to
// the guest's SMBIOS system UUID and/or a NIC's MAC address -- both of which
// Proxmox otherwise re-randomizes on every clone (lab-manager.js's deploy()
// never sets smbios1, and NIC lines were written with no MAC at all). This
// module reads/builds the two config shapes involved so a lab can pin either
// value and "anchor" (persist) whatever's currently live back into the lab
// YAML for reuse on the next deploy.
//
// Not independently confirmed against the official PVE API schema (same
// honesty convention this app already uses for its few unverified endpoints,
// e.g. network-manager.js's createBridge()) -- `smbios1: uuid=<uuid>` and a
// bare/`<model>=<mac>,...` netN value are both long-standing, widely
// documented `qm`/API shapes, but worth a real `qm config <vmid>` sanity
// check against this node's own PVE version before relying on it blind.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

function parseUuid(smbios1) {
  if (!smbios1) return null;
  const m = /uuid=([0-9a-fA-F-]{36})/.exec(smbios1);
  return m ? m[1] : null;
}

// A netN value's first comma-separated token is either a bare model
// ("virtio") or "model=mac" ("virtio=BC:24:11:12:34:56") -- everything after
// the first comma (bridge/firewall/link_down/...) is untouched here.
function parseMac(netValue) {
  if (!netValue) return null;
  const firstPart = netValue.split(',')[0];
  const eq = firstPart.indexOf('=');
  return eq === -1 ? null : firstPart.slice(eq + 1);
}

function parseIdentity(vmConfig) {
  const macs = {};
  for (const key of Object.keys(vmConfig || {})) {
    if (!/^net\d+$/.test(key)) continue;
    const mac = parseMac(vmConfig[key]);
    if (mac) macs[key] = mac;
  }
  return { uuid: parseUuid(vmConfig && vmConfig.smbios1), macs };
}

// mac === undefined/null -> bare model (Proxmox auto-assigns); otherwise
// pins the given MAC. Used both to build a brand-new netN value at deploy
// time and to patch an existing one (preserving everything after the model).
function nicPrefix(model, mac) {
  return mac ? `${model}=${mac}` : model;
}

function buildNicValue(existingNetValue, mac) {
  const parts = existingNetValue.split(',');
  const model = parts[0].split('=')[0];
  parts[0] = nicPrefix(model, mac);
  return parts.join(',');
}

// Pushes a UUID and/or specific NIC MACs onto an already-cloned VM. NIC
// changes re-read the current config first so only the model=mac prefix
// changes -- bridge/firewall/link_down on that same interface are preserved
// exactly, same "read then patch" approach server.js's PUT /api/vms/:vmid/config
// already uses for machine/serial0.
async function applyIdentity(vmid, { uuid, macs } = {}) {
  const params = {};
  if (uuid) params.smbios1 = `uuid=${uuid}`;

  if (macs && Object.keys(macs).length) {
    const cfg = await pve.getVmConfig(vmid);
    for (const [iface, mac] of Object.entries(macs)) {
      if (!cfg[iface]) throw new Error(`VM ${vmid} has no interface "${iface}"`);
      params[iface] = buildNicValue(cfg[iface], mac);
    }
  }

  if (Object.keys(params).length) await pve.setVmConfig(vmid, params);
}

module.exports = { UUID_RE, MAC_RE, parseIdentity, nicPrefix, buildNicValue, applyIdentity };
