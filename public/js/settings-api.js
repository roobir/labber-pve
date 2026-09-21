// Remote stats API toggle + IP allowlist, inside the settings modal.
// Deliberately a separate module from settings.js (own load on the same
// #settings-btn click, same as labs.js/settings.js each owning their own
// button) rather than folding into it -- keeps this in sync with old
// labber's dashboard, which split it the same way.
(function () {
  const settingsBtn = document.getElementById('settings-btn');
  const form = document.getElementById('api-settings-form');
  const enabledEl = document.getElementById('api-enabled');
  const ipsEl = document.getElementById('api-allowed-ips');
  const messageEl = document.getElementById('api-settings-message');

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  async function load() {
    setMessage('');
    try {
      const res = await fetch('/api/settings/api');
      if (!res.ok) return;
      const cfg = await res.json();
      enabledEl.checked = !!cfg.enabled;
      ipsEl.value = (cfg.allowedIps || []).join(', ');
    } catch (err) {
      // leave whatever was last loaded -- the main settings load() already
      // surfaces a general "failed to load settings" message on its own field
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMessage('saving...');
    const allowedIps = ipsEl.value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await fetch('/api/settings/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledEl.checked, allowedIps }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to save');
      setMessage('saved');
    } catch (err) {
      setMessage(err.message, true);
    }
  });

  settingsBtn.addEventListener('click', load);
})();
