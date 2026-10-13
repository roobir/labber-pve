// SHA-512 crypt ("$6$salt$hash", Ulrich Drepper's SHA-crypt, 5000 rounds) --
// the salted password hash Linux shadow files and Check Point Gaia's
// `set expert-password-hash` / `set user ... password-hash` accept. Lets a
// runbook set a password with one non-interactive command instead of
// answering "Enter new password / (again)" prompts on a serial console.

const crypto = require('crypto');

const ROUNDS = 5000;
const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Byte order of the final base64 step, three bytes per group (from the spec).
const ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

const sha512 = (...parts) => {
  const h = crypto.createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
};

// `len` bytes of `digest` repeated (the spec's "for each block of 64 bytes").
function repeat(digest, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 64) digest.copy(out, i, 0, Math.min(64, len - i));
  return out;
}

function encode(bytes) {
  let out = '';
  const put = (v, n) => {
    for (let i = 0; i < n; i++, v >>= 6) out += ALPHABET[v & 63];
  };
  for (const [a, b, c] of ORDER) put((bytes[a] << 16) | (bytes[b] << 8) | bytes[c], 4);
  put(bytes[63], 2);
  return out;
}

function randomSalt() {
  return [...crypto.randomBytes(16)].map((b) => ALPHABET[b & 63]).join('');
}

function sha512Crypt(password, salt = randomSalt()) {
  const pw = Buffer.from(String(password), 'utf-8');
  const s = Buffer.from(String(salt).slice(0, 16), 'utf-8');

  const b = sha512(pw, s, pw);
  const aParts = [pw, s, repeat(b, pw.length)];
  for (let n = pw.length; n > 0; n >>= 1) aParts.push(n & 1 ? b : pw);
  let c = sha512(...aParts);

  const p = repeat(sha512(...Array(pw.length).fill(pw)), pw.length);
  const sBytes = repeat(sha512(...Array(16 + c[0]).fill(s)), s.length);

  for (let i = 0; i < ROUNDS; i++) {
    const parts = [i & 1 ? p : c];
    if (i % 3) parts.push(sBytes);
    if (i % 7) parts.push(p);
    parts.push(i & 1 ? c : p);
    c = sha512(...parts);
  }
  return `$6$${s.toString('utf-8')}$${encode(c)}`;
}

module.exports = { sha512Crypt };
