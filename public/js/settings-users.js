// Dashboard login accounts (Settings -> Users panel). Same
// load-on-settingsBtn-click pattern as settings-api.js -- own module, own
// button listener, rather than folding into settings-connection.js's form.
(function () {
  const settingsBtn = document.getElementById('settings-btn');
  const listEl = document.getElementById('users-list');
  const addForm = document.getElementById('users-add-form');
  const usernameEl = document.getElementById('user-add-username');
  const passwordEl = document.getElementById('user-add-password');
  const messageEl = document.getElementById('users-message');

  function setMessage(text, isError) {
    messageEl.textContent = text || '';
    messageEl.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  }

  async function load() {
    listEl.innerHTML = '';
    let users;
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error('failed to load users');
      users = await res.json();
    } catch (err) {
      listEl.innerHTML = '<div class="users-list-empty">failed to load users</div>';
      return;
    }

    if (users.length === 0) {
      listEl.innerHTML = '<div class="users-list-empty">no users</div>';
      return;
    }

    for (const { username } of users) {
      const row = document.createElement('div');
      row.className = 'users-list-row';

      const nameEl = document.createElement('span');
      nameEl.textContent = username;
      row.appendChild(nameEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'danger';
      removeBtn.textContent = 'remove';
      removeBtn.addEventListener('click', () => removeUser(username));
      row.appendChild(removeBtn);

      listEl.appendChild(row);
    }
  }

  async function removeUser(username) {
    if (!window.confirm(`Remove user "${username}"? They'll no longer be able to log in.`)) return;
    setMessage('removing...');
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to remove user');
      setMessage('removed');
      await load();
    } catch (err) {
      setMessage(err.message, true);
    }
  }

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setMessage('adding...');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameEl.value.trim(), password: passwordEl.value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'failed to add user');
      setMessage(`added "${body.username}"`);
      usernameEl.value = '';
      passwordEl.value = '';
      await load();
    } catch (err) {
      setMessage(err.message, true);
    }
  });

  settingsBtn.addEventListener('click', load);
})();
