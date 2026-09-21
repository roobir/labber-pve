// Embedded node-GUI windows (dashboard's "web rp" button -- "web reverse
// proxy") -- opens a running node's real web UI in an <iframe>, via
// gui-proxy.js's Host-header-routed subdomain
// (<labName>--<nodeName>.<guiDomain>) rather than the node's raw IP
// directly. That indirection matters: vendor web UIs commonly send
// `X-Frame-Options: DENY`/a frame-ancestors CSP (confirmed on Palo Alto
// Panorama in the old libvirt-based labber project this was ported from),
// which blocks a raw-IP iframe outright, and gui-proxy.js strips those
// headers on the way through. A raw-IP iframe would also just show a blank
// page behind a self-signed-cert warning an iframe has no way to click
// through -- see dashboard.js's nodeCard(), which only renders this
// "web rp" button once a GUI domain is actually configured, for exactly
// that reason (the direct-IP "web ui" new-tab button is the fallback when
// it isn't).
//
// One window per (lab, node) pair, built at runtime and kept in
// `openWindows` -- unlike the other modals (labs/settings/templates,
// still single static overlays in index.html), an engineer can reasonably
// want several of these open at once (e.g. two PAN-OS firewalls side by
// side), each independently draggable/minimizable. See the
// .gui-panel-overlay CSS rules for why that needs a lighter, non-backdrop
// overlay treatment than a true modal.
(function () {
  let _guiDomainCache = null;
  window.guiDomain = async function () {
    if (_guiDomainCache === null) {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        _guiDomainCache = data.guiDomain || '';
      } catch (err) {
        _guiDomainCache = '';
      }
    }
    return _guiDomainCache;
  };

  const openWindows = new Map(); // "<lab>--<name>" -> { overlay, win, frame, errorEl }
  let zTop = 100; // matches .modal-overlay's base z-index; only ever climbs from here

  function keyFor(node) { return `${node.lab}--${node.name}`; }

  // Capped below the taskbar's z-index (200) so a minimized chip always
  // stays reachable even if every gui window got focused in a row.
  function bringToFront(overlay) {
    zTop = Math.min(zTop + 1, 199);
    overlay.style.zIndex = zTop;
  }

  function buildWindow(node, id, key) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay gui-panel-overlay hidden';
    overlay.innerHTML = `
      <div class="term-window gui-window">
        <div class="term-titlebar">
          <span class="gui-title"></span>
          <div class="term-titlebar-actions">
            <button type="button" class="term-minimize" title="minimize">&minus;</button>
            <button type="button" class="term-refresh" title="refresh">&#8635;</button>
            <button type="button" class="term-close" title="close">&times;</button>
          </div>
        </div>
        <div class="gui-error labs-message" style="padding: 0 0.8rem;"></div>
        <!--
          sandbox deliberately omits allow-top-navigation(-by-user-activation).
          Confirmed 2026-08-04 that F5 BIG-IP's TMUI login page carries its
          own anti-clickjacking JS that busts out of ANY iframe by forcing a
          second, full top-level navigation to the same URL the instant it
          loads; with no sandbox, that succeeds, and the "web rp" embedded
          view silently turns into a full-tab navigation away from this app
          (indistinguishable, from the user's side, from the iframe itself
          failing to load, if that forced second navigation ever hits a
          transient hiccup). allow-same-origin is still needed so the framed
          page keeps its real origin (cookies, same-origin XHR/fetch);
          sandboxing without it would break vendor UI logins outright, not
          just block top-navigation.
        -->
        <iframe class="gui-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>
      </div>
    `;
    document.body.appendChild(overlay);

    const win = overlay.querySelector('.term-window');
    const titlebar = overlay.querySelector('.term-titlebar');
    const titleEl = overlay.querySelector('.gui-title');
    const frame = overlay.querySelector('.gui-frame');
    const errorEl = overlay.querySelector('.gui-error');

    function close() {
      frame.src = 'about:blank';
      // Removing the overlay outright (not just hiding it) so a closed
      // window's DOM/iframe doesn't linger -- next open of the same node
      // just builds a fresh one. Restoring first (if minimized) clears its
      // taskbar chip; harmless to call on an about-to-be-detached element.
      if (WindowManager.isMinimized(id)) WindowManager.restore(id);
      overlay.remove();
      openWindows.delete(key);
    }
    function minimize() {
      WindowManager.minimize(id, overlay, titleEl.textContent);
    }
    // The iframe is cross-origin (gui-proxy's own subdomain vs. this
    // dashboard's origin), so the parent page has no access to its
    // contentWindow to call reload() on whatever page is currently
    // showing -- the only way to force a reload from out here is resetting
    // src, which re-navigates to the original web-rp URL (not necessarily
    // whatever sub-page the vendor UI's own in-frame navigation moved to
    // since). That's a real cross-origin limitation, not a shortcut.
    function refresh() {
      const url = frame.src;
      if (!url || url === 'about:blank') return;
      frame.src = 'about:blank';
      requestAnimationFrame(() => { frame.src = url; });
    }

    overlay.querySelector('.term-close').addEventListener('click', close);
    overlay.querySelector('.term-minimize').addEventListener('click', minimize);
    overlay.querySelector('.term-refresh').addEventListener('click', refresh);
    // Windows are meant to be usable side by side, unlike the full-screen
    // modals -- clicking one brings it above its siblings instead of a
    // shared backdrop swallowing the click.
    win.addEventListener('mousedown', () => bringToFront(overlay));

    WindowManager.makeDraggable(win, titlebar);

    return { overlay, win, titleEl, frame, errorEl };
  }

  window.openEmbeddedGui = async function (node) {
    const key = keyFor(node);
    const id = `gui-${key}`;
    let entry = openWindows.get(key);
    const title = `${node.name} (${node.lab}) -- web UI`;

    if (!entry) {
      entry = buildWindow(node, id, key);
      openWindows.set(key, entry);
      // Cascade each newly-created window's default position a bit from
      // the last one so several opened at once don't sit exactly on top
      // of each other -- read back the rect .modal-overlay's own flex
      // centering already gave it, then pin that (+ offset) as a fixed
      // position, the same "switch to fixed off the current rect" pattern
      // makeDraggable uses on first drag, just applied proactively.
      requestAnimationFrame(() => {
        const rect = entry.win.getBoundingClientRect();
        const offset = (openWindows.size - 1) * 28;
        entry.win.style.position = 'fixed';
        entry.win.style.margin = '0';
        entry.win.style.left = `${rect.left + offset}px`;
        entry.win.style.top = `${rect.top + offset}px`;
      });
    } else if (WindowManager.isMinimized(id)) {
      WindowManager.restore(id);
    }

    entry.titleEl.textContent = title;
    entry.overlay.classList.remove('hidden');
    bringToFront(entry.overlay);

    // Already loaded (or loading) a target -- just surface the window.
    // Reassigning frame.src again here, even to the same URL, would force
    // a reload in most browsers and silently drop whatever page/login
    // state the engineer already had open. The explicit refresh button is
    // the only thing that should trigger that now.
    if (entry.frame.src && entry.frame.src !== 'about:blank') return;

    entry.errorEl.textContent = '';
    const domainList = await window.guiDomain();
    if (!domainList) {
      entry.errorEl.textContent = 'No GUI domain configured (Settings -> Embedded GUI proxy)';
      return;
    }
    // guiDomain can be a comma-separated list (see gui-proxy.js's
    // resolveTarget()) -- e.g. both the plain dashboard hostname's GUI
    // domain and the ".cloud." bypass one. Pick whichever candidate matches
    // this page's own ".cloud."-ness, so a session on the bypass domain
    // builds a bypass gui-proxy URL and vice versa, instead of always using
    // the first configured entry regardless of which hostname got you here.
    const domains = domainList.split(',').map((d) => d.trim()).filter(Boolean);
    const onCloudBypass = location.hostname.includes('.cloud.');
    const domain = domains.find((d) => d.includes('.cloud.') === onCloudBypass) || domains[0];
    entry.frame.src = `https://${node.lab}--${node.name}.${domain}/`;
  };
})();
