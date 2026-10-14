// Labs window: export the selected lab as a file, duplicate it as a new lab,
// and import a lab file as a new lab (lib/lab-transfer.js). Export offers an
// exact copy (a backup) or a clean copy without node uuid / mac pins and mgmt
// IPs (to run a second copy next to the original); duplicate makes such a
// clean copy straight away. Import and duplicate never replace a lab: a taken
// name asks for another one. Import warnings (runbooks, Store entries or
// templates this labber lacks) are shown once the new lab is open.
(function () {
  const exportBtn = document.getElementById('labs-export-btn');
  const duplicateBtn = document.getElementById('labs-duplicate-btn');
  const importBtn = document.getElementById('labs-import-btn');
  const fileInput = document.getElementById('labs-import-file');
  if (!exportBtn || !duplicateBtn || !importBtn || !fileInput) return;

  const MAX_BYTES = 1024 * 1024;
  let menu = null;

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  // A plain link click downloads through the browser's own session cookie.
  function download(clean) {
    closeMenu();
    const lab = window.LabsEditor.current();
    if (!lab) return;
    const link = document.createElement('a');
    link.href = `/api/labs/${encodeURIComponent(lab)}/export${clean ? '?clean=1' : ''}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    window.LabsEditor.setMessage(`exported ${clean ? 'a clean copy of ' : ''}the saved ${lab} (unsaved edits are not included)`);
  }

  function option(label, hint, clean) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = hint;
    btn.addEventListener('click', () => download(clean));
    return btn;
  }

  function openMenu() {
    if (menu) return closeMenu();
    menu = document.createElement('div');
    menu.className = 'labs-export-menu';
    menu.append(
      option('exact copy', 'the saved file as it is -- a backup, or this lab moved to another labber', false),
      option('clean copy', 'without node uuid / mac pins and mgmt IPs -- to run a second copy next to this one', true)
    );
    exportBtn.after(menu);
  }

  const baseName = (fileName) => fileName.replace(/\.(lab\.)?ya?ml$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-');

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Calls attempt(name) until the name is free (no 409), asking the user for
  // another one each time -> the last reply, or null if they gave up.
  async function withFreeName(name, attempt, verb) {
    for (;;) {
      window.LabsEditor.setMessage(`${verb} as ${name}…`);
      const reply = await attempt(name);
      if (reply.status !== 409) return reply;
      name = window.prompt(`${reply.body.error} -- choose another name:`, `${name}-2`);
      if (!name) return null;
    }
  }

  async function openNew(name) {
    await window.LabsEditor.loadList();
    await window.LabsEditor.selectLab(name);
  }

  async function importFile(file) {
    const say = window.LabsEditor.setMessage;
    if (file.size > MAX_BYTES) return say('a lab file is at most 1 MB', true);
    const text = await file.text();
    const reply = await withFreeName(baseName(file.name), (name) => post('/api/labs/import', { name, text }), 'importing');
    if (!reply) return say('import cancelled');
    if (reply.status !== 200) return say(reply.body.error || `import failed (${reply.status})`, true);
    await openNew(reply.body.name);
    const warnings = reply.body.warnings || [];
    return say(warnings.length
      ? `imported as ${reply.body.name} -- before deploying it, add what this labber is missing:\n• ${warnings.join('\n• ')}`
      : `imported as ${reply.body.name}`, warnings.length > 0);
  }

  async function duplicate() {
    const say = window.LabsEditor.setMessage;
    const lab = window.LabsEditor.current();
    if (!lab) return;
    const first = window.prompt(`Duplicate the saved ${lab} as (node uuid / mac pins and mgmt IPs are left out):`, `${baseName(lab)}-copy`);
    if (!first) return;
    const reply = await withFreeName(first, (name) => post(`/api/labs/${encodeURIComponent(lab)}/duplicate`, { name }), 'duplicating');
    if (!reply) return say('duplicate cancelled');
    if (reply.status !== 200) return say(reply.body.error || `duplicate failed (${reply.status})`, true);
    await openNew(reply.body.name);
    return say(`${reply.body.name} is a copy of ${lab}`);
  }

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu();
  });
  document.addEventListener('click', (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  });
  duplicateBtn.addEventListener('click', () => duplicate().catch((err) => window.LabsEditor.setMessage(err.message, true)));
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so choosing the same file again still fires `change`
    if (file) importFile(file).catch((err) => window.LabsEditor.setMessage(err.message, true));
  });
})();
