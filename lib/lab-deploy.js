const { withLock, isLocked } = require('./async-lock');
const { allocateVmid } = require('./deploy/vmid');
const { deploy } = require('./deploy/deploy');
const { destroy } = require('./deploy/destroy');
const { update } = require('./deploy/update');

// Deploy / destroy / update of a lab's VMs and bridges against Proxmox. The
// work lives in lib/deploy/*: vmid.js (id allocation), node-ops.js (clone /
// remove one VM), bridges.js, wiring.js (NIC plan shared by deploy and
// update), reconcile-node.js (update's live-config diff), and deploy.js /
// destroy.js / update.js (the three operations).

// Serializes the three operations per lab. Each does read-state / act /
// write-state steps with real Proxmox calls (awaits) in between, so two calls
// for the SAME lab (two tabs, or two logged-in users) could otherwise both pass
// their initial readState() check and race to clone/delete VMs and overwrite
// each other's state.json, orphaning whichever loses. A second call is not
// rejected: it queues behind the first, with an onProgress line so it is not
// silent while it waits.
function serialized(name, onProgress, fn) {
  const lockKey = `lab:${name}`;
  if (isLocked(lockKey)) onProgress(`waiting for another operation on "${name}" to finish...`);
  return withLock(lockKey, fn);
}

module.exports = {
  allocateVmid,
  deploy: (name, onProgress = () => {}) => serialized(name, onProgress, () => deploy(name, onProgress)),
  destroy: (name, onProgress = () => {}) => serialized(name, onProgress, () => destroy(name, onProgress)),
  update: (name, onProgress = () => {}) => serialized(name, onProgress, () => update(name, onProgress)),
};
