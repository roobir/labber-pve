const WebSocket = require('ws');
const pve = require('./proxmox-client');
const labManager = require('./lab-manager');

// Same shape as clab-dashboard's ssh-bridge.js: one browser websocket = one
// backend session, target validated against real, currently-deployed state
// (never trust a client-supplied vmid/node directly) so this can't become an
// open proxy to arbitrary VMs.
//
// NOTE ON PROTOCOL ACCURACY: confirmed against Proxmox's own pve-xtermjs
// client (git.proxmox.com/pve-xtermjs) that the vncwebsocket channel uses
// numbered frame prefixes for everything the *client* sends: regular
// keystroke/terminal input is "0:<byte length>:<data>", resize is
// "1:<cols>:<rows>:", and "2" alone is a keepalive ping. Output from
// termproxy back to the client is plain, unframed terminal bytes -- no
// disambiguation needed on that side since the client only ever displays
// it. Getting the *input* framing wrong (sending bare keystrokes with no
// "0:len:" wrapper) was empirically the bug here: the connection, auth
// handshake, and output relay all worked, but nothing typed ever reached
// the VM until this was added.

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

async function resolveVmid(lab, nodeName) {
  const status = await labManager.getLabStatus(lab);
  if (!status.deployed) throw new Error(`Lab "${lab}" is not deployed`);
  const node = status.nodes[nodeName];
  if (!node) throw new Error(`Node "${nodeName}" not found in lab "${lab}"`);
  return node.vmid;
}

function handleConnection(ws) {
  let upstream = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'connect') {
      if (upstream) {
        safeSend(ws, { type: 'error', message: 'A session is already active on this connection' });
        return;
      }

      try {
        const vmid = await resolveVmid(msg.lab, msg.node);
        const { ticket, port, node, host, verifyTls, sessionTicket, username } = await pve.getTermProxyTicket(vmid);

        const wsUrl = `${host.replace(/^http/, 'ws')}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

        // Cookie here, not the API token header -- the websocket connection
        // itself needs the same session auth the termproxy call used (see
        // proxmox-client.js's getTermProxyTicket for why API tokens don't
        // work for this one feature).
        upstream = new WebSocket(wsUrl, {
          rejectUnauthorized: verifyTls,
          headers: { Cookie: `PVEAuthCookie=${sessionTicket}` },
        });

        upstream.on('open', () => {
          // Confirmed handshake format from a Proxmox staff reply: the
          // first frame must be "username:ticket\n" -- not the bare ticket
          // this used to send, and the trailing newline is required (a
          // missing newline alone was enough to break this same handshake
          // for someone else hitting this exact issue).
          upstream.send(`${username}:${ticket}\n`);
          safeSend(ws, { type: 'connected' });
        });

        upstream.on('message', (data) => {
          safeSend(ws, { type: 'data', data: data.toString('utf-8') });
        });

        // Reset to null on close so a stale (closed) reference doesn't
        // permanently trip the "already active" check above -- currently
        // masked by the frontend always tearing down and rebuilding the
        // whole outer websocket on every console open (a fresh
        // handleConnection() closure means a fresh `upstream = null` too),
        // but a future change reusing one outer websocket for multiple
        // console connects (e.g. switching node without closing the modal)
        // would otherwise wedge with no recovery short of a page reload.
        upstream.on('close', () => {
          safeSend(ws, { type: 'closed' });
          upstream = null;
        });
        upstream.on('error', (err) => {
          console.error(`console-bridge upstream error (vmid ${vmid}):`, err.message);
          safeSend(ws, { type: 'error', message: err.message });
        });
      } catch (err) {
        console.error('console-bridge connect error:', err.message);
        safeSend(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'input') {
      // "0:<byte length>:<data>" -- see NOTE above. Byte length, not
      // character count, since a multi-byte UTF-8 paste (non-ASCII text)
      // would otherwise send a length that doesn't match the actual bytes.
      if (upstream && upstream.readyState === upstream.OPEN) {
        const len = Buffer.byteLength(msg.data, 'utf-8');
        upstream.send(`0:${len}:${msg.data}`);
      }
    } else if (msg.type === 'resize') {
      if (upstream && upstream.readyState === upstream.OPEN) {
        upstream.send(`1:${msg.cols}:${msg.rows}:`);
      }
    } else if (msg.type === 'disconnect') {
      // Nulled immediately (not just left to the 'close' handler above,
      // which fires asynchronously) so a 'connect' arriving right after a
      // 'disconnect' isn't rejected by a reference to a socket that's
      // merely in the process of closing.
      if (upstream) { upstream.close(); upstream = null; }
    }
  });

  ws.on('close', () => {
    if (upstream) { upstream.close(); upstream = null; }
  });
}

module.exports = { handleConnection };
