// Small helpers shared by the dashboard card files (dashboard-cards.js and the
// card-*.js pieces it uses). Loaded first; exposes window.CardUtil.
(function () {
  // nodeName/node.kind/labName all ultimately come from lab topology YAML --
  // wizard-created files restrict node names to whatever the text input
  // allows, but hand-edited YAML can put anything there, and both get
  // interpolated into innerHTML below. Escape before that happens, not
  // after -- an unescaped `<img src=x onerror=...>` as a node name would
  // otherwise execute the next time this dashboard polls /api/status.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // mgmtIp is free-form (IPv6 allowed, see lib/lab-files.js's HOST_RE) but
  // gets interpolated straight into a `https://host:port/` string below --
  // a bare IPv6 literal there is ambiguous with the port separator and
  // needs [bracket] wrapping, same fix as lib/lab-state.js's formatHostPort
  // (no shared module between frontend/backend here, so duplicated).
  function formatHostPort(host, port) {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${bracketed}:${port}`;
  }

  window.CardUtil = { escapeHtml, formatHostPort };
})();
