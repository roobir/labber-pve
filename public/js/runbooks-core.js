// Runbooks window shell: open/close/minimize, tab bar, a tiny view registry,
// and the helpers every runbooks view shares (DOM builder, fetch wrapper,
// status line). Each view lives in its own file and registers itself with
// Runbooks.view(name, render). render(root, params) fills `root` and may
// return a cleanup function (closing a websocket, say) that runs when the
// user navigates elsewhere.
//
// All DOM is built with textContent via h() -- runbook names, log lines and
// store descriptions are user-supplied and must never reach innerHTML.
window.Runbooks = (function () {
  const overlay = document.getElementById('runbooks-overlay');
  const body = document.getElementById('rb-body');
  const tabsEl = document.getElementById('rb-tabs');
  const messageEl = document.getElementById('rb-message');

  const views = {};
  const TAB_OF = { library: 'library', editor: 'library', run: 'library', runs: 'runs', live: 'runs', store: 'store', 'store-form': 'store' };
  let cleanup = null;

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  // JSON in/out; failures throw an Error carrying `.details` (validation
  // problem list) and `.holder` (who owns a busy console) when present.
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `request failed (${res.status})`), { details: data.details, holder: data.holder, status: res.status });
    }
    return data;
  }

  function say(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  function view(name, render) {
    views[name] = render;
  }

  function show(name, params) {
    if (cleanup) { cleanup(); cleanup = null; }
    say('');
    for (const btn of tabsEl.children) btn.classList.toggle('active', btn.dataset.tab === TAB_OF[name]);
    body.replaceChildren();
    cleanup = views[name](body, params || {}) || null;
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  function open() {
    overlay.classList.remove('hidden');
    if (!body.firstChild) show('library');
  }
  const close = () => overlay.classList.add('hidden');

  tabsEl.addEventListener('click', (e) => e.target.dataset.tab && show(e.target.dataset.tab));
  document.getElementById('runbooks-btn').addEventListener('click', () => {
    if (WindowManager.isMinimized('runbooks')) WindowManager.restore('runbooks');
    else open();
  });
  document.getElementById('runbooks-close').addEventListener('click', close);
  document.getElementById('runbooks-minimize').addEventListener('click', () => WindowManager.minimize('runbooks', overlay, 'runbooks'));
  WindowManager.makeDraggable(overlay.querySelector('.term-window'), overlay.querySelector('.term-titlebar'));

  return { h, api, say, view, show, fmtTime, open };
})();
