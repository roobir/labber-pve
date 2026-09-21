// API relay enable toggle + bearer-token management, inside the Settings ->
// Public API panel (below the existing stats-API section from
// settings-api.js). Own module/own load, same pattern as settings-users.js.
(function () {
  const settingsBtn = document.getElementById('settings-btn');

  const enabledForm = document.getElementById('api-relay-settings-form');
  const enabledEl = document.getElementById('relay-enabled');
  const enabledMsgEl = document.getElementById('relay-settings-message');

  const listEl = document.getElementById('relay-tokens-list');
  const addForm = document.getElementById('relay-token-add-form');
  const labelEl = document.getElementById('relay-token-label');
  const scopeEl = document.getElementById('relay-token-scope');
  const newTokenEl = document.getElementById('relay-token-new');
  const listMsgEl = document.getElementById('relay-tokens-message');

  function setMsg(el, text, isError) {
    el.textContent = text || '';
    el.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  async function loadEnabled() {
    setMsg(enabledMsgEl, '');
    try {
      const res = await fetch('/api/settings/api');
      if (!res.ok) return;
      const cfg = await res.json();
      enabledEl.checked = !!cfg.relayEnabled;
    } catch (err) {
      // leave whatever was last loaded
    }
  }

  enabledForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg(enabledMsgEl, 'saving...');
    try {
      const res = await fetch('/api/settings/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relayEnabled: enabledEl.checked }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to save');
      setMsg(enabledMsgEl, 'saved');
    } catch (err) {
      setMsg(enabledMsgEl, err.message, true);
    }
  });

  async function loadTokens() {
    listEl.innerHTML = '';
    let tokens;
    try {
      const res = await fetch('/api/relay-tokens');
      if (!res.ok) throw new Error('failed to load tokens');
      tokens = await res.json();
    } catch (err) {
      listEl.innerHTML = '<div class="users-list-empty">failed to load tokens</div>';
      return;
    }

    if (tokens.length === 0) {
      listEl.innerHTML = '<div class="users-list-empty">no tokens</div>';
      return;
    }

    for (const { id, label, labScope, lastUsedAt } of tokens) {
      const row = document.createElement('div');
      row.className = 'users-list-row';

      const infoEl = document.createElement('span');
      const scopeText = labScope ? `scope: ${labScope}` : 'scope: any lab';
      const usedText = lastUsedAt ? `last used ${new Date(lastUsedAt).toLocaleString()}` : 'never used';
      infoEl.textContent = `${label} (${scopeText}, ${usedText})`;
      row.appendChild(infoEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'danger';
      removeBtn.textContent = 'revoke';
      removeBtn.addEventListener('click', () => revokeToken(id, label));
      row.appendChild(removeBtn);

      listEl.appendChild(row);
    }
  }

  async function revokeToken(id, label) {
    if (!window.confirm(`Revoke token "${label}"? Anything using it loses relay access immediately.`)) return;
    setMsg(listMsgEl, 'revoking...');
    try {
      const res = await fetch(`/api/relay-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to revoke token');
      setMsg(listMsgEl, 'revoked');
      await loadTokens();
    } catch (err) {
      setMsg(listMsgEl, err.message, true);
    }
  }

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    newTokenEl.textContent = '';
    setMsg(listMsgEl, 'creating...');
    try {
      const res = await fetch('/api/relay-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: labelEl.value.trim(), labScope: scopeEl.value.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to create token');
      setMsg(listMsgEl, '');
      setMsg(newTokenEl, `Token (shown once, copy it now): ${body.token}`);
      newTokenEl.style.color = 'var(--accent)';
      labelEl.value = '';
      scopeEl.value = '';
      await loadTokens();
    } catch (err) {
      setMsg(listMsgEl, err.message, true);
    }
  });

  settingsBtn.addEventListener('click', () => {
    loadEnabled();
    loadTokens();
  });
})();
