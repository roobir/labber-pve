// Editor tab: view or edit one runbook version as YAML. Drafts are editable
// and can be saved, run, locked or deleted. Locked versions are read-only:
// change one by making a new version (an editable draft of the next number)
// or a copy under a new name.
(function () {
  const { h, api, say, show } = Runbooks;
  const { errorBox, lockForm, copyForm, lockedInfo } = Runbooks.forms;

  Runbooks.view('editor', (root, params) => {
    const isNew = !!params.isNew;
    const nameInput = h('input', { type: 'text', placeholder: 'runbook-name (lowercase, digits, -)', class: 'rb-grow' });
    const yaml = h('textarea', { class: 'rb-yaml', spellcheck: 'false' });
    const errors = h('div');
    const extra = h('div');
    const actions = h('div', { class: 'rb-toolbar' });
    const header = h('div', { class: 'rb-toolbar' });
    let current = { name: params.name, version: params.version || '1.0', locked: false, meta: {} };
    let savedText = '';

    yaml.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      yaml.setRangeText('  ', yaml.selectionStart, yaml.selectionEnd, 'end');
    });

    async function save() {
      errors.replaceChildren();
      try {
        if (isNew && !current.name) {
          const created = await api('POST', '/api/runbooks', { name: nameInput.value.trim(), text: yaml.value });
          return show('editor', { name: nameInput.value.trim(), version: created.version });
        }
        await api('PUT', `/api/runbooks/${current.name}/${current.version}`, { text: yaml.value });
        savedText = yaml.value;
        say('saved');
        return true;
      } catch (err) {
        errors.replaceChildren(errorBox(err));
        return false;
      }
    }

    async function runIt() {
      if (!current.locked && yaml.value !== savedText && !(await save())) return;
      show('run', { name: current.name, version: current.version });
    }

    const armedDelete = h('button', { class: 'rb-btn danger', onclick: async () => {
      if (!armedDelete.classList.contains('armed')) {
        armedDelete.classList.add('armed');
        armedDelete.textContent = 'really delete this draft?';
        return;
      }
      try {
        await api('DELETE', `/api/runbooks/${current.name}/${current.version}`);
        show('library');
      } catch (err) {
        say(err.message, true);
      }
    } }, 'delete draft');

    function drawActions() {
      const back = h('button', { class: 'rb-btn', onclick: () => show('library') }, '← library');
      const run = h('button', { class: 'rb-btn primary', onclick: runIt }, 'run');
      if (current.locked) {
        actions.replaceChildren(back, run,
          h('button', { class: 'rb-btn', onclick: async () => {
            try {
              const v = await api('POST', `/api/runbooks/${current.name}/${current.version}/new-version`);
              show('editor', { name: current.name, version: v.version });
            } catch (err) { say(err.message, true); }
          } }, 'new version'),
          h('button', { class: 'rb-btn', onclick: () => extra.replaceChildren(copyForm(current.name, current.version)) }, 'copy as…'));
      } else {
        actions.replaceChildren(back, h('button', { class: 'rb-btn primary', onclick: save }, 'save'),
          ...(isNew && !current.name ? [] : [run,
            h('button', { class: 'rb-btn', onclick: () => extra.replaceChildren(lockForm(current.name, current.version, () => show('editor', { name: current.name, version: current.version }))) }, 'lock…'),
            armedDelete]));
      }
    }

    function drawHeader() {
      header.replaceChildren(
        isNew && !current.name ? nameInput : h('strong', {}, current.name),
        !isNew || current.name ? h('span', {}, current.version) : null,
        !isNew || current.name ? h('span', { class: `rb-badge ${current.locked ? 'locked' : 'draft'}` }, current.locked ? 'locked' : 'draft') : null
      );
    }

    root.append(header, actions, errors, extra, yaml,
      h('details', { class: 'rb-help' }, h('summary', {}, 'syntax help'), h('pre', {}, RunbookHelp.reference)));

    if (isNew) {
      yaml.value = RunbookHelp.starter;
      drawHeader();
      drawActions();
      return;
    }
    api('GET', `/api/runbooks/${params.name}/${params.version}`).then((d) => {
      current = { name: d.name, version: d.version, locked: d.meta.status === 'locked', meta: d.meta };
      yaml.value = savedText = d.text;
      yaml.readOnly = current.locked;
      drawHeader();
      drawActions();
      if (current.locked) extra.replaceChildren(lockedInfo(d.meta));
      if (d.integrity === 'modified') extra.append(h('div', { class: 'rb-notice warn' }, 'This locked file was changed on disk after it was locked.'));
    }).catch((err) => say(err.message, true));
  });
})();
