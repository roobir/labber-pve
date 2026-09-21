// Minimal macOS-dock-style window manager shared by the labs/settings/
// templates modals: "minimize" hides a modal's overlay without touching
// whatever it's doing underneath (an in-flight upload, a deploy/destroy
// websocket stream) and drops a chip in the taskbar at the bottom of the
// page; clicking the chip restores it exactly as it was. Deliberately not
// per-modal logic duplicated three times -- each modal script just calls
// minimize()/restore()/isMinimized()/notify() with its own id.
//
// This module owns no knowledge of *what* a minimized window is doing --
// each modal script is still responsible for not stopping its own
// background work when hidden (the opposite of the old behavior, where
// e.g. labs.js's close button called ws.close()). notify() is how a modal
// script reports "something finished while you weren't looking" back up to
// here, which flashes the taskbar chip and fires a real OS notification if
// permission was ever granted.
window.WindowManager = (function () {
  const taskbar = document.getElementById('taskbar');
  const windows = new Map(); // id -> { overlayEl, chipEl }

  function updateTaskbarVisibility() {
    taskbar.classList.toggle('hidden', windows.size === 0);
  }

  function minimize(id, overlayEl, title) {
    overlayEl.classList.add('hidden');

    let entry = windows.get(id);
    if (!entry) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'taskbar-chip';
      chip.addEventListener('click', () => restore(id));
      taskbar.appendChild(chip);
      entry = { overlayEl, chipEl: chip };
      windows.set(id, entry);
    }
    entry.chipEl.textContent = title;
    entry.chipEl.title = '';
    entry.chipEl.classList.remove('taskbar-chip-done', 'taskbar-chip-error');
    updateTaskbarVisibility();

    // Only worth asking at the moment someone actually uses the feature --
    // asking on page load (before the user has done anything) is the kind
    // of unprompted permission popup that just trains people to reflexively
    // dismiss it.
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function restore(id) {
    const entry = windows.get(id);
    if (!entry) return;
    entry.overlayEl.classList.remove('hidden');
    entry.chipEl.remove();
    windows.delete(id);
    updateTaskbarVisibility();
    window.dispatchEvent(new CustomEvent('wm:restored', { detail: { id } }));
  }

  function isMinimized(id) {
    return windows.has(id);
  }

  // No-op if `id` isn't currently minimized -- the modal's own UI is
  // already visible and already showing whatever this would report, no
  // need for a taskbar flash or an OS notification on top of that.
  function notify(id, message, isError) {
    const entry = windows.get(id);
    if (!entry) return;
    entry.chipEl.classList.add(isError ? 'taskbar-chip-error' : 'taskbar-chip-done');
    entry.chipEl.title = message;
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(message);
    }
  }

  // Click-drag anywhere on a window's titlebar (except its own
  // close/minimize buttons) repositions the whole .term-window. Position is
  // tracked purely via left/top -- deliberately not `transform`, since the
  // open/close/minimize/restore pop animation (style.css's
  // `.modal-overlay.hidden .term-window` rule) already owns `transform`
  // (scale + translateY); using a different property for drag position
  // means the two never fight over the same CSS declaration, and both can
  // be mid-transition at once (e.g. minimizing a window you've already
  // dragged off-center) without one clobbering the other.
  //
  // The window starts centered by its overlay's own flexbox (untouched
  // until the first drag) -- the first mousedown reads its current
  // on-screen rect and switches it to `position: fixed` pinned at that
  // exact spot before tracking movement, so it doesn't jump on the first
  // pixel of drag.
  function makeDraggable(windowEl, titlebarEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function onPointerDown(e) {
      if (e.target.closest('button')) return; // let close/minimize clicks through untouched
      dragging = true;

      const rect = windowEl.getBoundingClientRect();
      if (windowEl.style.position !== 'fixed') {
        windowEl.style.position = 'fixed';
        windowEl.style.margin = '0';
        windowEl.style.left = `${rect.left}px`;
        windowEl.style.top = `${rect.top}px`;
      }
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      titlebarEl.classList.add('dragging');
      document.body.style.userSelect = 'none'; // stray text selection while dragging is the classic drag-UX papercut

      // The "web rp" window embeds a cross-origin <iframe> covering nearly
      // its whole body -- once the pointer crosses into it mid-drag, mouse
      // events start going to the iframe's own document instead of
      // bubbling to this window's mousemove listener, and the drag
      // silently stops tracking. Disabling pointer-events on any iframe
      // inside the window being dragged keeps every event landing on this
      // document for the duration; restored on mouseup.
      for (const frame of windowEl.querySelectorAll('iframe')) {
        frame.style.pointerEvents = 'none';
      }
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Clamped so the titlebar can never be dragged fully off-screen --
      // a fixed-position window with no visible titlebar left to grab
      // would otherwise be unrecoverable without a page reload.
      const maxLeft = window.innerWidth - 80;
      const maxTop = window.innerHeight - 40;
      const minLeft = -(windowEl.offsetWidth - 120);
      windowEl.style.left = `${Math.min(Math.max(startLeft + dx, minLeft), maxLeft)}px`;
      windowEl.style.top = `${Math.min(Math.max(startTop + dy, 0), maxTop)}px`;
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      titlebarEl.classList.remove('dragging');
      document.body.style.userSelect = '';
      for (const frame of windowEl.querySelectorAll('iframe')) {
        frame.style.pointerEvents = '';
      }
    }

    titlebarEl.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
  }

  return { minimize, restore, isMinimized, notify, makeDraggable };
})();
