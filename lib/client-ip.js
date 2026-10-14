// The address a request came from, as the proxy in front of this app reports
// it (X-Real-IP, then the first X-Forwarded-For hop), else the socket's own
// peer. Only trustworthy behind a proxy that overwrites these headers -- see
// the README's security notes. Shared by login throttling, the public-API IP
// allow-list and the audit log, so all three always agree on "who".
function clientIp(req) {
  const headers = req.headers || {};
  if (headers['x-real-ip']) return headers['x-real-ip'];
  if (headers['x-forwarded-for']) return headers['x-forwarded-for'].split(',')[0].trim();
  return ((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
}

module.exports = { clientIp };
