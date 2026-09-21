// Renders one lab's node-card grid (or a dim "not deployed" row) for the
// main dashboard -- mgmt-IP editor, per-node power control, and the UUID/MAC
// identity panel all live here since they're all part of a single card's
// interactive surface. dashboard.js owns the polling loop and calls
// `window.DashboardCards.labGroup`/`.notDeployedRow`; this file calls back
// into `window.Dashboard.refresh()` after a power action, same window.X
// cross-file convention as labs-editor.js/labs-wizard.js.
(function () {
  // nodeName/node.kind/labName all ultimately come from lab topology YAML --
  // wizard-created files restrict node names to whatever the text input
  // allows, but hand-edited YAML can put anything there, and both get
  // interpolated into innerHTML below. Escape before that happens, not
  // after -- an unescaped `<img src=x onerror=...>` as a node name would
  // otherwise execute the next time this dashboard polls /api/status.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // mgmtIp is free-form (IPv6 allowed, see lib/lab-files.js's HOST_RE) but
  // gets interpolated straight into a `https://host:port/` string below --
  // a bare IPv6 literal there is ambiguous with the port separator and
  // needs [bracket] wrapping, same fix as lib/lab-state.js's formatHostPort
  // (no shared module between frontend/backend here, so duplicated).
  function formatHostPort(host, port) {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${bracketed}:${port}`;
  }

  // Fetched once at load (gui.js's window.guiDomain(), cached there too) --
  // gates whether nodeCard() offers the "web rp" button at all. Not
  // re-fetched on every 5s poll: a Settings-page change to this value while
  // the dashboard is already open just needs a page reload to pick up, same
  // tradeoff labs-wizard.js already makes for its own cached vendor/bridge
  // lists.
  let cachedGuiDomain = '';
  window.guiDomain().then((d) => { cachedGuiDomain = d; });

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

  function nodeCard(labFile, nodeName, node) {
    const el = document.createElement('div');
    el.className = 'card';
    const running = node.status === 'running';

    el.innerHTML = `
      <div class="card-top">
        <span class="dot ${running ? 'running' : ''}"></span>
        <span class="card-name">${escapeHtml(nodeName)}</span>
      </div>
      <div class="card-meta">${escapeHtml(node.kind)} &middot; vmid ${Number(node.vmid)}</div>
      <div class="card-actions"></div>
      <div class="card-ip"></div>
      <div class="card-identity hidden"></div>
    `;

    const actions = el.querySelector('.card-actions');

    if (!running) {
      const span = document.createElement('span');
      span.className = 'dim';
      span.style.fontSize = '0.75rem';
      span.textContent = node.status;
      actions.appendChild(span);
    }

    // --- Maintenance: identity + power control -------------------------------
    // Grouped separately from Access below since these act on the node's
    // underlying VM/config rather than reaching its own OS/app -- "identity"
    // is offered regardless of running state (reading/pinning the SMBIOS
    // UUID or a NIC's MAC is just VM config, doesn't need the guest booted),
    // "shutdown"/"start" is whichever applies to the node's current state.
    const maintenance = makeDropdown('Maintenance');

    const idItem = document.createElement('button');
    idItem.type = 'button';
    idItem.textContent = 'identity';
    idItem.title = 'view/anchor this node\'s UUID + MAC -- some vendor licenses are keyed to these and Proxmox re-randomizes them on every redeploy unless pinned';
    // Lazy-loaded (only fetched once expanded) since it's a second API call
    // per card that most views of the dashboard won't need.
    idItem.addEventListener('click', () => {
      const panel = el.querySelector('.card-identity');
      const willShow = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (willShow) loadIdentityPanel(panel, labFile, nodeName);
    });
    maintenance.menu.appendChild(idItem);

    const powerItem = document.createElement('button');
    powerItem.type = 'button';
    if (running) {
      powerItem.textContent = 'shutdown';
      powerItem.title = 'gracefully shut down this node\'s VM for maintenance (lab wiring/state is kept -- use "start" to bring it back)';
      powerItem.addEventListener('click', () => powerNode(labFile, nodeName, 'stop', powerItem));
    } else {
      // Every node reaching this branch is still part of a *deployed* lab
      // (this card only renders inside labGroup(), never for a not-deployed
      // lab's row) -- its VM exists, it's just not currently running, so
      // "start" is always a valid action here, unlike the fully-destroyed
      // case which has no card/vmid to act on at all.
      powerItem.textContent = 'start';
      powerItem.addEventListener('click', () => powerNode(labFile, nodeName, 'start', powerItem));
    }
    maintenance.menu.appendChild(powerItem);
    actions.appendChild(maintenance.wrap);

    // --- Access: reach the node's own console/web UI -------------------------
    // Only offered once running -- none of these mean anything for a VM
    // that isn't up.
    if (running) {
      const access = makeDropdown('Access');

      const consoleItem = document.createElement('button');
      consoleItem.type = 'button';
      consoleItem.textContent = 'console';
      consoleItem.addEventListener('click', () => window.openConsole(labFile, nodeName));
      access.menu.appendChild(consoleItem);

      if (node.mgmtIp) {
        const webItem = document.createElement('button');
        webItem.type = 'button';
        webItem.textContent = 'web ui';
        webItem.addEventListener('click', () => window.open(`https://${formatHostPort(node.mgmtIp, Number(node.mgmtPort) || 443)}/`, '_blank'));
        access.menu.appendChild(webItem);

        // Only offered once a GUI domain is configured *and* this node has
        // an mgmt IP -- without a domain there's no gui-proxy.js listener
        // for the iframe to hit at all, and without an IP it would just
        // load a blank "no mgmt IP set" response inside the frame with no
        // way to surface that error to the user (cross-origin, can't read
        // the iframe's response). "web ui" above is the fallback either way.
        if (cachedGuiDomain) {
          const rpItem = document.createElement('button');
          rpItem.type = 'button';
          rpItem.textContent = 'web rp';
          rpItem.title = 'open this node\'s web UI in-page, via the gui-proxy reverse proxy';
          rpItem.addEventListener('click', () => window.openEmbeddedGui({ lab: labFile.replace(/\.lab\.yml$/, ''), name: nodeName }));
          access.menu.appendChild(rpItem);
        }
      }
      actions.appendChild(access.wrap);

      renderIpControl(el.querySelector('.card-ip'), labFile, nodeName, node);
    }

    return el;
  }

  // Not-deployed labs still get a row here (just their name + a dim status
  // pill, no node grid -- there's no VM state to show) so the dashboard
  // reflects every lab file that exists, not only the ones currently live.
  // Previously refresh() filtered these out entirely, so a lab that had
  // been deployed and then destroyed simply vanished from view with no way
  // to tell "destroyed" apart from "never existed" without opening the
  // separate Labs modal.
  function notDeployedRow(labFile) {
    const wrap = document.createElement('div');
    wrap.className = 'lab-group';
    const labName = labFile.replace(/\.lab\.yml$/, '');
    wrap.innerHTML = `
      <div class="lab-group-title">
        lab: <span class="lab-group-name">${escapeHtml(labName)}</span>
        <span class="dim" style="margin-left:0.6rem">not deployed</span>
      </div>
    `;
    return wrap;
  }

  function labGroup(labFile, labStatus) {
    const wrap = document.createElement('div');
    wrap.className = 'lab-group';
    const labName = labFile.replace(/\.lab\.yml$/, '');

    wrap.innerHTML = `<div class="lab-group-title">lab: <span class="lab-group-name">${escapeHtml(labName)}</span></div>`;

    const cardGrid = document.createElement('div');
    cardGrid.className = 'grid';
    cardGrid.style.padding = '0';

    for (const [nodeName, node] of Object.entries(labStatus.nodes)) {
      cardGrid.appendChild(nodeCard(labFile, nodeName, node));
    }
    wrap.appendChild(cardGrid);
    return wrap;
  }

  window.DashboardCards = { labGroup, notDeployedRow };
})();
