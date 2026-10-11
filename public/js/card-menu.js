// A card's dropdown menus and its per-node power control (start/shutdown a
// single node's VM). Exposes window.CardMenu; calls back into
// window.Dashboard.refresh() after a power action.
(function () {
  // Closes every open card dropdown menu, across every card -- registered
  // once at module load (not per-card/per-refresh) so this doesn't leak a
  // new document-level listener on every 5s refresh() rebuild. A dropdown's
  // own toggle button stops propagation before this fires (see
  // makeDropdown() below), so opening one doesn't immediately re-close
  // itself; clicking anywhere else (including a menu item, which is the
  // desired "act then close" behavior) does.
  function closeAllDropdowns() {
    document.querySelectorAll('.card-dropdown-menu').forEach((m) => m.classList.add('hidden'));
  }
  document.addEventListener('click', closeAllDropdowns);

  // A single labeled dropdown button for a card's action row -- returns the
  // wrapper to append to .card-actions and the menu element to fill with
  // item buttons. Two of these (Maintenance, Access) replace what used to
  // be a flat row of up to 5 buttons per card, which routinely overflowed a
  // card's width once shutdown/identity were added alongside console/web
  // ui/web rp.
  function makeDropdown(label) {
    const wrap = document.createElement('div');
    wrap.className = 'card-dropdown';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'card-dropdown-toggle';
    toggle.textContent = `${label} ▾`;
    const menu = document.createElement('div');
    menu.className = 'card-dropdown-menu hidden';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = menu.classList.contains('hidden');
      closeAllDropdowns();
      if (willShow) menu.classList.remove('hidden');
    });
    wrap.append(toggle, menu);
    return { wrap, menu };
  }

  // Start/shutdown a single node's underlying VM for maintenance, without
  // touching the rest of the lab -- distinct from the Labs modal's
  // deploy/destroy (which acts on the whole lab's wiring/state). Calls
  // refresh() right after rather than waiting for the next 5s poll, so the
  // button's own card reflects the change immediately.
  async function powerNode(labFile, nodeName, action, btn) {
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = action === 'start' ? 'starting...' : 'shutting down...';
    try {
      const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/power`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `${action} failed`);
      await window.Dashboard.refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevText;
      window.alert(err.message);
    }
  }

  window.CardMenu = { makeDropdown, powerNode };
})();
