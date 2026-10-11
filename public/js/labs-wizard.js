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
// comment for why this cross-file convention was picked. The form itself is
// split across wizard-view.js (shared elements + NIC summary), wizard-nodes.js,
// wizard-links.js, wizard-bridges.js and wizard-payload.js; this file opens,
// closes and submits it.
(function () {
  const { els, state } = window.WizardView;
  const { editorPane, wizardPane, wizardCancelBtn, wizardCreateBtn, wizardNameEl, wizardMessageEl, nodesListEl, linksListEl, addNodeBtn, addLinkBtn } = els;
  const { collect: collectWizardPayload } = window.WizardPayload;
  const { load: loadBridges } = window.WizardBridges;
  const addNodeRow = window.WizardNodes.add;
  const addLinkRow = window.WizardLinks.add;

  function setWizardMessage(text, isError) {
    wizardMessageEl.textContent = text || '';
    wizardMessageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
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

  async function openWizard() {
    editorPane.classList.add('hidden');
    wizardPane.classList.remove('hidden');

    wizardNameEl.value = '';
    nodesListEl.innerHTML = '';
    linksListEl.innerHTML = '';
    setWizardMessage('loading device kinds...');

    try {
      const res = await fetch('/api/vendors');
      state.kinds = await res.json();
      setWizardMessage('');
    } catch (err) {
      state.kinds = [];
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
