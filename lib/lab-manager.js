// Thin aggregator over the split-out lab-*.js modules (file CRUD +
// validation, deploy/destroy, and deployed-state/identity/mgmt-ip queries)
// -- kept so every existing caller across this app can keep doing
// `require('./lib/lab-manager')` unchanged; this file used to *be* all
// three of those modules in one ~540-line file before the labber-pve
// full-review file-size pass. Nothing here has behavior of its own.
module.exports = {
  ...require('./lab-files'),
  ...require('./lab-deploy'),
  ...require('./lab-state'),
};
