// Thin aggregator over the split-out proxmox-*.js modules (request, task
// polling, VM lifecycle, template-build calls, console/termproxy, network)
// -- kept so every existing caller across this app can keep doing
// `require('./proxmox-client')` / `require('../lib/proxmox-client')`
// unchanged; this file used to *be* all six of those modules in one
// ~600-line file before the labber-pve full-review file-size pass. Nothing
// here has behavior of its own.
module.exports = {
  ...require('./proxmox-request'),
  ...require('./proxmox-tasks'),
  ...require('./proxmox-vm'),
  ...require('./proxmox-templates'),
  ...require('./proxmox-console'),
  ...require('./proxmox-network'),
};
