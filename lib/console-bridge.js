const labManager = require('./lab-manager');
const consoleLocks = require('./console-locks');
const { openConsoleSession, resolveVmid } = require('./console-session');
const audit = require('./audit/log');
const { clientIp } = require('./client-ip');

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
  const ip = req ? clientIp(req) : '';
  let session = null;
  let leave = null;
  let opened = null; // { target, at } while an audited console is open

  // Audited: who opened which node's console, and for how long. What is
  // typed in it is never recorded (it includes device passwords).
  function endSession() {
    if (session) { session.close(); session = null; }
    if (leave) { leave(); leave = null; }
    if (opened) {
      audit.record({ user, ip, action: 'console.close', target: opened.target, detail: { seconds: Math.round((Date.now() - opened.at) / 1000) } });
      opened = null;
    }
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
      opened = { target: `${msg.lab}/${msg.node}`, at: Date.now() };
      audit.record({ user, ip, action: 'console.open', target: opened.target, detail: { tookOverRun: holder ? `${holder.runbook} (${holder.user})` : undefined } });
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
