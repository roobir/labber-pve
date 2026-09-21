// "api" header button -- pop-out window documenting the /api/relay/*
// automation gateway (lib/api-relay.js) with a live "try it" panel that
// fires a real request through the relay from this browser, so a user can
// confirm the whole path (relay enabled, token valid, node reachable)
// actually works before pointing real automation at it. Same open/close/
// minimize/drag wiring as templates.js.
(function () {
  const overlay = document.getElementById('apihelp-overlay');
  const openBtn = document.getElementById('apihelp-btn');
  const closeBtn = document.getElementById('apihelp-close');
  const minimizeBtn = document.getElementById('apihelp-minimize');
  const openSettingsBtn = document.getElementById('apihelp-open-settings');

  const labEl = document.getElementById('apihelp-lab');
  const nodeEl = document.getElementById('apihelp-node');
  const tokenEl = document.getElementById('apihelp-token');
  const methodEl = document.getElementById('apihelp-method');
  const pathEl = document.getElementById('apihelp-path');
  const bodyEl = document.getElementById('apihelp-body');
  const form = document.getElementById('apihelp-test-form');

  const resultEl = document.getElementById('apihelp-result');
  const resultStatusEl = document.getElementById('apihelp-result-status');
  const resultBodyEl = document.getElementById('apihelp-result-body');
  const messageEl = document.getElementById('apihelp-message');

  // labFile ("mylab.lab.yml") -> node -> { mgmtIp, mgmtPort } for the
  // currently loaded /api/status snapshot -- only nodes with a mgmt IP
  // saved on their dashboard card are relay-reachable at all (same
  // requirement as gui-proxy's getNodeTarget()), so those are the only
  // ones offered here.
  let labsWithMgmtIp = {};

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function populateNodes() {
    nodeEl.innerHTML = '';
    const nodes = labsWithMgmtIp[labEl.value] || {};
    const names = Object.keys(nodes);
    if (names.length === 0) {
      nodeEl.innerHTML = '<option value="">no nodes with a mgmt IP set</option>';
      return;
    }
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} (${nodes[name].mgmtIp})`;
      nodeEl.appendChild(opt);
    }
  }

  async function loadLabs() {
    labEl.innerHTML = '<option value="">loading...</option>';
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('failed to load labs');
      const { labs } = await res.json();

      labsWithMgmtIp = {};
      for (const [labFile, status] of Object.entries(labs || {})) {
        if (!status.deployed) continue;
        const withIp = {};
        for (const [nodeName, node] of Object.entries(status.nodes || {})) {
          if (node.mgmtIp) withIp[nodeName] = node;
        }
        if (Object.keys(withIp).length > 0) {
          labsWithMgmtIp[labFile.replace(/\.lab\.yml$/, '')] = withIp;
        }
      }

      const labNames = Object.keys(labsWithMgmtIp);
      labEl.innerHTML = '';
      if (labNames.length === 0) {
        labEl.innerHTML = '<option value="">no deployed nodes with a mgmt IP set yet</option>';
        nodeEl.innerHTML = '';
        return;
      }
      for (const name of labNames) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        labEl.appendChild(opt);
      }
      populateNodes();
    } catch (err) {
      labEl.innerHTML = '<option value="">failed to load labs</option>';
      nodeEl.innerHTML = '';
    }
  }

  labEl.addEventListener('change', populateNodes);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    resultEl.classList.add('hidden');
    setMessage('');

    const lab = labEl.value;
    const node = nodeEl.value;
    const token = tokenEl.value.trim();
    if (!lab || !node) return setMessage('pick a lab and node with a mgmt IP set', true);
    if (!token) return setMessage('paste a relay token (create one under Settings -> Public API)', true);

    let path = pathEl.value.trim() || '/';
    if (!path.startsWith('/')) path = `/${path}`;

    const method = methodEl.value;
    const rawBody = bodyEl.value.trim();

    setMessage('sending...');
    try {
      const res = await fetch(
        `/api/relay/${encodeURIComponent(lab)}/${encodeURIComponent(node)}${path}`,
        {
          method,
          headers: {
            'X-Labber-Relay-Token': token,
            ...(rawBody ? { 'Content-Type': 'application/json' } : {}),
          },
          body: rawBody || undefined,
        }
      );

      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        // not JSON -- show as-is
      }

      resultStatusEl.textContent = `${res.status} ${res.statusText}`;
      resultStatusEl.className = res.ok ? 'apihelp-result-status-ok' : 'apihelp-result-status-err';
      resultBodyEl.textContent = pretty.slice(0, 8000);
      resultEl.classList.remove('hidden');
      setMessage(
        res.status === 502
          ? 'relay reached this app but could not connect to the node itself -- check its mgmt IP/port'
          : 'request completed -- any response above (even an error from the device) confirms the relay reached it'
      );
    } catch (err) {
      setMessage(`request failed: ${err.message}`, true);
    }
  });

  openSettingsBtn.addEventListener('click', () => {
    document.getElementById('settings-btn').click();
    if (window.SettingsNav) window.SettingsNav.show('publicapi');
  });

  function open() {
    overlay.classList.remove('hidden');
    loadLabs();
  }

  function close() {
    overlay.classList.add('hidden');
  }

  function minimize() {
    WindowManager.minimize('apihelp', overlay, 'api relay');
  }

  openBtn.addEventListener('click', () => {
    if (WindowManager.isMinimized('apihelp')) WindowManager.restore('apihelp');
    else open();
  });
  closeBtn.addEventListener('click', close);
  minimizeBtn.addEventListener('click', minimize);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));
})();
