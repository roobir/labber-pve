// The address a request came from, as the proxy in front of this app reports
// it (X-Real-IP, then the first X-Forwarded-For hop), else the socket's own
// peer. Shared by login throttling, the public-API IP allow-list and the
// audit log, so all three always agree on "who".
//
// The headers are only believed when the connection itself comes from a
// proxy: TRUST_PROXY is set, or the socket peer is a loopback / private
// address (an ingress controller pod, npmplus, a podman/nginx on the same
// host). A client connecting straight from a public address could otherwise
// type its own X-Real-IP -- a fresh "address" per login guess (no lockout),
// a way past the public-API allow-list, a false address in the audit log.
const PRIVATE_PEER = [
  /^127\./, /^::1$/, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // link-local, CGNAT (tailscale and friends)
  /^f[cd][0-9a-f]{2}:/i, /^fe80:/i,
];

function peerAddress(req) {
  return ((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function trustsHeaders(peer) {
  return !!process.env.TRUST_PROXY || PRIVATE_PEER.some((re) => re.test(peer));
}

function clientIp(req) {
  const headers = req.headers || {};
  const peer = peerAddress(req);
  if (trustsHeaders(peer)) {
    if (headers['x-real-ip']) return headers['x-real-ip'];
    if (headers['x-forwarded-for']) return headers['x-forwarded-for'].split(',')[0].trim();
  }
  return peer;
}

module.exports = { clientIp };
