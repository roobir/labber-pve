// One node row of the new-lab wizard (name, kind, version, hw overrides).
// Exposes window.WizardNodes.add.
(function () {
  const { els, state, refreshEndpointNodeSelects, renderNicSummary } = window.WizardView;
  const { nodesListEl } = els;

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
    for (const k of state.kinds) {
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
      const kindInfo = state.kinds.find((k) => k.kind === kindSel.value);
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
      const kindInfo = state.kinds.find((k) => k.kind === kindSel.value);
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

  window.WizardNodes = { add: addNodeRow };
})();
