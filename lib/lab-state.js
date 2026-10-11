// Per-lab / per-node state helpers, in two files that this module re-exports
// together (so `require('./lab-state')` keeps working for every caller):
//   lab-status.js -- live status for the dashboard poll (one shared Proxmox
//                    call, cached) and the bootstrap-configured flag;
//   lab-nodes.js  -- one node's mgmt IP, identity pin, VM id, GUI-proxy target
//                    and guest-agent IP detection.
module.exports = { ...require('./lab-status'), ...require('./lab-nodes') };
