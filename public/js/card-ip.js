// A card's management-IP widget: shows the saved IP, or an editor with a
// best-effort guest-agent "detect". Exposes window.CardIp.render.
(function () {
  const { escapeHtml } = window.CardUtil;

  // Manual-entry + best-effort guest-agent auto-detect for a node's mgmt IP
  // -- see lab-manager.js's detectNodeIp() comment for why most vendor
  // appliance images won't have a guest agent to detect from at all
  // (they're not general-purpose Linux/Windows guests); this always offers
  // the manual field either way, detect is just a shortcut when it happens
  // to work. Rendered into the card's own .card-ip container so it can be
  // re-rendered independently on save without rebuilding the whole card.
  function renderIpControl(container, labFile, nodeName, node) {
    if (node.mgmtIp) {
      container.innerHTML = `
        <span class="card-ip-set">
          <span>ip: ${escapeHtml(node.mgmtIp)}:${Number(node.mgmtPort) || 443}</span>
          <button type="button" class="card-ip-change">change</button>
        </span>
      `;
      container.querySelector('.card-ip-change').addEventListener('click', () => renderIpForm(container, labFile, nodeName, node));
      return;
    }
    renderIpForm(container, labFile, nodeName, node);
  }

  function renderIpForm(container, labFile, nodeName, node) {
    container.innerHTML = `
      <div class="card-ip-form">
        <input type="text" class="card-ip-input" placeholder="ip/host" value="${node.mgmtIp ? escapeHtml(node.mgmtIp) : ''}" />
        <input type="text" class="card-ip-port" placeholder="port" value="${node.mgmtPort ? Number(node.mgmtPort) : '443'}" style="width:3.5rem" />
        <button type="button" class="card-ip-detect">detect</button>
        <button type="button" class="card-ip-save">save</button>
      </div>
      <div class="card-ip-error"></div>
    `;
    const ipInput = container.querySelector('.card-ip-input');
    const portInput = container.querySelector('.card-ip-port');
    const errorEl = container.querySelector('.card-ip-error');

    container.querySelector('.card-ip-detect').addEventListener('click', async (e) => {
      errorEl.textContent = '';
      e.target.textContent = 'detecting...';
      e.target.disabled = true;
      try {
        const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/detect-ip`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'detect failed');
        // Multiple NICs on the guest can each report an address (e.g. a
        // mgmt + data interfaces both up) -- take the first candidate as a
        // starting point rather than guessing which one is "mgmt", the
        // save step below still lets it be edited/corrected before saving.
        ipInput.value = body.ips[0];
        if (body.ips.length > 1) errorEl.textContent = `found ${body.ips.length} addresses, using the first -- check it's the right one`;
      } catch (err) {
        errorEl.textContent = err.message;
      } finally {
        e.target.textContent = 'detect';
        e.target.disabled = false;
      }
    });

    container.querySelector('.card-ip-save').addEventListener('click', async () => {
      errorEl.textContent = '';
      const ip = ipInput.value.trim();
      const port = portInput.value.trim();
      if (!ip) { errorEl.textContent = 'ip/host is required'; return; }
      try {
        const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/nodes/${encodeURIComponent(nodeName)}/mgmt-ip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip, port }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'save failed');
        renderIpControl(container, labFile, nodeName, { ...node, mgmtIp: body.mgmtIp, mgmtPort: body.mgmtPort });
        // The Access dropdown's "web ui"/"web rp" items are only built once,
        // at card-render time, gated on node.mgmtIp -- unlike the .card-ip
        // widget just re-rendered above, that dropdown won't pick up a
        // brand-new IP on its own. Same "refresh() right after rather than
        // waiting for the next 5s poll" pattern powerNode() below already
        // uses, so the newly-set IP's access options show up immediately
        // instead of needing the next poll tick (or a manual page reload)
        // to notice the mgmtIp actually changed.
        await window.Dashboard.refresh();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  }

  window.CardIp = { render: renderIpControl };
})();
