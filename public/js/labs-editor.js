// Lab manager modal: list labs/*.lab.yml, edit + save, deploy/destroy with
// live streamed output. The "new lab" wizard (node/link builder form) lives
// in labs-wizard.js -- this file exposes `window.LabsEditor.loadList`/
// `.selectLab` so the wizard can refresh the list and jump to a newly
// created lab after saving, the same window.X cross-file convention this
// app already uses for window-manager.js/gui.js/terminal.js.
(function () {
  const overlay = document.getElementById('labs-overlay');
  const labsBtn = document.getElementById('labs-btn');
  const closeBtn = document.getElementById('labs-close');
  const minimizeBtn = document.getElementById('labs-minimize');
  const listEl = document.getElementById('labs-list');
  const nameEl = document.getElementById('labs-current-name');
  const yamlEl = document.getElementById('labs-yaml');
  const saveBtn = document.getElementById('labs-save-btn');
  const deployBtn = document.getElementById('labs-deploy-btn');
  const updateBtn = document.getElementById('labs-update-btn');
  const destroyBtn = document.getElementById('labs-destroy-btn');
  const deleteBtn = document.getElementById('labs-delete-btn');
  const messageEl = document.getElementById('labs-message');
  const outputEl = document.getElementById('labs-output');

  const newLabBtn = document.getElementById('labs-new-btn');

  let currentLab = null;
  let ws = null;
  let term = null;
  let fitAddon = null;

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function setEditingEnabled(enabled) {
    yamlEl.disabled = !enabled;
    saveBtn.disabled = !enabled;
    deployBtn.disabled = !enabled;
    updateBtn.disabled = !enabled;
    destroyBtn.disabled = !enabled;
    deleteBtn.disabled = !enabled;
  }

  // Deleting the file itself is distinct from destroy() (which only tears
  // down the deployed VMs/bridges) -- server rejects it with a clear 400
  // if the lab is still deployed, same "destroy first" guard as
  // lab-manager.js's deleteLab().
  async function deleteLab() {
    if (!currentLab) return;
    if (!window.confirm(`Delete "${currentLab}"? This removes the lab file itself, not just any deployed VMs.`)) {
      return;
    }
    setMessage('deleting...');
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(currentLab)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'delete failed');
      currentLab = null;
      nameEl.textContent = 'select a lab';
      yamlEl.value = '';
      setEditingEnabled(false);
      setMessage('deleted');
      await loadList();
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  function ensureTerm() {
    if (term) return;
    // convertEol: true -- lab-bridge.js's onProgress lines arrive with a
    // bare '\n' (see its onProgress: `${line}\n`), not '\r\n'. Without this,
    // xterm.js treats '\n' as "move down a row" only, NOT "return to column
    // 0" -- the cursor stays wherever the previous line ended, so each new
    // line renders further to the right than the last (a diagonal
    // staircase instead of a normal left-aligned log). terminal.js's own
    // Terminal (the device console feature) doesn't need this: it streams
    // a real device's own serial/PTY output, which already emits proper
    // CRLF itself.
    term = new Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, theme: { background: '#000000' }, disableStdin: true, convertEol: true });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(outputEl);
    fitAddon.fit();
  }

  // Same three-state read as the main dashboard's per-node dots (see
  // dashboard-cards.js), just rolled up to one dot per lab: never
  // deployed (dim, no class), deployed with every node running (green,
  // "running"), deployed but not every node up -- mid-deploy, partially
  // stopped, whatever (amber, "partial"). Status comes from the same
  // /api/status the dashboard already polls, fetched alongside the file
  // list so a lab that's never been deployed still shows up dim instead
  // of just... not indicating anything.
  function labDotState(status) {
    if (!status || !status.deployed) return { cls: '', title: 'not deployed' };
    const nodes = Object.values(status.nodes || {});
    const running = nodes.filter((n) => n.status === 'running').length;
    if (nodes.length > 0 && running === nodes.length) {
      return { cls: 'running', title: `deployed -- ${running}/${nodes.length} running` };
    }
    return { cls: 'partial', title: `deployed -- ${running}/${nodes.length} running` };
  }

  async function loadList() {
    listEl.innerHTML = '';
    let labs;
    try {
      const res = await fetch('/api/labs');
      labs = await res.json();
    } catch (err) {
      listEl.innerHTML = '<div class="dim">failed to load labs</div>';
      return;
    }

    if (labs.length === 0) {
      listEl.innerHTML = '<div class="dim">no lab files found</div>';
      return;
    }

    let statuses = {};
    try {
      const res = await fetch('/api/status');
      statuses = (await res.json()).labs || {};
    } catch (err) {
      // status is decoration, not essential -- fall back to all-dim dots
      // rather than failing the whole list over it
    }

    for (const name of labs) {
      const item = document.createElement('div');
      item.className = 'labs-list-item';
      const dot = labDotState(statuses[name]);
      const dotEl = document.createElement('span');
      dotEl.className = `dot${dot.cls ? ` ${dot.cls}` : ''}`;
      dotEl.title = dot.title;
      item.appendChild(dotEl);
      item.appendChild(document.createTextNode(name));
      item.addEventListener('click', () => selectLab(name, item));
      listEl.appendChild(item);
    }
  }

  async function selectLab(name, itemEl) {
    window.LabsWizard.close();
    for (const el of listEl.querySelectorAll('.labs-list-item')) {
      el.classList.remove('active');
    }
    if (!itemEl) {
      itemEl = Array.from(listEl.querySelectorAll('.labs-list-item')).find((el) => el.textContent === name);
    }
    if (itemEl) itemEl.classList.add('active');

    setMessage('');
    let content;
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error((await res.json()).error || 'failed to load');
      content = await res.text();
    } catch (err) {
      setMessage(err.message, true);
      return;
    }

    currentLab = name;
    nameEl.textContent = name;
    yamlEl.value = content;
    setEditingEnabled(true);
  }

  async function save() {
    if (!currentLab) return;
    setMessage('saving...');
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(currentLab)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: yamlEl.value,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'save failed');
      setMessage('saved');
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  function runAction(action) {
    if (!currentLab) return;
    if (action === 'destroy' && !window.confirm(`Destroy lab "${currentLab}"? This tears down its running nodes.`)) {
      return;
    }
    if (action === 'update' && !window.confirm(`Update lab "${currentLab}"? This may restart nodes whose config changed.`)) {
      return;
    }
    if (ws) {
      setMessage('a command is already running', true);
      return;
    }

    ensureTerm();
    term.clear();
    setMessage(`running ${action}...`);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws/lab`);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'run', action, lab: currentLab }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'error') {
        setMessage(msg.message, true);
        if (WindowManager.isMinimized('labs')) WindowManager.notify('labs', msg.message, true);
      } else if (msg.type === 'done') {
        const isError = msg.exitCode !== 0;
        const detail = isError && msg.error ? `: ${msg.error}` : '';
        const text = `${action} finished (exit ${msg.exitCode})${detail}`;
        setMessage(text, isError);
        // The deploy()/destroy() this ws is streaming keeps running
        // server-side regardless of the client -- but this notification is
        // the only way to know it actually reached a 'done' state, not just
        // whether the socket happened to still be connected.
        if (WindowManager.isMinimized('labs')) {
          WindowManager.notify('labs', `${currentLab}: ${text}`, isError);
        }
        // loadList() rebuilds the whole list (that's how its status dots get
        // their fresh /api/status read) -- otherwise a lab deployed from
        // within this modal keeps showing its pre-deploy dot (dim) forever,
        // since loadList() is normally only called on open(). Re-mark the
        // just-deployed lab active since loadList() doesn't know which row
        // was selected.
        const deployedLab = currentLab;
        loadList().then(() => {
          const itemEl = Array.from(listEl.querySelectorAll('.labs-list-item')).find((el) => el.textContent === deployedLab);
          if (itemEl) itemEl.classList.add('active');
        });
        if (ws) { ws.close(); ws = null; }
      }
    });

    ws.addEventListener('close', () => { ws = null; });
  }

  function open() {
    overlay.classList.remove('hidden');
    currentLab = null;
    nameEl.textContent = 'select a lab';
    yamlEl.value = '';
    setEditingEnabled(false);
    setMessage('');
    window.LabsWizard.close();
    loadList();
    setTimeout(() => fitAddon && fitAddon.fit(), 0);
  }

  // Explicit close still disconnects the live stream (matches the previous
  // behavior exactly) -- the deploy()/destroy() itself keeps running on the
  // server regardless, this just stops watching it. minimize() below is the
  // new "keep watching, just hidden" option.
  function close() {
    overlay.classList.add('hidden');
    if (ws) { ws.close(); ws = null; }
  }

  // Never touches ws -- deploy/destroy output keeps streaming into the
  // (hidden) terminal exactly as if the modal were still open, and the ws
  // 'done'/'error' handlers above flash the taskbar chip once something
  // actually finishes.
  function minimize() {
    WindowManager.minimize('labs', overlay, currentLab || 'labs');
  }

  labsBtn.addEventListener('click', () => {
    if (WindowManager.isMinimized('labs')) WindowManager.restore('labs');
    else open();
  });
  closeBtn.addEventListener('click', close);
  minimizeBtn.addEventListener('click', minimize);
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  saveBtn.addEventListener('click', save);
  deployBtn.addEventListener('click', () => runAction('deploy'));
  updateBtn.addEventListener('click', () => runAction('update'));
  destroyBtn.addEventListener('click', () => runAction('destroy'));
  deleteBtn.addEventListener('click', deleteLab);
  window.addEventListener('resize', () => fitAddon && fitAddon.fit());
  // xterm needs a fit() once it's actually visible again -- writes that
  // arrived while minimized (display:none) still landed in its buffer, but
  // sizing/rendering only catches up once restored.
  window.addEventListener('wm:restored', (e) => {
    if (e.detail.id === 'labs') setTimeout(() => fitAddon && fitAddon.fit(), 0);
  });

  newLabBtn.addEventListener('click', () => window.LabsWizard.open());

  window.LabsEditor = { loadList, selectLab };
})();
