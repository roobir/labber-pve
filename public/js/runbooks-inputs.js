// Builds one form control per declared runbook input. Each returns
// { el, get() } -- get() gives the value to submit (undefined when blank).
// Target and store inputs are dropdowns over live data (deployed lab nodes,
// Store entries) so nobody has to type a lab name or remember an entry.
(function () {
  const { h } = Runbooks;

  const wrap = (input, control, hint) =>
    h('label', { class: 'rb-field' }, input.label || input.id, control, hint && h('span', { class: 'rb-hint' }, hint));

  function targetControl(input, ctx) {
    const kinds = [].concat(input.kind || []);
    const nodes = ctx.targets.filter((t) => !kinds.length || kinds.includes(t.kind));
    const select = h('select', {}, nodes.length
      ? nodes.map((t) => h('option', { value: JSON.stringify({ lab: t.lab, node: t.node }) }, `${t.lab.replace(/\.lab\.yml$/, '')} / ${t.node} -- ${t.ip || 'no mgmt IP yet'}`))
      : [h('option', { value: '' }, `no deployed ${kinds.join(' / ')} nodes`)]);
    const note = h('span', { class: 'rb-hint' }, kinds.length ? `only ${kinds.join(' / ')} nodes are listed` : null);
    const warn = h('span', { class: 'rb-hint', style: 'color:#e5a50a' });
    const label = h('label', { class: 'rb-field' }, input.label || input.id, select, warn, note);
    // A reservation is only a notice, but say so before running on someone's lab
    const showReservation = () => {
      const picked = select.value && JSON.parse(select.value);
      const target = picked && nodes.find((t) => t.lab === picked.lab && t.node === picked.node);
      warn.textContent = (target && window.Reservations.warning(target.reservation)) || '';
    };
    select.addEventListener('change', showReservation);
    showReservation();
    return { el: label, get: () => (select.value ? JSON.parse(select.value) : undefined) };
  }

  function storeControl(input, ctx) {
    const entries = ctx.store.filter((e) => !input.storeType || e.type === input.storeType);
    const select = h('select', {}, [
      input.optional && h('option', { value: '' }, '(none)'),
      entries.map((e) => h('option', { value: e.name }, `${e.name}${e.group ? ` (${e.group})` : ''}`)),
    ]);
    if (entries.some((e) => e.name === input.default)) select.value = input.default;
    const hint = entries.length ? 'from the Store' : `no ${input.storeType || ''} entries in the Store yet -- add one in the Store tab`;
    return { el: wrap(input, select, hint), get: () => select.value || undefined };
  }

  function plainControl(input) {
    let control;
    if (input.type === 'select') {
      control = h('select', {}, input.options.map((o) => h('option', { value: String(o) }, String(o))));
      if (input.default !== undefined) control.value = String(input.default);
    } else if (input.type === 'text') {
      control = h('textarea', { rows: 4 });
      if (input.default !== undefined) control.value = input.default;
    } else {
      control = h('input', {
        type: input.type === 'secret' ? 'password' : input.type === 'number' ? 'number' : 'text',
        placeholder: input.placeholder || '',
        autocomplete: 'off',
      });
      if (input.default !== undefined) control.value = input.default;
    }
    return { el: wrap(input, control), get: () => (control.value === '' ? undefined : control.value) };
  }

  Runbooks.inputControl = (input, ctx) => {
    if (input.type === 'target') return targetControl(input, ctx);
    if (input.type === 'store') return storeControl(input, ctx);
    return plainControl(input);
  };
})();
