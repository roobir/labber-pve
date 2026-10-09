// "Reserved by ..." notices for labs, shared by the dashboard, the Labs window
// and the runbook run form. A reservation is only a notice: it never blocks
// anything. Anyone may reserve, extend, take over or release any lab.
//
//   Reservations.render(container, labFile, reservation, { onChange })
//       banner + buttons (reserve / extend / take over / release)
//   Reservations.warning(reservation)
//       "" for no/own reservation, else a sentence for confirm dialogs
window.Reservations = (function () {
  const DURATIONS = [[4, '4 hours'], [8, '8 hours'], [24, '24 hours'], [48, '48 hours'], [168, '1 week']];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const mine = (r) => !!r && r.by === window.currentUser;

  function until(r) {
    return new Date(r.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function summary(r) {
    return `reserved by ${r.by} until ${until(r)}${r.note ? ` (${r.note})` : ''}`;
  }

  function warning(r) {
    return r && !mine(r) ? `This lab is ${summary(r)}.` : '';
  }

  async function send(method, labFile, body) {
    const res = await fetch(`/api/labs/${encodeURIComponent(labFile)}/reservation`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  function button(label, title, onClick) {
    const b = el('button', 'reservation-btn', label);
    b.type = 'button';
    b.title = title || '';
    b.addEventListener('click', onClick);
    return b;
  }

  function form(container, labFile, reservation, done) {
    container.replaceChildren();
    const select = el('select');
    for (const [hours, label] of DURATIONS) select.append(Object.assign(el('option', '', label), { value: hours }));
    select.value = 24;
    const note = el('input');
    note.type = 'text';
    note.placeholder = 'what you are doing (optional)';
    note.maxLength = 120;
    if (reservation && mine(reservation)) note.value = reservation.note || '';
    const message = el('span', 'reservation-msg');

    const go = button(reservation && !mine(reservation) ? 'take over' : 'reserve', '', async () => {
      try {
        done(await send('POST', labFile, { hours: Number(select.value), note: note.value }));
      } catch (err) {
        message.textContent = err.message;
      }
    });
    container.append(el('span', 'dim', 'reserve for'), select, note, go, button('cancel', '', () => done(reservation)), message);
  }

  function render(container, labFile, reservation, { onChange } = {}) {
    const changed = (r) => {
      render(container, labFile, r, { onChange });
      if (onChange) onChange(r);
    };
    container.replaceChildren();
    container.className = `lab-reservation${reservation ? (mine(reservation) ? ' mine' : ' other') : ''}`;

    if (!reservation) {
      container.append(button('reserve', 'let others know you are working on this lab', () => form(container, labFile, null, changed)));
      return;
    }
    container.append(
      el('span', 'reservation-text', `🔒 ${summary(reservation).replace(/^reserved/, 'Reserved')}`),
      button(mine(reservation) ? 'extend' : 'reserve instead', '', () => form(container, labFile, reservation, changed)),
      button('release', 'clear this reservation', async () => {
        try {
          await send('DELETE', labFile);
          changed(null);
        } catch (err) {
          container.append(el('span', 'reservation-msg', err.message));
        }
      })
    );
  }

  return { render, warning, summary };
})();
