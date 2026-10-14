// Library tab: one card per runbook. A card shows the version that runs when
// a lab or a run does not name one (the "default": the highest locked
// version, else the highest draft -- same rule as resolveVersion() in
// lib/runbooks/library-read.js) plus any newer drafts still being worked on;
// older versions fold away behind a toggle. Every version stays runnable and
// viewable, and a lab pinned to an old one keeps running it. Locked versions
// are the stable, shareable ones; only drafts can be edited or deleted -- a
// locked version is changed by making a new version or a copy from it.
(function () {
  const { h, api, say, show } = Runbooks;
  const expanded = new Set(); // runbook names whose older versions are shown

  const defaultVersion = (rb) => (rb.versions.find((v) => v.status === 'locked') || rb.versions[0]).version;

  function versionRow(rb, v, isDefault) {
    const locked = v.status === 'locked';
    const verified = v.verified ? ` -- verified: ${v.verified}` : '';
    const note = locked ? `${v.description}${verified}` : v.description || 'draft -- not locked yet';
    return h('div', { class: 'rb-version-row' },
      h('span', { class: 'rb-ver' }, v.version),
      h('span', { class: `rb-badge ${v.status}` }, v.status),
      isDefault && h('span', { class: 'rb-badge default', title: 'runs when a lab or a run does not name a version' }, 'default'),
      v.integrity === 'modified' && h('span', { class: 'rb-badge modified', title: 'the file changed on disk after it was locked' }, 'modified on disk'),
      h('span', { class: 'rb-desc', title: v.changelog ? `changes in ${v.version}: ${v.changelog}` : null }, note),
      h('span', { class: 'rb-row-actions' },
        h('button', { class: 'rb-btn primary', onclick: () => show('run', { name: rb.name, version: v.version }) }, 'run'),
        h('button', { class: 'rb-btn', onclick: () => show('editor', { name: rb.name, version: v.version }) }, locked ? 'view' : 'edit'),
        locked && h('button', { class: 'rb-btn', title: 'start an editable draft of the next version', onclick: () => newVersion(rb.name, v.version) }, 'new version')
      )
    );
  }

  async function newVersion(name, version) {
    try {
      const created = await api('POST', `/api/runbooks/${name}/${version}/new-version`);
      show('editor', { name, version: created.version });
    } catch (err) {
      say(err.message, true);
    }
  }

  function olderSection(rb, older, redraw) {
    if (!older.length) return null;
    const open = expanded.has(rb.name);
    const toggle = h('button', {
      class: 'rb-older-toggle',
      onclick: () => {
        if (open) expanded.delete(rb.name);
        else expanded.add(rb.name);
        redraw();
      },
    }, open ? '▾ hide older versions' : `▸ ${older.length} older version${older.length > 1 ? 's' : ''} (${older.map((v) => v.version).join(', ')})`);
    return [toggle, open && h('div', { class: 'rb-older' }, older.map((v) => versionRow(rb, v, false)))];
  }

  function card(rb, redraw) {
    const latest = rb.versions[0];
    const def = defaultVersion(rb);
    const cut = rb.versions.findIndex((v) => v.version === def) + 1;
    return h('div', { class: 'rb-card' },
      h('div', { class: 'rb-card-head' },
        h('span', { class: 'rb-name' }, rb.name),
        h('span', { class: 'dim' }, latest.title),
        latest.vendor && h('span', { class: 'rb-badge' }, latest.vendor),
        latest.builtin && h('span', { class: 'rb-badge' }, 'built-in')
      ),
      rb.versions.slice(0, cut).map((v) => versionRow(rb, v, rb.versions.length > 1 && v.version === def)),
      olderSection(rb, rb.versions.slice(cut), redraw)
    );
  }

  Runbooks.view('library', (root) => {
    const list = h('div');
    let all = [];

    const search = h('input', { class: 'rb-grow', type: 'text', placeholder: 'search runbooks…', oninput: draw });
    root.append(
      h('div', { class: 'rb-toolbar' }, search, h('button', { class: 'rb-btn primary', onclick: () => show('editor', { isNew: true }) }, '+ new runbook')),
      list
    );

    function draw() {
      const q = search.value.trim().toLowerCase();
      const shown = all.filter((rb) => !q || `${rb.name} ${rb.versions[0].title} ${rb.versions[0].vendor}`.toLowerCase().includes(q));
      list.replaceChildren(...(shown.length ? shown.map((rb) => card(rb, draw)) : [h('div', { class: 'rb-empty' }, all.length ? 'no runbooks match' : 'no runbooks yet')]));
    }

    api('GET', '/api/runbooks').then((data) => { all = data; draw(); }).catch((err) => say(err.message, true));
  });
})();
