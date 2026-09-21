// "New lab" wizard: builds a lab's node/link topology from a form (node
// kind picker + link/endpoint builder) instead of making a first-timer
// hand-write topology YAML from scratch. POSTs structured JSON to
// /api/labs (lab-manager.js's createLab(), server-side YAML serialization
// via js-yaml so formatting stays consistent) -- the existing editor in
// labs-editor.js still deals in raw YAML text for PUT /api/labs/:name,
// unchanged, so a wizard-created lab is just a normal file you can keep
// hand-editing afterward. Exposes `window.LabsWizard.open`/`.close` for
// labs-editor.js to call, and calls back into `window.LabsEditor.loadList`/
// `.selectLab` once a lab is actually created -- see labs-editor.js's own
// comment for why this cross-file convention was picked.
(function () {
  const editorPane = document.getElementById('labs-editor-pane');
  const wizardPane = document.getElementById('labs-wizard-pane');
  const wizardCancelBtn = document.getElementById('wizard-cancel-btn');
  const wizardCreateBtn = document.getElementById('wizard-create-btn');
  const wizardNameEl = document.getElementById('wizard-lab-name');
  const wizardMessageEl = document.getElementById('wizard-message');
  const nodesListEl = document.getElementById('wizard-nodes-list');
  const linksListEl = document.getElementById('wizard-links-list');
  const addNodeBtn = document.getElementById('wizard-add-node-btn');
  const addLinkBtn = document.getElementById('wizard-add-link-btn');
  const nicSummaryEl = document.getElementById('wizard-nic-summary');

  const NIC_OPTIONS = Array.from({ length: 10 }, (_, i) => `<option value="net${i}">net${i}</option>`).join('');

  let cachedKinds = [];
  let cachedBridges = [];

  function setWizardMessage(text, isError) {
    wizardMessageEl.textContent = text || '';
    wizardMessageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function currentNodeNames() {
    return Array.from(document.querySelectorAll('.wizard-node-name')).map((i) => i.value.trim()).filter(Boolean);
  }

  // Endpoint "which node" selects are rebuilt from whatever node names
  // currently exist rather than kept in sync incrementally -- simplest way
  // to handle rows being added/removed/renamed in any order. Re-run on
  // every node add/remove/rename and every new endpoint row.
  function refreshEndpointNodeSelects() {
    const names = currentNodeNames();
    document.querySelectorAll('.wizard-endpoint-node').forEach((sel) => {
      const prev = sel.value;
      sel.innerHTML = '';
      for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
      }
      if (names.includes(prev)) sel.value = prev;
    });
  }

  // Live view of every node's NIC slots (net0..netN-1, count from the
  // node's vendor profile hw.nics) and which link -- if any -- wires each
  // one. Recomputed from the DOM on every wizard change rather than tracked
  // incrementally, same reasoning as refreshEndpointNodeSelects() -- simplest
  // way to stay correct regardless of what order rows get added/removed/
  // edited in. Anything shown "unassigned" here is exactly what deploy()
  // leaves link_down on the golden template's placeholder vmbr0, instead of
  // silently bridging an unused NIC onto it (see lab-deploy.js's deploy()
  // step 3b) -- this is what makes that behavior visible before you deploy.
  function renderNicSummary() {
    if (!nicSummaryEl) return;

    const wiredByNode = {}; // node -> { iface: "label" }
    for (const block of linksListEl.children) {
      const linkName = block.querySelector('.wizard-link-name').value.trim() || '(unnamed link)';
      const isExternal = block.querySelector('.wizard-link-external').checked;
      const bridgeLabel = isExternal
        ? block.querySelector('.wizard-link-bridge-select').value || '(no bridge chosen)'
        : 'auto-provisioned bridge';
      for (const erow of block.querySelectorAll('.wizard-endpoints > .wizard-row')) {
        const node = erow.querySelector('.wizard-endpoint-node').value;
        const iface = erow.querySelector('.wizard-endpoint-iface').value;
        if (!node) continue;
        (wiredByNode[node] ||= {})[iface] = `${linkName} -> ${bridgeLabel}`;
      }
    }

    nicSummaryEl.innerHTML = '';
    for (const row of nodesListEl.children) {
      const name = row.querySelector('.wizard-node-name').value.trim();
      const kind = row.querySelector('.wizard-node-kind').value;
      if (!name) continue;
      const kindInfo = cachedKinds.find((k) => k.kind === kind);
      const nicCount = kindInfo && kindInfo.hw ? kindInfo.hw.nics : 0;

      const nodeBlock = document.createElement('div');
      nodeBlock.className = 'wizard-nic-node';
      const title = document.createElement('div');
      title.className = 'wizard-nic-node-title';
      title.textContent = name;
      nodeBlock.appendChild(title);

      for (let i = 0; i < nicCount; i++) {
        const iface = `net${i}`;
        const wired = (wiredByNode[name] || {})[iface];
        const line = document.createElement('div');
        line.className = `wizard-nic-line ${wired ? 'wired' : 'unassigned'}`;
        line.textContent = wired ? `${iface} -- ${wired}` : `${iface} -- unassigned (deployed disconnected)`;
        nodeBlock.appendChild(line);
      }
      nicSummaryEl.appendChild(nodeBlock);
    }
  }

  function addNodeRow() {
    const idx = nodesListEl.children.length + 1;
    const row = document.createElement('div');
    row.className = 'wizard-row';
    row.innerHTML = `
      <input type="text" class="wizard-node-name" placeholder="node${idx}" value="node${idx}" />
      <select class="wizard-node-kind"></select>
      <select class="wizard-node-version" title="which built version of this kind to clone from (blank = current default)"></select>
      <input type="number" class="wizard-node-cores" placeholder="cores" min="1" style="width:4.5rem" title="override this node's vCPU count (blank = template default)" />
      <input type="number" class="wizard-node-memory" placeholder="memory MB" min="1" style="width:6.5rem" title="override this node's RAM in MB (blank = template default)" />
      <label title="independent disk instead of a linked clone -- needed if this node's disk must survive/diverge separately from the template"><input type="checkbox" class="wizard-node-full" /> full clone</label>
      <button type="button" class="wizard-row-remove">remove</button>
    `;
    const kindSel = row.querySelector('.wizard-node-kind');
    const versionSel = row.querySelector('.wizard-node-version');
    for (const k of cachedKinds) {
      const opt = document.createElement('option');
      opt.value = k.kind;
      opt.textContent = k.configured ? k.label : `${k.label} (no template yet)`;
      kindSel.appendChild(opt);
    }

    // Repopulated on every kind change -- a version label only makes sense
    // relative to whichever kind is currently selected. Blank/"(default)"
    // is always first and means "omit `version:` entirely", i.e. today's
    // behavior of following whatever `templates[kind]` currently points
    // at, same as leaving cores/memory blank means "use the template's own".
    function updateVersionOptions() {
      const kindInfo = cachedKinds.find((k) => k.kind === kindSel.value);
      const versions = (kindInfo && kindInfo.versions) || {};
      versionSel.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '(default)';
      versionSel.appendChild(defaultOpt);
      for (const [label, vmid] of Object.entries(versions)) {
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = `${label} (vmid ${vmid})`;
        versionSel.appendChild(opt);
      }
    }
    updateVersionOptions();

    // Placeholder text mirrors the selected kind's actual template default
    // (cores/memory) purely for reference -- leaving the field blank at
    // deploy time means "use whatever the template already has", not "use
    // this displayed number", so this never needs to be kept in sync with
    // an explicit value, just redrawn whenever the kind selection changes.
    const coresEl = row.querySelector('.wizard-node-cores');
    const memoryEl = row.querySelector('.wizard-node-memory');
    function updateHwPlaceholders() {
      const kindInfo = cachedKinds.find((k) => k.kind === kindSel.value);
      const hw = kindInfo && kindInfo.hw;
      coresEl.placeholder = hw ? `cores (${hw.cores})` : 'cores';
      memoryEl.placeholder = hw ? `memory MB (${hw.memory})` : 'memory MB';
    }
    updateHwPlaceholders();

    row.querySelector('.wizard-node-name').addEventListener('input', () => {
      refreshEndpointNodeSelects();
      renderNicSummary();
    });
    kindSel.addEventListener('change', () => {
      updateHwPlaceholders();
      updateVersionOptions();
      renderNicSummary();
    });
    row.querySelector('.wizard-row-remove').addEventListener('click', () => {
      row.remove();
      refreshEndpointNodeSelects();
      renderNicSummary();
    });
    nodesListEl.appendChild(row);
    refreshEndpointNodeSelects();
    renderNicSummary();
  }

  function addLinkRow() {
    const idx = linksListEl.children.length + 1;
    const block = document.createElement('div');
    block.className = 'wizard-link-block';
    block.innerHTML = `
      <div class="wizard-link-top">
        <input type="text" class="wizard-link-name" placeholder="link${idx}" value="link${idx}" />
        <label><input type="checkbox" class="wizard-link-external" /> external (reuse existing bridge)</label>
        <select class="wizard-link-bridge-select hidden"></select>
        <button type="button" class="wizard-link-bridge-new-btn hidden">+ new bridge</button>
        <button type="button" class="wizard-row-remove">remove link</button>
      </div>
      <div class="wizard-link-bridge-create hidden">
        <input type="text" class="wizard-link-bridge-new-iface" placeholder="vmbr8" style="width:6rem" />
        <input type="text" class="wizard-link-bridge-new-comment" placeholder="comment (optional)" style="width:12rem" />
        <button type="button" class="wizard-link-bridge-create-btn">create</button>
        <span class="wizard-link-bridge-create-msg dim"></span>
      </div>
      <div class="wizard-endpoints"></div>
      <button type="button" class="wizard-add-btn wizard-add-endpoint-btn">+ add endpoint</button>
    `;

    const externalCb = block.querySelector('.wizard-link-external');
    const bridgeSelect = block.querySelector('.wizard-link-bridge-select');
    const bridgeNewBtn = block.querySelector('.wizard-link-bridge-new-btn');
    const bridgeCreateEl = block.querySelector('.wizard-link-bridge-create');
    const endpointsEl = block.querySelector('.wizard-endpoints');
    const addEndpointBtn = block.querySelector('.wizard-add-endpoint-btn');

    // Endpoints (which node:interface actually gets wired to this link's
    // bridge) apply the same way whether the bridge is external or
    // auto-provisioned -- only the bridge *picker* itself is external-only.
    // This used to hide the whole endpoints section for external links,
    // which meant there was never any way to say which interface actually
    // attaches to an external bridge -- the link would be created but
    // nothing would ever get wired to it.
    function syncExternal() {
      bridgeSelect.classList.toggle('hidden', !externalCb.checked);
      bridgeNewBtn.classList.toggle('hidden', !externalCb.checked);
      if (!externalCb.checked) bridgeCreateEl.classList.add('hidden');
    }
    externalCb.addEventListener('change', () => {
      syncExternal();
      renderNicSummary();
    });
    syncExternal();
    refreshBridgeSelect(bridgeSelect);
    bridgeSelect.addEventListener('change', renderNicSummary);
    block.querySelector('.wizard-link-name').addEventListener('input', renderNicSummary);

    bridgeNewBtn.addEventListener('click', () => bridgeCreateEl.classList.toggle('hidden'));
    bridgeCreateEl.querySelector('.wizard-link-bridge-create-btn').addEventListener('click', () =>
      createBridgeFromWizard(block)
    );

    function addEndpointRow() {
      const erow = document.createElement('div');
      erow.className = 'wizard-row';
      erow.innerHTML = `
        <select class="wizard-endpoint-node"></select>
        <select class="wizard-endpoint-iface">${NIC_OPTIONS}</select>
        <button type="button" class="wizard-row-remove">remove</button>
      `;
      erow.querySelector('.wizard-row-remove').addEventListener('click', () => {
        erow.remove();
        renderNicSummary();
      });
      erow.querySelector('.wizard-endpoint-node').addEventListener('change', renderNicSummary);
      erow.querySelector('.wizard-endpoint-iface').addEventListener('change', renderNicSummary);
      endpointsEl.appendChild(erow);
      refreshEndpointNodeSelects();

      // A brand-new select has no prior value for refreshEndpointNodeSelects()
      // to preserve, so it falls back to the browser default (first option,
      // i.e. always the same node) -- every endpoint in a link defaulting to
      // node1 is exactly what produced a real "link1: node1/net0 x3" lab
      // file. Default instead to the first node not already used by another
      // endpoint *in this same link*, so a fresh link's endpoints start out
      // pointing at different nodes whenever that's possible.
      const sel = erow.querySelector('.wizard-endpoint-node');
      const usedHere = new Set(
        Array.from(endpointsEl.querySelectorAll('.wizard-endpoint-node'))
          .filter((s) => s !== sel)
          .map((s) => s.value)
      );
      const firstUnused = Array.from(sel.options).map((o) => o.value).find((v) => !usedHere.has(v));
      if (firstUnused) sel.value = firstUnused;
      renderNicSummary();
    }
    addEndpointBtn.addEventListener('click', addEndpointRow);
    block.querySelector('.wizard-link-top .wizard-row-remove').addEventListener('click', () => {
      block.remove();
      renderNicSummary();
    });

    linksListEl.appendChild(block);
    addEndpointRow();
    addEndpointRow(); // most links are point-to-point -- seed 2, add/remove as needed
  }

  function collectWizardPayload() {
    const name = wizardNameEl.value.trim();
    if (!name) throw new Error('lab name is required');

    const nodes = {};
    for (const row of nodesListEl.children) {
      const nm = row.querySelector('.wizard-node-name').value.trim();
      const kind = row.querySelector('.wizard-node-kind').value;
      const version = row.querySelector('.wizard-node-version').value; // '' = "(default)" -- omit the field entirely
      if (!nm) throw new Error('every node needs a name');
      if (nodes[nm]) throw new Error(`duplicate node name "${nm}"`);

      const coresStr = row.querySelector('.wizard-node-cores').value.trim();
      const memoryStr = row.querySelector('.wizard-node-memory').value.trim();
      const full = row.querySelector('.wizard-node-full').checked;
      const cores = coresStr ? parseInt(coresStr, 10) : undefined;
      const memory = memoryStr ? parseInt(memoryStr, 10) : undefined;
      if (coresStr && (!Number.isInteger(cores) || cores <= 0)) throw new Error(`node "${nm}": cores must be a positive integer`);
      if (memoryStr && (!Number.isInteger(memory) || memory <= 0)) throw new Error(`node "${nm}": memory (MB) must be a positive integer`);

      nodes[nm] = {
        kind,
        ...(version ? { version } : {}),
        ...(cores ? { cores } : {}),
        ...(memory ? { memory } : {}),
        ...(full ? { full: true } : {}),
      };
    }
    if (Object.keys(nodes).length === 0) throw new Error('add at least one node');

    const links = [];
    for (const block of linksListEl.children) {
      const linkName = block.querySelector('.wizard-link-name').value.trim();
      if (!linkName) throw new Error('every link needs a name');

      // Endpoints apply the same way regardless of external -- an external
      // link with zero endpoints would create the bridge reference but wire
      // nothing to it, which is never actually what's wanted.
      const endpoints = [];
      const seen = new Set();
      for (const erow of block.querySelectorAll('.wizard-endpoints > .wizard-row')) {
        const node = erow.querySelector('.wizard-endpoint-node').value;
        const iface = erow.querySelector('.wizard-endpoint-iface').value;
        if (!node) throw new Error(`link "${linkName}" has an endpoint with no node to pick (add a node first)`);
        const key = `${node}:${iface}`;
        if (seen.has(key)) throw new Error(`link "${linkName}" has the same endpoint (${node}:${iface}) more than once -- pick a different node or interface for one of them`);
        seen.add(key);
        endpoints.push({ node, interface: iface });
      }

      if (block.querySelector('.wizard-link-external').checked) {
        const bridge = block.querySelector('.wizard-link-bridge-select').value;
        if (!bridge) throw new Error(`link "${linkName}" is external but no bridge exists to pick -- create one first`);
        if (endpoints.length < 1) throw new Error(`link "${linkName}" needs at least 1 endpoint (which interface attaches to ${bridge})`);
        links.push({ name: linkName, external: true, bridge, endpoints });
      } else {
        if (endpoints.length < 2) throw new Error(`link "${linkName}" needs at least 2 endpoints`);
        links.push({ name: linkName, endpoints });
      }
    }

    return { name, nodes, links };
  }

  async function createLabFromWizard() {
    let payload;
    try {
      payload = collectWizardPayload();
    } catch (err) {
      setWizardMessage(err.message, true);
      return;
    }

    setWizardMessage('creating...');
    try {
      const res = await fetch('/api/labs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to create lab');
      closeWizard();
      await window.LabsEditor.loadList();
      await window.LabsEditor.selectLab(body.name);
    } catch (err) {
      setWizardMessage(err.message, true);
    }
  }

  // Existing bridges (vmbr2/vmbr4/.../vmbr7...) discovered via /api/bridges
  // (network-manager.js's listBridges(), filtered from the node's full
  // interface list) -- backs every link block's bridge picker so a node
  // with 9-10 already hand-built bridges can be selected by name+comment
  // instead of typed blind into a text box.
  async function loadBridges() {
    try {
      cachedBridges = await (await fetch('/api/bridges')).json();
    } catch (err) {
      cachedBridges = [];
    }
    for (const sel of document.querySelectorAll('.wizard-link-bridge-select')) refreshBridgeSelect(sel);
  }

  function refreshBridgeSelect(sel) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const b of cachedBridges) {
      const opt = document.createElement('option');
      opt.value = b.iface;
      opt.textContent = b.comments ? `${b.iface} -- ${b.comments}` : b.iface;
      sel.appendChild(opt);
    }
    if (cachedBridges.some((b) => b.iface === prev)) sel.value = prev;
  }

  async function createBridgeFromWizard(block) {
    const iface = block.querySelector('.wizard-link-bridge-new-iface').value.trim();
    const comments = block.querySelector('.wizard-link-bridge-new-comment').value.trim();
    const msgEl = block.querySelector('.wizard-link-bridge-create-msg');
    msgEl.textContent = 'creating...';
    try {
      const res = await fetch('/api/bridges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iface, comments }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to create bridge');
      await loadBridges();
      block.querySelector('.wizard-link-bridge-select').value = iface;
      block.querySelector('.wizard-link-bridge-create').classList.add('hidden');
      msgEl.textContent = '';
      renderNicSummary();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  async function openWizard() {
    editorPane.classList.add('hidden');
    wizardPane.classList.remove('hidden');

    wizardNameEl.value = '';
    nodesListEl.innerHTML = '';
    linksListEl.innerHTML = '';
    setWizardMessage('loading device kinds...');

    try {
      const res = await fetch('/api/vendors');
      cachedKinds = await res.json();
      setWizardMessage('');
    } catch (err) {
      cachedKinds = [];
      setWizardMessage('failed to load device kinds', true);
    }
    await loadBridges();
    addNodeRow();
  }

  function closeWizard() {
    wizardPane.classList.add('hidden');
    editorPane.classList.remove('hidden');
  }

  wizardCancelBtn.addEventListener('click', closeWizard);
  wizardCreateBtn.addEventListener('click', createLabFromWizard);
  addNodeBtn.addEventListener('click', addNodeRow);
  addLinkBtn.addEventListener('click', addLinkRow);

  window.LabsWizard = { open: openWizard, close: closeWizard };
})();
