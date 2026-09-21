const { Agent, request } = require('undici');
const { currentConfig } = require('./proxmox-request');

// --- Console --------------------------------------------------------------
// Confirmed against Proxmox's own bug tracker (bugzilla #6079) and multiple
// forum threads: API tokens are not accepted for the termproxy/vncwebsocket
// auth phase ("does not look like a valid user name" / "connection closed
// before authentication") even though they work for every other endpoint in
// this file. The documented workaround is a real username+password session
// ticket (PVEAuthCookie) instead, used only for this one feature.
async function getAuthTicket(c) {
  if (!c.pveUsername || !c.pvePassword) {
    throw new Error(
      'Console access needs a Proxmox username/password in Settings (separate from the API token -- ' +
        'Proxmox does not support API tokens for console/termproxy, see bugzilla #6079)'
    );
  }
  const dispatcher = new Agent({ connect: { rejectUnauthorized: c.verifyTls } });
  const body = new URLSearchParams({ username: c.pveUsername, password: c.pvePassword });
  const res = await request(new URL(`${c.host.replace(/\/+$/, '')}/api2/json/access/ticket`), {
    method: 'POST',
    dispatcher,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.body.text();
  const json = text ? JSON.parse(text) : {};
  if (res.statusCode >= 400) {
    throw new Error(`Proxmox login failed for console access -> ${res.statusCode}: ${json.errors ? JSON.stringify(json.errors) : text}`);
  }
  return json.data; // { ticket, CSRFPreventionToken, username }
}

// Returns everything console-bridge.js needs to open the actual
// vncwebsocket connection. Kept separate from the websocket plumbing itself
// so this file stays pure HTTP-API, no ws logic.
//
// Two things beyond the API-token workaround that a first pass at this
// missed and are easy to get wrong silently: the termproxy POST itself
// needs a Referer header with xterm.js's own query params (Proxmox's
// termproxy endpoint reads them from Referer, not the request body, to
// decide it should hand back a plain-text-terminal-capable ticket) --
// without it the ticket may not behave the way the following vncwebsocket
// handshake expects. And the vncwebsocket handshake's first frame must be
// `username:ticket\n`, not just the bare ticket -- confirmed from a
// Proxmox staff reply on the forum ("probably missing the newline"),
// exactly the failure mode this hit.
async function getTermProxyTicket(vmid) {
  const c = currentConfig();
  const session = await getAuthTicket(c);
  const base = c.host.replace(/\/+$/, '');
  const dispatcher = new Agent({ connect: { rejectUnauthorized: c.verifyTls } });

  const res = await request(new URL(`${base}/api2/json/nodes/${c.node}/qemu/${vmid}/termproxy`), {
    method: 'POST',
    dispatcher,
    headers: {
      Cookie: `PVEAuthCookie=${session.ticket}`,
      CSRFPreventionToken: session.CSRFPreventionToken,
      Referer: `${base}/?console=kvm&xtermjs=1&vmid=${vmid}&node=${c.node}&cmd=`,
    },
  });
  const text = await res.body.text();
  const json = text ? JSON.parse(text) : {};
  if (res.statusCode >= 400) {
    throw new Error(`Proxmox termproxy request -> ${res.statusCode}: ${json.errors ? JSON.stringify(json.errors) : text}`);
  }

  return {
    ...json.data, // { ticket, port, user }
    node: c.node,
    vmid,
    host: c.host,
    verifyTls: c.verifyTls,
    sessionTicket: session.ticket,
    username: session.username || c.pveUsername,
  };
}

module.exports = { getAuthTicket, getTermProxyTicket };
