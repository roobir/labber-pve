const labManager = require('../lab-manager');
const pve = require('../proxmox-client');
const nodeIdentity = require('../node-identity');
const reservations = require('../reservations');

// The real-world side of a run's `deps.labs`: lab/node lookups, saving a
// mgmt IP, and reading a node's live identity. Everything validates the lab
// name against the actual lab list first, so a client-supplied name never
// reaches the filesystem unvetted.

function stateOf(lab) {
  return labManager.listLabs().includes(lab) ? labManager.readState(lab) : null;
}

function getNode(lab, node) {
  const state = stateOf(lab);
  const n = state && state.nodes && state.nodes[node];
  if (!n) return null;
  return { vmid: n.vmid, kind: n.kind, ip: n.mgmtIp || null, port: n.mgmtPort || 443 };
}

function setMgmtIp(lab, node, ip, port) {
  return labManager.setNodeMgmtIp(lab, node, ip, port);
}

async function getIdentity(lab, node) {
  const found = getNode(lab, node);
  if (!found) throw new Error(`${node} is not deployed in ${lab}`);
  return nodeIdentity.parseIdentity(await pve.getVmConfig(found.vmid));
}

// Deployed nodes with their kind and mgmt IP, for the run form's pickers.
function listTargets() {
  const out = [];
  for (const lab of labManager.listLabs()) {
    const state = labManager.readState(lab);
    for (const [node, n] of Object.entries((state && state.nodes) || {})) {
      out.push({ lab, node, kind: n.kind, ip: n.mgmtIp || null, reservation: reservations.get(lab) });
    }
  }
  return out;
}

module.exports = { getNode, setMgmtIp, getIdentity, listTargets };
