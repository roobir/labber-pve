// Topology modal: lab picker + graph view. Fetches the already-parsed,
// already-validated topology JSON (GET /api/labs/:name/topology, backed by
// lib/lab-manager.js's parseTopology()) and the same live /api/status this
// dashboard already polls, then hands both off to topology-render.js's
// createTopologyRenderer (Cytoscape.js) -- this file only owns the modal
// chrome and the lab list, not graph construction, same split as the old
// libvirt-based labber project this was ported from.
(function () {
  const overlay = document.getElementById('topology-overlay');
  const topologyBtn = document.getElementById('topology-btn');
  const closeBtn = document.getElementById('topology-close');
  const minimizeBtn = document.getElementById('topology-minimize');
  const listEl = document.getElementById('topology-labs-list');
  const nameEl = document.getElementById('topology-current-name');
  const messageEl = document.getElementById('topology-message');

  const renderer = createTopologyRenderer({
    graphEl: document.getElementById('topology-graph'),
    infoEl: document.getElementById('topology-info'),
    infoNameEl: document.getElementById('topology-info-name'),
    infoMetaEl: document.getElementById('topology-info-meta'),
    infoActionsEl: document.getElementById('topology-info-actions'),
  });
  const infoCloseBtn = document.getElementById('topology-info-close');

  let currentLab = null;

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  async function loadList() {
    listEl.innerHTML = '';
    let labs;
    try {
      labs = await (await fetch('/api/labs')).json();
    } catch (err) {
      listEl.innerHTML = '<div class="dim">failed to load labs</div>';
      return;
    }

    if (labs.length === 0) {
      listEl.innerHTML = '<div class="dim">no lab files found</div>';
      return;
    }

    for (const name of labs) {
      const item = document.createElement('div');
      item.className = 'labs-list-item';
      item.textContent = name;
      item.addEventListener('click', () => selectLab(name, item));
      listEl.appendChild(item);
    }
  }

  async function selectLab(name, itemEl) {
    for (const el of listEl.querySelectorAll('.labs-list-item')) {
      el.classList.remove('active');
    }
    if (itemEl) itemEl.classList.add('active');

    currentLab = name;
    nameEl.textContent = name;
    setMessage('loading...');
    renderer.hideInfo();

    let topo;
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(name)}/topology`);
      if (!res.ok) throw new Error((await res.json()).error || 'failed to load topology');
      topo = await res.json();
    } catch (err) {
      setMessage(err.message, true);
      return;
    }

    // Best-effort: the graph still renders fine from topo alone (kind +
    // wiring) without this, just with no running/vmid/mgmt-ip overlay --
    // matches a not-yet-deployed lab, and tolerates /api/status hiccups.
    let labStatus = { deployed: false };
    try {
      const all = await (await fetch('/api/status')).json();
      labStatus = (all.labs || {})[name] || labStatus;
    } catch (err) {
      // fine, render without live overlay
    }

    renderer.renderGraph(name, topo, labStatus);
    const linkCount = (topo.links || []).length;
    setMessage(`${Object.keys(topo.nodes || {}).length} node(s), ${linkCount} link(s)`);
  }

  function open() {
    overlay.classList.remove('hidden');
    currentLab = null;
    nameEl.textContent = 'select a lab';
    setMessage('');
    renderer.hideInfo();
    loadList();
  }

  function close() {
    overlay.classList.add('hidden');
    renderer.destroy();
  }

  // Never touches the renderer -- unlike close(), leaves the last-rendered
  // graph intact so restoring doesn't need a full reload, same "minimize
  // just hides" idea as every other modal here.
  function minimize() {
    WindowManager.minimize('topology', overlay, currentLab || 'topology');
  }

  topologyBtn.addEventListener('click', () => {
    if (WindowManager.isMinimized('topology')) WindowManager.restore('topology');
    else open();
  });
  closeBtn.addEventListener('click', close);
  minimizeBtn.addEventListener('click', minimize);
  infoCloseBtn.addEventListener('click', renderer.hideInfo);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));
  window.addEventListener('resize', renderer.resize);
  window.addEventListener('wm:restored', (e) => { if (e.detail.id === 'topology') renderer.resize(); });
})();
