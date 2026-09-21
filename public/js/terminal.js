// Single-session console modal: one xterm.js instance, reused per
// connection. No credential prompt (unlike clab-dashboard's ssh-bridge) --
// Proxmox's termproxy ticket is fetched and used entirely server-side, the
// browser never sees or needs a device password.
(function () {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('term-title');
  const bodyPane = document.getElementById('term-body');
  const closeBtn = document.getElementById('term-close');

  let term = null;
  let fitAddon = null;
  let ws = null;

  function reset() {
    if (ws) { ws.close(); ws = null; }
    if (term) { term.dispose(); term = null; }
    bodyPane.innerHTML = '';
  }

  function close() {
    overlay.classList.add('hidden');
    reset();
  }

  function connect(lab, node) {
    reset();

    term = new Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, theme: { background: '#000000' } });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(bodyPane);
    fitAddon.fit();
    term.write(`connecting to ${node}...\r\n`);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws/console`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'connect', lab, node }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'connected') {
        term.write('\x1b[90m[connected]\x1b[0m\r\n');
        term.onData((data) => ws.send(JSON.stringify({ type: 'input', data })));
        // No listener registered here -- the one at module scope (below)
        // already covers resize for whatever the current fitAddon is;
        // registering another on every connect() accumulated one per
        // console session opened, none ever removed.
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[91m[error] ${msg.message}\x1b[0m\r\n`);
      } else if (msg.type === 'closed') {
        term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
      }
    });

    ws.addEventListener('close', () => {
      if (term) term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    });
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('resize', () => fitAddon && fitAddon.fit());
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));

  window.openConsole = function (lab, node) {
    titleEl.textContent = `${node} (console)`;
    overlay.classList.remove('hidden');
    setTimeout(() => { connect(lab, node); fitAddon && fitAddon.fit(); }, 0);
  };
})();
