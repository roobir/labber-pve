// Template VMID table (kind -> vmid, "built"/"not built yet" badge) + the
// "edit hw" modal for an already-built golden template's non-disk config.
// Exposes `window.SettingsTemplates` so settings-connection.js's own
// load()/save()/currentPayload() can read and populate the per-kind vmid
// fields this file owns, without either file needing to know the other's
// internal DOM structure -- same window.X cross-file convention as
// labs-editor.js/labs-wizard.js.
(function () {
  const tplListEl = document.getElementById('tpl-list');
  let cachedVendors = [];

  const hwEditEl = document.getElementById('tpl-hw-edit');
  const hwEditTitle = document.getElementById('tpl-hw-edit-title');
  const hwCoresEl = document.getElementById('tpl-hw-cores');
  const hwMemoryEl = document.getElementById('tpl-hw-memory');
  const hwCpuEl = document.getElementById('tpl-hw-cpu');
  const hwBiosEl = document.getElementById('tpl-hw-bios');
  const hwMachineEl = document.getElementById('tpl-hw-machine');
  const hwScsihwEl = document.getElementById('tpl-hw-scsihw');
  const hwSerial0El = document.getElementById('tpl-hw-serial0');
  const hwSaveBtn = document.getElementById('tpl-hw-save-btn');
  const hwCancelBtn = document.getElementById('tpl-hw-cancel-btn');
  const hwMessageEl = document.getElementById('tpl-hw-message');
  let hwEditVmid = null;

  // Generated from /api/vendors (the same list the templates modal's kind
  // picker uses) rather than hardcoded rows -- a hardcoded list is exactly
  // what went stale when cisco_n9kv/cisco_c8000v were added as new device
  // kinds without anyone remembering to also add a row here, leaving no way
  // to see or edit their VMID/hardware even though the template itself
  // built and saved correctly. This can't go stale the same way again.
  async function renderTemplateRows() {
    try {
      const res = await fetch('/api/vendors');
      cachedVendors = await res.json();
    } catch (err) {
      cachedVendors = [];
    }

    tplListEl.innerHTML = '';
    for (const v of cachedVendors) {
      const row = document.createElement('div');
      row.className = 'settings-tpl-row';

      const label = document.createElement('label');
      label.append(`${v.label} `);
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `tpl-${v.kind}`;
      input.autocomplete = 'off';
      label.appendChild(input);

      const badge = document.createElement('span');
      badge.className = 'tpl-built-badge dim';
      badge.textContent = v.configured ? 'built' : 'not built yet';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tpl-edit-hw-btn';
      btn.textContent = 'edit hw';
      btn.addEventListener('click', () => openHwEdit(v.kind, v.label));

      row.append(label, badge, btn);
      tplListEl.appendChild(row);
    }
  }

  // Called by settings-connection.js's load() once /api/settings has
  // returned -- fills each kind's vmid input from the saved config.
  function populateTemplateValues(templates) {
    for (const v of cachedVendors) {
      document.getElementById(`tpl-${v.kind}`).value = (templates && templates[v.kind]) || '';
    }
  }

  // Called by settings-connection.js's currentPayload() -- reads the vmid
  // inputs this file owns back into the shape /api/settings expects.
  function getTemplatesPayload() {
    const templates = {};
    for (const v of cachedVendors) {
      templates[v.kind] = document.getElementById(`tpl-${v.kind}`).value.trim();
    }
    return templates;
  }

  function setHwMessage(text, isError) {
    hwMessageEl.textContent = text || '';
    hwMessageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  // Proxmox leaves a template's cores/memory editable after `qm template` --
  // fetches the vmid currently saved in this kind's field (not a fixed one),
  // so this always edits whatever template is actually configured right now.
  async function openHwEdit(kind, label) {
    const vmid = document.getElementById(`tpl-${kind}`).value.trim();
    if (!vmid) {
      setHwMessage(`no vmid saved for "${label}" yet -- save one first`, true);
      return;
    }
    hwEditVmid = vmid;
    hwEditEl.classList.remove('hidden');
    hwEditTitle.textContent = `${label} (vmid ${vmid})`;
    setHwMessage('loading...');
    try {
      const res = await fetch(`/api/vms/${vmid}/config`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load');
      hwCoresEl.value = data.cores || '';
      hwMemoryEl.value = data.memory || '';
      hwCpuEl.value = data.cpu || '';
      hwBiosEl.value = data.bios || 'seabios';
      hwMachineEl.value = data.machine || '';
      hwScsihwEl.value = data.scsihw || '';
      hwSerial0El.checked = !!data.serial0;
      setHwMessage('');
    } catch (err) {
      setHwMessage(err.message, true);
    }
  }

  async function saveHwEdit() {
    setHwMessage('saving...');
    try {
      const res = await fetch(`/api/vms/${hwEditVmid}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cores: hwCoresEl.value,
          memory: hwMemoryEl.value,
          cpu: hwCpuEl.value.trim(),
          bios: hwBiosEl.value,
          machine: hwMachineEl.value.trim(),
          scsihw: hwScsihwEl.value.trim(),
          serial0: hwSerial0El.checked,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'save failed');
      setHwMessage('saved');
    } catch (err) {
      setHwMessage(err.message, true);
    }
  }

  hwSaveBtn.addEventListener('click', saveHwEdit);
  hwCancelBtn.addEventListener('click', () => hwEditEl.classList.add('hidden'));

  window.SettingsTemplates = {
    renderTemplateRows,
    populateTemplateValues,
    getTemplatesPayload,
    hideHwEdit: () => hwEditEl.classList.add('hidden'),
  };
})();
