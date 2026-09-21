// Proxmox connection + template VMID settings, editable from the running
// app instead of only at deploy time via env vars -- lets a first k3s/OCP
// rollout go up with just the dashboard login secrets configured, then get
// pointed at a real Proxmox node afterward through this form. The template
// VMID table + hw-edit modal live in settings-templates.js (window.
// SettingsTemplates) -- this file owns the connection form itself, storage
// picker, and the settings modal's open/close/minimize chrome.
(function () {
  const SECRET_MASK = '••••••••';

  const overlay = document.getElementById('settings-overlay');
  const settingsBtn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('settings-close');
  const minimizeBtn = document.getElementById('settings-minimize');
  const form = document.getElementById('settings-form');
  const testBtn = document.getElementById('settings-test-btn');
  const messageEl = document.getElementById('settings-message');

  const fields = {
    host: document.getElementById('set-host'),
    node: document.getElementById('set-node'),
    tokenId: document.getElementById('set-tokenid'),
    tokenSecret: document.getElementById('set-tokensecret'),
    pveUsername: document.getElementById('set-pveusername'),
    pvePassword: document.getElementById('set-pvepassword'),
    verifyTls: document.getElementById('set-verifytls'),
    diskStorage: document.getElementById('set-diskstorage'),
    vmidStart: document.getElementById('set-vmid-start'),
    vmidEnd: document.getElementById('set-vmid-end'),
    guiDomain: document.getElementById('set-guidomain'),
    uploadRateLimitMbps: document.getElementById('set-upload-rate'),
  };

  const newStorageParent = document.getElementById('new-storage-parent');
  const newStorageId = document.getElementById('new-storage-id');
  const newStorageSubfolder = document.getElementById('new-storage-subfolder');
  const newStorageBtn = document.getElementById('new-storage-create-btn');
  const newStorageMessage = document.getElementById('new-storage-message');

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function setStorageMessage(text, isError) {
    newStorageMessage.textContent = text || '';
    newStorageMessage.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function currentPayload() {
    return {
      host: fields.host.value.trim(),
      node: fields.node.value.trim(),
      tokenId: fields.tokenId.value.trim(),
      tokenSecret: fields.tokenSecret.value, // may be SECRET_MASK if left untouched -- server resolves that
      pveUsername: fields.pveUsername.value.trim(),
      pvePassword: fields.pvePassword.value, // same SECRET_MASK handling as tokenSecret
      verifyTls: fields.verifyTls.checked,
      diskStorage: fields.diskStorage.value,
      templateVmidStart: fields.vmidStart.value,
      templateVmidEnd: fields.vmidEnd.value,
      templates: window.SettingsTemplates.getTemplatesPayload(),
      guiDomain: fields.guiDomain.value.trim(),
      uploadRateLimitMbps: fields.uploadRateLimitMbps.value,
    };
  }

  // Populates both the "disk storage" picker and the "create new storage"
  // parent dropdown from the same /api/storages call -- keeps them in sync
  // without a second round trip.
  async function loadStorages(selected) {
    let storages = [];
    try {
      const res = await fetch('/api/storages');
      if (res.ok) storages = await res.json();
    } catch (err) {
      // leave both selects empty; settings load() already surfaces a general error if this matters
    }

    fields.diskStorage.innerHTML = '<option value="">(none / Proxmox default)</option>';
    newStorageParent.innerHTML = '';
    for (const s of storages) {
      const opt1 = document.createElement('option');
      opt1.value = s.storage;
      opt1.textContent = `${s.storage} (${s.type}${s.path ? `, ${s.path}` : ''})`;
      fields.diskStorage.appendChild(opt1);

      if (s.path) {
        const opt2 = document.createElement('option');
        opt2.value = s.path;
        opt2.textContent = `${s.storage} -> ${s.path}`;
        newStorageParent.appendChild(opt2);
      }
    }
    fields.diskStorage.value = selected || '';
  }

  async function load() {
    setMessage('');
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      fields.host.value = data.host || '';
      fields.node.value = data.node || '';
      fields.tokenId.value = data.tokenId || '';
      fields.tokenSecret.value = data.tokenSecret ? SECRET_MASK : '';
      fields.pveUsername.value = data.pveUsername || '';
      fields.pvePassword.value = data.pvePassword ? SECRET_MASK : '';
      fields.verifyTls.checked = !!data.verifyTls;
      fields.vmidStart.value = data.templateVmidStart || '';
      fields.vmidEnd.value = data.templateVmidEnd || '';
      fields.guiDomain.value = data.guiDomain || '';
      fields.uploadRateLimitMbps.value = data.uploadRateLimitMbps || '';
      window.SettingsTemplates.populateTemplateValues(data.templates);
      await loadStorages(data.diskStorage);
      if (!data.configured) setMessage('Not configured yet -- fill this in and test the connection.');
    } catch (err) {
      setMessage('Failed to load settings', true);
    }
  }

  async function test() {
    setMessage('testing...');
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPayload()),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || 'connection failed');
      setMessage(`Connected -- Proxmox VE ${body.version.version}`);
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  async function save(e) {
    e.preventDefault();
    setMessage('saving...');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPayload()),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'save failed');
      setMessage('saved');
      fields.tokenSecret.value = body.tokenSecret ? SECRET_MASK : '';
      fields.pvePassword.value = body.pvePassword ? SECRET_MASK : '';
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  async function createStorage() {
    const id = newStorageId.value.trim();
    const subfolder = newStorageSubfolder.value.trim();
    const parentPath = newStorageParent.value;
    if (!id || !subfolder || !parentPath) {
      setStorageMessage('pick a parent, and fill in both the new storage ID and subfolder name', true);
      return;
    }
    setStorageMessage('creating...');
    try {
      const res = await fetch('/api/storages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, parentPath, subfolder }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to create storage');
      setStorageMessage(`created "${id}" at ${body.path}`);
      await loadStorages(id);
      newStorageId.value = '';
      newStorageSubfolder.value = '';
    } catch (err) {
      setStorageMessage(err.message, true);
    }
  }

  async function open() {
    overlay.classList.remove('hidden');
    if (window.SettingsNav) window.SettingsNav.show('connection');
    window.SettingsTemplates.hideHwEdit();
    await window.SettingsTemplates.renderTemplateRows(); // must exist before load() can populate their values
    load();
  }
  function close() {
    overlay.classList.add('hidden');
  }

  // Minimize just hides -- unlike close()/open(), it never calls load(), so
  // whatever's currently typed into the form (unsaved) survives being
  // minimized and restored, not just a normal close/reopen.
  function minimize() {
    WindowManager.minimize('settings', overlay, 'settings');
  }

  settingsBtn.addEventListener('click', () => {
    if (WindowManager.isMinimized('settings')) WindowManager.restore('settings');
    else open();
  });
  closeBtn.addEventListener('click', close);
  minimizeBtn.addEventListener('click', minimize);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));
  testBtn.addEventListener('click', test);
  form.addEventListener('submit', save);
  newStorageBtn.addEventListener('click', createStorage);
})();
