// Library tab: every runbook with all its versions. Locked versions are the
// stable, shareable ones; drafts are works in progress. Anything can be run;
// only drafts can be edited or deleted -- a locked version is changed by
// making a new version or a copy from it.
(function () {
  const { h, api, say, show } = Runbooks;

  function versionRow(rb, v) {
    const locked = v.status === 'locked';
    const verified = v.verified ? ` -- verified: ${v.verified}` : '';
    const note = locked ? `${v.description}${verified}` : v.description || 'draft -- not locked yet';
    return h('div', { class: 'rb-version-row' },
      h('span', { class: 'rb-ver' }, v.version),
      h('span', { class: `rb-badge ${v.status}` }, v.status),
      v.integrity === 'modified' && h('span', { class: 'rb-badge modified', title: 'the file changed on disk after it was locked' }, 'modified on disk'),
      h('span', { class: 'rb-desc' }, note),
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

  function card(rb) {
    const latest = rb.versions[0];
    return h('div', { class: 'rb-card' },
      h('div', { class: 'rb-card-head' },
        h('span', { class: 'rb-name' }, rb.name),
        h('span', { class: 'dim' }, latest.title),
        latest.vendor && h('span', { class: 'rb-badge' }, latest.vendor),
        latest.builtin && h('span', { class: 'rb-badge' }, 'built-in')
      ),
      rb.versions.map((v) => versionRow(rb, v))
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
      list.replaceChildren(...(shown.length ? shown.map(card) : [h('div', { class: 'rb-empty' }, all.length ? 'no runbooks match' : 'no runbooks yet')]));
    }

    api('GET', '/api/runbooks').then((data) => { all = data; draw(); }).catch((err) => say(err.message, true));
  });
})();
