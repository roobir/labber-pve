// The wizard's bridge picker: existing bridges from /api/bridges, and the
// inline "+ new bridge" form. Exposes window.WizardBridges.
(function () {
  const { state, renderNicSummary } = window.WizardView;

  // Existing bridges (vmbr2/vmbr4/.../vmbr7...) discovered via /api/bridges
  // (network-manager.js's listBridges(), filtered from the node's full
  // interface list) -- backs every link block's bridge picker so a node
  // with 9-10 already hand-built bridges can be selected by name+comment
  // instead of typed blind into a text box.
  async function loadBridges() {
    try {
      state.bridges = await (await fetch('/api/bridges')).json();
    } catch (err) {
      state.bridges = [];
    }
    for (const sel of document.querySelectorAll('.wizard-link-bridge-select')) refreshBridgeSelect(sel);
  }

  function refreshBridgeSelect(sel) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const b of state.bridges) {
      const opt = document.createElement('option');
      opt.value = b.iface;
      opt.textContent = b.comments ? `${b.iface} -- ${b.comments}` : b.iface;
      sel.appendChild(opt);
    }
    if (state.bridges.some((b) => b.iface === prev)) sel.value = prev;
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

  window.WizardBridges = { load: loadBridges, refreshSelect: refreshBridgeSelect, createFromWizard: createBridgeFromWizard };
})();
