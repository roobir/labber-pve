// The new-lab wizard's shared view layer: its DOM elements, the cached device
// kinds / bridges the wizard rows read, and the two things that keep the
// form consistent as rows change -- the endpoint node pickers and the live
// NIC summary. Exposes window.WizardView. Part of labs-wizard.js (see there).
(function () {
  const els = {
    editorPane: document.getElementById('labs-editor-pane'),
    wizardPane: document.getElementById('labs-wizard-pane'),
    wizardCancelBtn: document.getElementById('wizard-cancel-btn'),
    wizardCreateBtn: document.getElementById('wizard-create-btn'),
    wizardNameEl: document.getElementById('wizard-lab-name'),
    wizardMessageEl: document.getElementById('wizard-message'),
    nodesListEl: document.getElementById('wizard-nodes-list'),
    linksListEl: document.getElementById('wizard-links-list'),
    addNodeBtn: document.getElementById('wizard-add-node-btn'),
    addLinkBtn: document.getElementById('wizard-add-link-btn'),
    nicSummaryEl: document.getElementById('wizard-nic-summary'),
  };
  const { nodesListEl, linksListEl, nicSummaryEl } = els;

  // Loaded when the wizard opens (see labs-wizard.js / wizard-bridges.js).
  const state = { kinds: [], bridges: [] };

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
      const kindInfo = state.kinds.find((k) => k.kind === kind);
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

  window.WizardView = { els, state, refreshEndpointNodeSelects, renderNicSummary };
})();
