const labManager = require('./lab-manager');
const consoleLocks = require('./console-locks');
const { openConsoleSession, resolveVmid } = require('./console-session');

// One browser websocket = one backend console session. The target is
// validated against real, currently-deployed state (never trust a
// client-supplied vmid directly) so this can't become an open proxy to
// arbitrary VMs. The Proxmox-side protocol lives in console-session.js,
// shared with runbook console steps.
//
// Browser -> server messages: connect {lab,node,takeover?}, input {data},
// resize {cols,rows}, disconnect. Server -> browser: connected, data,
// closed, error, and locked {holder} when a runbook currently owns the
// console (the client may resend connect with takeover:true to abort it).

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function handleConnection(ws, req) {
  const user = (req && req.session && req.session.username) || 'unknown';
  let session = null;
  let leave = null;

  function endSession() {
    if (session) { session.close(); session = null; }
    if (leave) { leave(); leave = null; }
  }

  async function connect(msg) {
    if (session) {
      safeSend(ws, { type: 'error', message: 'A session is already active on this connection' });
      return;
    }
    const vmid = await resolveVmid(labManager, msg.lab, msg.node);
    const key = consoleLocks.lockKey(msg.lab, msg.node);

    const holder = consoleLocks.runbookHolder(key);
    if (holder && !msg.takeover) {
      safeSend(ws, { type: 'locked', holder });
      return;
    }
    if (holder) await consoleLocks.takeover(key, user);

    leave = consoleLocks.joinHuman(key, user);
    try {
      session = await openConsoleSession(vmid, {
        onData: (data) => safeSend(ws, { type: 'data', data }),
        onClose: () => { safeSend(ws, { type: 'closed' }); endSession(); },
        onError: (err) => safeSend(ws, { type: 'error', message: err.message }),
      });
      safeSend(ws, { type: 'connected' });
    } catch (err) {
      endSession();
      throw err;
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'connect') {
      try {
        await connect(msg);
      } catch (err) {
        console.error('console-bridge connect error:', err.message);
        safeSend(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'input') {
      if (session) session.send(msg.data);
    } else if (msg.type === 'resize') {
      if (session) session.resize(msg.cols, msg.rows);
    } else if (msg.type === 'disconnect') {
      endSession();
    }
  });

  ws.on('close', endSession);
}

module.exports = { handleConnection };
