// Run tab: pick a version, fill in the inputs the runbook declares, start
// it. A busy console is reported with who holds it; if it is only a person
// (not another run) the user may start anyway.
(function () {
  const { h, api, say, show } = Runbooks;

  function holderMessage(holder) {
    if (holder.type === 'runbook') return `${holder.runbook} (started by ${holder.user}) is running on this node's console. Wait for it to finish, or take over from the console window.`;
    return `${holder.users.map((u) => u.user).join(', ')} ${holder.users.length > 1 ? 'are' : 'is'} on this node's console right now.`;
  }

  function versionPicker(rb, current, onChange) {
    const select = h('select', {}, rb.versions.map((v) => h('option', { value: v.version }, `${v.version} (${v.status})`)));
    select.value = current;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  Runbooks.view('run', (root, params) => {
    const form = h('div');
    const feedback = h('div');
    root.append(form, feedback);
    let controls = [];

    async function start(version, force) {
      const inputs = {};
      for (const { id, control } of controls) {
        const value = control.get();
        if (value !== undefined) inputs[id] = value;
      }
      feedback.replaceChildren();
      try {
        const run = await api('POST', '/api/runs', { name: params.name, version, inputs, force });
        show('live', { runId: run.id });
      } catch (err) {
        const box = h('div', { class: 'rb-errors' }, err.holder ? holderMessage(err.holder) : err.message);
        if (err.holder && err.holder.type === 'user') {
          box.append(h('div', {}, h('button', { class: 'rb-btn', onclick: () => start(version, true) }, 'start anyway')));
        }
        feedback.replaceChildren(box);
      }
    }

    async function draw(version) {
      const [def, targets, store] = await Promise.all([
        api('GET', `/api/runbooks/${params.name}/${version}`),
        api('GET', '/api/runbook-targets'),
        api('GET', '/api/runbook-store-options'),
      ]);
      const rb = (await api('GET', '/api/runbooks')).find((r) => r.name === params.name);
      controls = (def.definition.inputs || []).map((input) => ({ id: input.id, control: Runbooks.inputControl(input, { targets, store }) }));
      const locked = def.meta.status === 'locked';
      form.replaceChildren(
        h('div', { class: 'rb-toolbar' },
          h('button', { class: 'rb-btn', onclick: () => show('library') }, '← library'),
          h('strong', {}, params.name), versionPicker(rb, version, draw),
          h('span', { class: `rb-badge ${locked ? 'locked' : 'draft'}` }, locked ? 'locked' : 'draft')),
        !locked && h('div', { class: 'rb-notice warn' }, 'This is an unlocked draft -- it may not have been verified.'),
        h('div', { class: 'dim', style: 'font-size:0.8rem;margin-bottom:0.8rem' }, def.meta.description || def.definition.title || ''),
        h('div', { class: 'rb-form-grid' }, controls.map((c) => c.control.el)),
        h('button', { class: 'rb-btn primary', onclick: () => start(version, false) }, 'start run')
      );
    }

    draw(params.version).catch((err) => say(err.message, true));
  });
})();
