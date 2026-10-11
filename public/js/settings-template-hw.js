// A template's hardware editor (cores, memory, CPU, BIOS, machine, SCSI
// controller, serial console) -- opened from a version row in the template
// editor (settings-templates.js). Proxmox keeps a template's non-disk config
// editable after `qm template`; only the disk itself becomes read-only.
(function () {
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

  function setHwMessage(text, isError) {
    hwMessageEl.textContent = text || '';
    hwMessageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  // Proxmox leaves a template's cores/memory editable after `qm template` --
  // fetches the vmid currently saved in this kind's field (not a fixed one),
  // so this always edits whatever template is actually configured right now.
  async function openHwEdit(vmid, title) {
    hwEditVmid = vmid;
    hwEditEl.classList.remove('hidden');
    hwEditTitle.textContent = title;
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

  window.TemplateHw = { open: openHwEdit, hide: () => hwEditEl.classList.add('hidden') };
})();
