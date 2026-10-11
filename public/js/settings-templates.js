// Settings -> Templates: the template editor. For every device kind, its
// versions (label -> Proxmox template vmid), which one is the default, which
// labs use each, and actions on them -- including adding a template that was
// built by hand in Proxmox. Talks to /api/template-catalog (see
// lib/template-catalog.js); only labber-pve's mapping changes, never a VM.
(function () {
  const listEl = document.getElementById('tpl-list');
  const expanded = new Set(); // kinds left open across re-renders
  let data = null;

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'onclick') el.addEventListener('click', v);
      else if (k === 'class') el.className = v;
      else el[k] = v;
    }
    el.append(...children.filter((c) => c !== null && c !== undefined));
    return el;
  }

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status, usedBy: out.usedBy });
    return out;
  }

  const base = (kind) => `/api/template-catalog/${encodeURIComponent(kind)}/versions`;

  // Runs an edit; on success re-renders from the returned catalog, otherwise
  // shows the error under that kind. `confirmForce` turns an "in use" refusal
  // into a question, then retries with force.
  async function edit(kind, msgEl, method, url, body, confirmForce) {
    try {
      data = await call(method, url, body);
      render();
    } catch (err) {
      if (err.status === 409 && err.usedBy && confirmForce && window.confirm(`${err.message}\n\nDo it anyway?`)) {
        return edit(kind, msgEl, method, confirmForce(url), body && { ...body, force: true }, null);
      }
      msgEl.textContent = err.message;
    }
  }

  function versionRow(k, v, msgEl, checkEl) {
    const status = v.inProxmox === false ? h('span', { class: 'tpl-bad' }, ' missing in Proxmox')
      : v.isTemplate === false ? h('span', { class: 'tpl-bad' }, ' not a template') : null;
    const labelCell = h('td', {}, v.label, v.isDefault ? h('span', { class: 'tpl-default', title: 'default' }, ' ★') : null);
    const url = `${base(k.kind)}/${encodeURIComponent(v.label)}`;
    const rename = () => {
      const input = h('input', { type: 'text', value: v.label, class: 'tpl-rename-input' });
      const ok = h('button', { type: 'button', onclick: () => edit(k.kind, msgEl, 'POST', `${url}/rename`, { newLabel: input.value }, (u) => u) }, 'ok');
      labelCell.replaceChildren(input, ok, h('button', { type: 'button', onclick: render }, 'cancel'));
      input.focus();
    };
    const check = async () => {
      checkEl.replaceChildren(h('div', { class: 'dim' }, `checking ${v.vmid}...`));
      try {
        const r = await call('GET', `/api/template-catalog/${encodeURIComponent(k.kind)}/check?vmid=${v.vmid}`);
        checkEl.replaceChildren(h('div', { class: 'dim' }, `${v.label} (vmid ${v.vmid}):`), ...r.checks.map((c) => h('div', { class: `tpl-check-${c.level}` }, `${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.text}`)));
      } catch (err) {
        checkEl.replaceChildren(h('div', { class: 'tpl-check-error' }, err.message));
      }
    };
    const remove = () => {
      if (!window.confirm(`Remove version "${v.label}" (vmid ${v.vmid}) from labber-pve? The template stays in Proxmox.`)) return;
      edit(k.kind, msgEl, 'DELETE', url, null, (u) => `${u}?force=1`);
    };
    return h('tr', {},
      labelCell,
      h('td', {}, `${v.vmid}`, v.name ? h('span', { class: 'dim' }, ` · ${v.name}`) : null, status),
      h('td', { class: 'dim', title: v.usedBy.join('\n') }, v.usedBy.length ? `${v.usedBy.length} node(s)` : '--'),
      h('td', { class: 'tpl-actions' },
        v.isDefault ? null : h('button', { type: 'button', onclick: () => edit(k.kind, msgEl, 'POST', `${url}/default`) }, 'make default'),
        h('button', { type: 'button', onclick: rename }, 'rename'),
        h('button', { type: 'button', onclick: check }, 'check'),
        h('button', { type: 'button', onclick: () => window.TemplateHw.open(v.vmid, `${k.label} ${v.label} (vmid ${v.vmid})`) }, 'edit hw'),
        h('button', { type: 'button', onclick: remove }, 'remove')));
  }

  // Which kind/version already maps each Proxmox template, for the picker.
  function mappedBy() {
    const m = {};
    for (const k of data.kinds) for (const v of k.versions) (m[v.vmid] ||= []).push(`${k.label} ${v.label}`);
    return m;
  }

  function addForm(k, msgEl) {
    const label = h('input', { type: 'text', placeholder: 'version, e.g. 17.5', class: 'tpl-add-label' });
    const used = mappedBy();
    const pick = h('select', { class: 'tpl-add-vmid' }, h('option', { value: '' }, data.proxmox.templates.length ? 'choose a Proxmox template...' : 'no templates found in Proxmox'),
      ...data.proxmox.templates.map((t) => h('option', { value: String(t.vmid) }, `${t.vmid} · ${t.name}${used[t.vmid] ? `  (${used[t.vmid].join(', ')})` : ''}`)));
    const makeDefault = h('input', { type: 'checkbox', class: 'tpl-add-default' });
    const add = () => edit(k.kind, msgEl, 'POST', base(k.kind), { label: label.value, vmid: pick.value, makeDefault: makeDefault.checked });
    return h('div', { class: 'tpl-add' }, label, pick, h('label', { class: 'checkbox-label' }, makeDefault, ' make default'), h('button', { type: 'button', onclick: add }, 'add version'));
  }

  function kindBlock(k) {
    const def = k.versions.find((v) => v.isDefault);
    const problems = k.versions.filter((v) => v.inProxmox === false || v.isTemplate === false).length;
    const open = expanded.has(k.kind);
    const msgEl = h('div', { class: 'labs-message tpl-msg' });
    const checkEl = h('div', { class: 'tpl-check' });
    const head = h('div', { class: 'tpl-kind-head', onclick: () => { if (open) expanded.delete(k.kind); else expanded.add(k.kind); render(); } },
      h('span', { class: 'tpl-caret' }, open ? '▾ ' : '▸ '), h('span', { class: 'tpl-kind-name' }, k.label),
      h('span', { class: 'dim' }, def ? `  default ${def.label} (vmid ${def.vmid})` : '  no template yet'),
      h('span', { class: 'dim' }, k.versions.length > 1 ? ` · ${k.versions.length} versions` : ''),
      problems ? h('span', { class: 'tpl-bad' }, ` · ${problems} problem(s)`) : null);
    if (!open) return h('div', { class: 'tpl-kind' }, head);
    const table = h('table', { class: 'tpl-versions' }, h('tr', {}, h('th', {}, 'version'), h('th', {}, 'template'), h('th', {}, 'used by'), h('th', {})),
      ...k.versions.map((v) => versionRow(k, v, msgEl, checkEl)));
    return h('div', { class: 'tpl-kind open' }, head, k.versions.length ? table : h('div', { class: 'dim' }, 'no versions yet -- build one from the templates window, or add one below'), checkEl, addForm(k, msgEl), msgEl);
  }

  function render() {
    const note = data.proxmox.ok ? null : h('div', { class: 'tpl-bad' }, `Can't reach Proxmox (${data.proxmox.error}) -- showing labber-pve's mapping only.`);
    listEl.replaceChildren(...[note, ...data.kinds.map(kindBlock)].filter(Boolean));
  }

  async function renderTemplateRows() {
    listEl.replaceChildren(h('div', { class: 'dim' }, 'loading templates...'));
    try {
      data = await call('GET', '/api/template-catalog');
      render();
    } catch (err) {
      listEl.replaceChildren(h('div', { class: 'tpl-bad' }, `failed to load templates: ${err.message}`));
    }
  }

  window.SettingsTemplates = {
    renderTemplateRows,
    // The editor saves its own changes; the Settings form's save leaves template mappings alone.
    populateTemplateValues: () => {},
    getTemplatesPayload: () => undefined,
    hideHwEdit: () => window.TemplateHw.hide(),
  };
})();
