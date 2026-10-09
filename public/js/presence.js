// Header indicator of who else is using labber-pve. Heartbeats the server
// every 30s (only while the tab is visible) and shows each person recently
// seen: green = active now, otherwise "Nm ago"; the tooltip says which node
// console they are on. Purely informational -- it just lets an engineer know
// they are not alone before they reboot something.
(function () {
  const el = document.getElementById('presence');
  const HEARTBEAT_MS = 30 * 1000;

  const ago = (iso) => {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return mins < 1 ? 'just now' : `${mins}m ago`;
  };

  function chip(user, me) {
    const chip = document.createElement('span');
    chip.className = `presence-user${user.active ? ' active' : ''}${user.username === me ? ' me' : ''}`;
    chip.textContent = user.username === me ? `${user.username} (you)` : user.active ? user.username : `${user.username} · ${ago(user.lastSeen)}`;
    chip.title = user.consoles.length ? `on console: ${user.consoles.map((c) => c.replace('.lab.yml', '')).join(', ')}` : user.active ? 'active now' : `last seen ${ago(user.lastSeen)}`;
    return chip;
  }

  async function beat() {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/presence', { method: 'POST' });
      if (!res.ok) return;
      const { me, users } = await res.json();
      el.replaceChildren(...users.map((u) => chip(u, me)));
    } catch (e) {
      // offline blip -- the next beat retries
    }
  }

  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', beat);
})();
