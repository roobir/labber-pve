// Small form pieces the runbook editor shows on demand: the lock dialog,
// the copy-as dialog, the locked-version summary, and a validation error
// box. Split out of runbooks-editor.js to keep each file focused.
(function () {
  const { h, api, say, show } = Runbooks;

  function errorBox(err) {
    const items = err.details && err.details.length ? err.details : [err.message];
    return h('div', { class: 'rb-errors' }, 'Cannot save:', h('ul', {}, items.map((d) => h('li', {}, d))));
  }

  function field(label, control, hint) {
    return h('label', { class: 'rb-field' }, label, control, hint && h('span', { class: 'rb-hint' }, hint));
  }

  function lockForm(name, version, done) {
    const description = h('textarea', { rows: 2, placeholder: 'What it does and who it is safe to run on' });
    const verified = h('input', { type: 'text', placeholder: 'e.g. BIG-IP 17.1 VE on lab Proxmox' });
    const changelog = h('textarea', { rows: 2, placeholder: 'What changed in this version' });
    const msg = h('div');
    const lock = async () => {
      try {
        await api('POST', `/api/runbooks/${name}/${version}/lock`, { description: description.value, verified: verified.value, changelog: changelog.value });
        say(`${name} ${version} is locked`);
        done();
      } catch (err) {
        msg.replaceChildren(errorBox(err));
      }
    };
    return h('div', { class: 'rb-card', style: 'padding:0.8rem' },
      h('div', { class: 'rb-notice warn' }, 'Locking makes this version permanent: it cannot be edited or deleted in the app. Everyone can then run it.'),
      field('Description (required)', description),
      field('Verified on', verified, 'optional -- what you tested it against'),
      field('Changelog', changelog),
      msg,
      h('button', { class: 'rb-btn primary', onclick: lock }, 'lock version')
    );
  }

  function copyForm(name, version) {
    const newName = h('input', { type: 'text', placeholder: 'new-runbook-name' });
    const msg = h('div');
    const copy = async () => {
      try {
        await api('POST', `/api/runbooks/${name}/${version}/copy`, { newName: newName.value.trim() });
        show('editor', { name: newName.value.trim(), version: '1.0' });
      } catch (err) {
        msg.replaceChildren(errorBox(err));
      }
    };
    return h('div', { class: 'rb-toolbar' }, newName, h('button', { class: 'rb-btn', onclick: copy }, 'copy'), msg);
  }

  function lockedInfo(meta) {
    const lines = [`locked by ${meta.lockedBy} on ${Runbooks.fmtTime(meta.lockedAt)}`, meta.description];
    if (meta.verified) lines.push(`verified on: ${meta.verified}`);
    if (meta.changelog) lines.push(`changelog: ${meta.changelog}`);
    return h('div', { class: 'rb-notice' }, lines.map((l) => h('div', {}, l)));
  }

  Runbooks.forms = { errorBox, field, lockForm, copyForm, lockedInfo };
})();
