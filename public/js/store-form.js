// Add / edit / duplicate one Store entry. Editing loads the real value (this
// is the "reveal"), keeps the last few previous values so a bad paste can be
// restored, and warns that renaming breaks runbooks still using the old name.
(function () {
  const { h, api, say, show, fmtTime } = Runbooks;
  const { errorBox } = Runbooks.forms;

  const field = (label, control, hint) =>
    h('label', { class: 'rb-field' }, label, control, hint && h('span', { class: 'rb-hint' }, hint));

  Runbooks.view('store-form', (root, params) => {
    const editing = !!params.name && !params.duplicate;
    const type = h('select', { onchange: drawType }, ['secret', 'text', 'license'].map((t) => h('option', { value: t }, t)));
    const name = h('input', { type: 'text', placeholder: 'e.g. password-simple, lic-prod-03' });
    const group = h('input', { type: 'text', placeholder: 'e.g. lab, prod', list: 'rb-store-groups' });
    const description = h('input', { type: 'text', placeholder: 'what it is for' });
    const fields = h('div');
    const history = h('div', { class: 'rb-history' });
    const errors = h('div');
    const f = {
      value: h('textarea', { rows: 3, spellcheck: 'false' }),
      regkey: h('input', { type: 'text', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXXXX' }),
      licenseText: h('textarea', { rows: 8, spellcheck: 'false', placeholder: 'paste the full license file contents' }),
      addOnKeys: h('input', { type: 'text', placeholder: 'optional, space or comma separated' }),
      uuid: h('input', { type: 'text', placeholder: 'the SMBIOS UUID this license was issued for' }),
      mac: h('input', { type: 'text', placeholder: 'aa:bb:cc:dd:ee:ff (net0)' }),
    };

    function drawType() {
      const license = type.value === 'license';
      fields.replaceChildren(...(license
        ? [field('Registration key', f.regkey), field('License text (for offline install)', f.licenseText),
           field('Add-on keys', f.addOnKeys), h('div', { class: 'rb-form-grid' }, field('UUID', f.uuid, 'checked against the node before installing'), field('MAC', f.mac))]
        : [field(type.value === 'secret' ? 'Secret value' : 'Value', f.value)]));
    }

    function fill(e) {
      type.value = e.type; group.value = e.group; description.value = e.description;
      if (e.type === 'license') Object.entries(e.license).forEach(([k, v]) => { f[k].value = Array.isArray(v) ? v.join(' ') : v; });
      else f.value.value = e.value;
      drawType();
    }

    async function save() {
      const body = { type: type.value, group: group.value, description: description.value };
      if (type.value === 'license') body.license = Object.fromEntries(['regkey', 'licenseText', 'addOnKeys', 'uuid', 'mac'].map((k) => [k, f[k].value]));
      else body.value = f.value.value;
      const newName = name.value.trim();
      const target = editing ? params.name : newName;
      if (editing && newName !== params.name) body.newName = newName;
      try {
        await api('PUT', `/api/store/${target}`, body);
        say(`saved ${body.newName || target}`);
        show('store');
      } catch (err) {
        errors.replaceChildren(errorBox(err));
      }
    }

    async function restore(index) {
      try {
        await api('POST', `/api/store/${params.name}/restore`, { index });
        show('store-form', { name: params.name });
      } catch (err) {
        errors.replaceChildren(errorBox(err));
      }
    }

    const groups = h('datalist', { id: 'rb-store-groups' });
    root.append(
      h('div', { class: 'rb-toolbar' }, h('button', { class: 'rb-btn', onclick: () => show('store') }, '← store'),
        h('strong', {}, editing ? `edit ${params.name}` : 'new entry')),
      editing && h('div', { class: 'rb-notice warn' }, 'Renaming breaks any runbook that still uses the old name.'),
      h('div', { class: 'rb-form-grid' }, field('Name', name), field('Type', type), field('Group', group), field('Description', description)),
      fields, groups, errors,
      h('button', { class: 'rb-btn primary', onclick: save }, 'save'), history);

    drawType();
    api('GET', '/api/store').then((all) => groups.replaceChildren(...[...new Set(all.map((e) => e.group).filter(Boolean))].map((g) => h('option', { value: g }))));
    if (!params.name) return;

    api('GET', `/api/store/${params.name}`).then((e) => {
      fill(e);
      name.value = params.duplicate ? `${e.name}-copy` : e.name;
      if (editing && e.history.length) {
        history.append(h('div', { class: 'settings-section-title' }, 'previous values'),
          e.history.map((old, i) => h('div', {}, `${fmtTime(old.at)} by ${old.by}`, h('button', { class: 'rb-btn', onclick: () => restore(i) }, 'restore'))));
      }
    }).catch((err) => say(err.message, true));
  });
})();
