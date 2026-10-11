const tls = require('tls');

// TLS settings for connecting to lab appliances (the GUI proxy, the API relay,
// REST runbook steps). Those connections already skip certificate checks --
// lab appliances run self-signed certificates -- so the only thing this adds
// is keeping the same handshake tolerance Node 20 had.
//
// Node 24 ships a newer OpenSSL whose default security level (2) refuses a
// server whose Diffie-Hellman parameters are 1024-bit ("DH_KEY_TOO_SMALL"), which
// older appliance images still use. Node 20 accepted those (level 1). Level 1
// is OpenSSL's own previous default, not "no security": TLS 1.2+ and modern
// ciphers stay in force. Proxmox itself is not affected (it uses the strict
// default, and verifies its certificate when "Verify TLS" is on).
const APPLIANCE_CIPHERS = `${tls.DEFAULT_CIPHERS}:@SECLEVEL=1`;

module.exports = { APPLIANCE_CIPHERS };
