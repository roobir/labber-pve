// Renders one lab's node-card grid (or a dim "not deployed" row) for the
// main dashboard. The card's mgmt-IP editor, power/dropdown menus and
// UUID/MAC identity panel live in card-ip.js, card-menu.js and
// card-identity.js; this file assembles them into cards. dashboard.js owns the
// polling loop and calls `window.DashboardCards.labGroup`/`.notDeployedRow`;
// the pieces call back into `window.Dashboard.refresh()` after a change,
// same window.X cross-file convention as labs-editor.js.
(function () {
  const { escapeHtml, formatHostPort } = window.CardUtil;
  const { makeDropdown, powerNode } = window.CardMenu;
  const renderIpControl = window.CardIp.render;
  const loadIdentityPanel = window.CardIdentity.load;

  // Fetched once at load (gui.js's window.guiDomain(), cached there too) --
  // gates whether nodeCard() offers the "web rp" button at all. Not
  // re-fetched on every 5s poll: a Settings-page change to this value while
  // the dashboard is already open just needs a page reload to pick up, same
  // tradeoff labs-wizard.js already makes for its own cached vendor/bridge
  // lists.
  let cachedGuiDomain = '';
  window.guiDomain().then((d) => { cachedGuiDomain = d; });

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
  // The "reserved by ..." notice + reserve/release buttons under a lab's title.
  function reservationBar(labFile, reservation) {
    const bar = document.createElement('div');
    window.Reservations.render(bar, labFile, reservation, { onChange: () => window.Dashboard && window.Dashboard.refresh() });
    return bar;
  }

  function notDeployedRow(labFile, labStatus) {
    const wrap = document.createElement('div');
    wrap.className = 'lab-group';
    const labName = labFile.replace(/\.lab\.yml$/, '');
    wrap.innerHTML = `
      <div class="lab-group-title">
        lab: <span class="lab-group-name">${escapeHtml(labName)}</span>
        <span class="dim" style="margin-left:0.6rem">not deployed</span>
      </div>
    `;
    wrap.appendChild(reservationBar(labFile, labStatus && labStatus.reservation));
    return wrap;
  }

  function labGroup(labFile, labStatus) {
    const wrap = document.createElement('div');
    wrap.className = 'lab-group';
    const labName = labFile.replace(/\.lab\.yml$/, '');

    wrap.innerHTML = `<div class="lab-group-title">lab: <span class="lab-group-name">${escapeHtml(labName)}</span></div>`;
    wrap.appendChild(reservationBar(labFile, labStatus.reservation));

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
