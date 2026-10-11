// A card's UUID/MAC identity panel: view, edit, and anchor the node's live
// values. Exposes window.CardIdentity.load.
(function () {
  const { escapeHtml } = window.CardUtil;

  // --- Identity panel: view/edit/anchor a node's UUID + MAC(s) --------------
  // "pinned"/"pinnedMacs" in the API response mean "present in this node's
  // .lab.yml entry" (survives the next destroy+redeploy) -- the displayed
  // uuid/macs themselves are always the *live* Proxmox values, which may or
  // may not match a pin (e.g. right after a hand-edit of the YAML, before
  // the next deploy actually applies it).
  function loadIdentityPanel(container, labFile, nodeName) {
    container.innerHTML = '<span class="dim" style="font-size:0.72rem">loading identity...</span>';
    fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/identity`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || 'failed to load identity');
        renderIdentityView(container, labFile, nodeName, body);
      })
      .catch((err) => {
        container.innerHTML = `<span class="card-ip-error">${escapeHtml(err.message)}</span>`;
      });
  }

  function renderIdentityView(container, labFile, nodeName, info) {
    const macRows =
      Object.entries(info.macs || {})
        .map(([iface, mac]) => `<div>${escapeHtml(iface)}: <code>${escapeHtml(mac)}</code>${info.pinnedMacs[iface] ? ' <span class="dim">(pinned)</span>' : ''}</div>`)
        .join('') || '<div class="dim">no MACs reported</div>';

    container.innerHTML = `
      <div class="card-identity-body">
        <div>uuid: <code>${info.uuid ? escapeHtml(info.uuid) : '(none)'}</code>${info.uuidPinned ? ' <span class="dim">(pinned)</span>' : ''}</div>
        ${macRows}
        <button type="button" class="card-identity-edit">edit</button>
        <button type="button" class="card-identity-anchor">anchor current values</button>
        <span class="card-identity-msg dim"></span>
      </div>
    `;
    container.querySelector('.card-identity-edit').addEventListener('click', () => renderIdentityEditForm(container, labFile, nodeName, info));
    container.querySelector('.card-identity-anchor').addEventListener('click', (e) => anchorIdentity(container, labFile, nodeName, e.target));
  }

  function renderIdentityEditForm(container, labFile, nodeName, info) {
    const macInputs =
      Object.keys(info.macs || {})
        .map(
          (iface) =>
            `<div>${escapeHtml(iface)}: <input type="text" class="card-identity-mac-input" data-iface="${escapeHtml(iface)}" value="${info.macs[iface] ? escapeHtml(info.macs[iface]) : ''}" placeholder="aa:bb:cc:dd:ee:ff" style="width:9.5rem" /></div>`
        )
        .join('') || '<div class="dim">no interfaces reported</div>';

    container.innerHTML = `
      <div class="card-identity-body">
        <div>uuid: <input type="text" class="card-identity-uuid-input" value="${info.uuid ? escapeHtml(info.uuid) : ''}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:14rem" /></div>
        ${macInputs}
        <button type="button" class="card-identity-save">save</button>
        <button type="button" class="card-identity-cancel">cancel</button>
        <span class="card-identity-msg dim"></span>
      </div>
    `;
    container.querySelector('.card-identity-cancel').addEventListener('click', () => renderIdentityView(container, labFile, nodeName, info));
    container.querySelector('.card-identity-save').addEventListener('click', (e) => saveIdentity(container, labFile, nodeName, e.target));
  }

  async function saveIdentity(container, labFile, nodeName, btn) {
    const msgEl = container.querySelector('.card-identity-msg');
    const uuid = container.querySelector('.card-identity-uuid-input').value.trim();
    const mac = {};
    container.querySelectorAll('.card-identity-mac-input').forEach((input) => {
      const v = input.value.trim();
      if (v) mac[input.dataset.iface] = v;
    });
    btn.disabled = true;
    msgEl.textContent = 'saving...';
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: uuid || undefined, mac: Object.keys(mac).length ? mac : undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'save failed');
      loadIdentityPanel(container, labFile, nodeName);
    } catch (err) {
      msgEl.textContent = err.message;
      btn.disabled = false;
    }
  }

  async function anchorIdentity(container, labFile, nodeName, btn) {
    const msgEl = container.querySelector('.card-identity-msg');
    btn.disabled = true;
    msgEl.textContent = 'anchoring...';
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'anchor failed');
      msgEl.textContent = '';
      loadIdentityPanel(container, labFile, nodeName);
    } catch (err) {
      msgEl.textContent = err.message;
      btn.disabled = false;
    }
  }

  window.CardIdentity = { load: loadIdentityPanel };
})();
