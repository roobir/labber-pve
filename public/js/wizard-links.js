// One link block of the new-lab wizard (name, external bridge picker, its
// endpoints). Exposes window.WizardLinks.add.
(function () {
  const { els, refreshEndpointNodeSelects, renderNicSummary } = window.WizardView;
  const { linksListEl } = els;
  const { refreshSelect: refreshBridgeSelect, createFromWizard: createBridgeFromWizard } = window.WizardBridges;

  const NIC_OPTIONS = Array.from({ length: 10 }, (_, i) => `<option value="net${i}">net${i}</option>`).join('');

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

  window.WizardLinks = { add: addLinkRow };
})();
