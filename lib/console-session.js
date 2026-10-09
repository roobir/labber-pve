const WebSocket = require('ws');
const pve = require('./proxmox-client');

// One upstream Proxmox termproxy/vncwebsocket session to a VM's serial
// console, independent of who is driving it: the browser console modal
// (lib/console-bridge.js) and runbook console steps (lib/runbooks/) both
// open it through here, so the protocol details live in exactly one place.
//
// Protocol notes (confirmed against Proxmox's own pve-xtermjs client):
//   - handshake: the first frame must be "username:ticket\n" (trailing
//     newline required)
//   - client -> termproxy: input is "0:<byte length>:<data>", resize is
//     "1:<cols>:<rows>:", and "2" alone is a keepalive ping
//   - termproxy -> client: plain, unframed terminal bytes
// Sending bare keystrokes with no "0:len:" wrapper connects and relays
// output fine but nothing typed ever reaches the VM.

const KEEPALIVE_MS = 25 * 1000;

async function resolveVmid(labManager, lab, nodeName) {
  const status = await labManager.getLabStatus(lab);
  if (!status.deployed) throw new Error(`Lab "${lab}" is not deployed`);
  const node = status.nodes[nodeName];
  if (!node) throw new Error(`Node "${nodeName}" not found in "${lab}"`);
  return node.vmid;
}

// Resolves once the upstream socket is open and authenticated; rejects if
// it fails before that. After that, failures arrive through onError/onClose.
async function openConsoleSession(vmid, { onData, onClose, onError }) {
  const { ticket, port, node, host, verifyTls, sessionTicket, username } = await pve.getTermProxyTicket(vmid);
  const wsUrl = `${host.replace(/^http/, 'ws')}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(ticket)}`;

  // The websocket itself needs the same session cookie the termproxy call
  // used (API tokens aren't accepted for this feature, see
  // proxmox-console.js).
  const upstream = new WebSocket(wsUrl, {
    rejectUnauthorized: verifyTls,
    headers: { Cookie: `PVEAuthCookie=${sessionTicket}` },
  });

  return new Promise((resolve, reject) => {
    let opened = false;
    let keepalive = null;

    const isOpen = () => upstream.readyState === WebSocket.OPEN;
    const session = {
      isOpen,
      send(data) {
        if (!isOpen()) return;
        // Byte length, not character count: a multi-byte UTF-8 paste would
        // otherwise send a length that doesn't match the actual bytes.
        upstream.send(`0:${Buffer.byteLength(data, 'utf-8')}:${data}`);
      },
      resize(cols, rows) {
        if (isOpen()) upstream.send(`1:${cols}:${rows}:`);
      },
      close() {
        clearInterval(keepalive);
        upstream.close();
      },
    };

    upstream.on('open', () => {
      opened = true;
      upstream.send(`${username}:${ticket}\n`);
      keepalive = setInterval(() => isOpen() && upstream.send('2'), KEEPALIVE_MS);
      resolve(session);
    });
    upstream.on('message', (data) => onData && onData(data.toString('utf-8')));
    upstream.on('close', () => {
      clearInterval(keepalive);
      if (opened && onClose) onClose();
    });
    upstream.on('error', (err) => {
      if (!opened) return reject(err);
      console.error(`console-session upstream error (vmid ${vmid}):`, err.message);
      if (onError) onError(err);
    });
  });
}

module.exports = { openConsoleSession, resolveVmid };
