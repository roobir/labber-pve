// Store tab: every named secret / value / license runbooks can use. Search
// and filter, add, edit (via store-form.js), duplicate, delete. Secret
// values never appear in the list; the edit form loads them on demand.
(function () {
  const { h, api, say, show } = Runbooks;

  const detail = (e) => {
    if (e.type !== 'license') return e.hasValue ? '••••••' : '';
    const l = e.license;
    return [`…${l.regkeyTail}`, l.hasText ? 'text saved' : 'no text', l.uuid && 'uuid set', l.mac && 'mac set'].filter(Boolean).join(' · ');
  };

  Runbooks.view('store', (root) => {
    const tbody = h('tbody');
    const filter = h('select', { onchange: draw }, ['all types', 'secret', 'text', 'license'].map((t) => h('option', { value: t }, t)));
    const search = h('input', { class: 'rb-grow', type: 'text', placeholder: 'search name, group, description…', oninput: draw });
    let entries = [];

    function deleteButton(e) {
      const btn = h('button', { class: 'rb-btn danger' }, 'delete');
      btn.addEventListener('click', async () => {
        if (!btn.classList.contains('armed')) {
          const used = await api('GET', `/api/store/${e.name}/usage`).catch(() => []);
          btn.classList.add('armed');
          btn.textContent = used.length ? `used by ${used.length} runbook(s) -- really delete?` : 'really delete?';
          return;
        }
        try {
          await api('DELETE', `/api/store/${e.name}`);
          load();
        } catch (err) {
          say(err.message, true);
        }
      });
      return btn;
    }

    function row(e) {
      return h('tr', {},
        h('td', {}, h('strong', {}, e.name)),
        h('td', {}, h('span', { class: 'rb-badge' }, e.type)),
        h('td', {}, e.group),
        h('td', { class: 'dim' }, e.description),
        h('td', { class: 'dim' }, detail(e)),
        h('td', {}, h('div', { class: 'rb-row-actions' },
          h('button', { class: 'rb-btn', onclick: () => show('store-form', { name: e.name }) }, 'edit'),
          h('button', { class: 'rb-btn', onclick: () => show('store-form', { name: e.name, duplicate: true }) }, 'duplicate'),
          deleteButton(e))));
    }

    function draw() {
      const q = search.value.trim().toLowerCase();
      const shown = entries.filter((e) =>
        (filter.value === 'all types' || e.type === filter.value) && (!q || `${e.name} ${e.group} ${e.description}`.toLowerCase().includes(q)));
      tbody.replaceChildren(...(shown.length ? shown.map(row) : [h('tr', {}, h('td', { colspan: 6, class: 'rb-empty' }, entries.length ? 'nothing matches' : 'the Store is empty -- add a password or license'))]));
    }

    async function load() {
      try { entries = await api('GET', '/api/store'); draw(); } catch (err) { say(err.message, true); }
    }

    root.append(
      h('div', { class: 'rb-toolbar' }, search, filter, h('button', { class: 'rb-btn primary', onclick: () => show('store-form', {}) }, '+ add')),
      h('table', { class: 'rb-table' },
        h('thead', {}, h('tr', {}, ['name', 'type', 'group', 'description', 'value', ''].map((t) => h('th', {}, t)))), tbody));
    load();
  });
})();
