const { pve } = require('./proxmox-request');

// --- Networking (bridges) ---------------------------------------------------
async function listNetworkInterfaces() {
  return pve('GET', '/nodes/{node}/network');
}

// bridgePorts omitted/empty -> internal-only switch, no physical uplink.
// This is the normal case for lab-to-lab links; only "external"-flagged
// networks in the lab YAML should ever get a real bridge_ports value.
async function createBridge(iface, { bridgePorts, comments } = {}) {
  await pve('POST', '/nodes/{node}/network', {
    type: 'bridge',
    iface,
    autostart: 1,
    ...(bridgePorts ? { bridge_ports: bridgePorts } : {}),
    ...(comments ? { comments } : {}),
  });
  // NOTE: PVE stages network changes and requires a separate apply step
  // (equivalent to the "Apply Configuration" button in the UI / `ifreload -a`
  // on the node). Verify this exact call against your PVE version before
  // relying on it in production -- documented here as PUT with no body based
  // on community references, but this is the one endpoint in this file not
  // independently confirmed against the official API schema.
}

async function deleteBridge(iface) {
  await pve('DELETE', `/nodes/{node}/network/${iface}`);
}

async function applyNetworkChanges() {
  await pve('PUT', '/nodes/{node}/network');
}

module.exports = { listNetworkInterfaces, createBridge, deleteBridge, applyNetworkChanges };
