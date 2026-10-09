// Keeps an xterm.js terminal sized to its container. FitAddon.fit() is only a
// snapshot: if the container changes size afterwards (a banner appears above
// it, the window is resized or dragged, a web font finishes loading and the
// character cell changes), the terminal keeps its old row count and the last
// rows are cut off until something happens to refit it. This watches the
// container and refits on every change (changes are batched into one fit, 40 ms after the last one).
//
//   const stop = TerminalFit.attach(fitAddon, containerEl);   // later: stop()
window.TerminalFit = {
  attach(fitAddon, container) {
    let timer = null;
    const refit = () => {
      timer = null;
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        try { fitAddon.fit(); } catch (e) { /* terminal disposed meanwhile */ }
      }
    };
    // a timer, not requestAnimationFrame: frame callbacks pause in background tabs
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(refit, 40);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  },
};
