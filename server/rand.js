// server/rand.js — small crypto RNG shared by the Node server and the browser host runtime (PRD M2).
//
// Node and every supported browser expose the same Web Crypto surface (`crypto.getRandomValues`,
// `crypto.randomUUID`), so one implementation serves both hosts without a `node:crypto` import and
// without an esbuild shim. The lobby (room codes, bot ids, match seeds) and the session layer
// (reconnect tokens, player ids) draw from here.

/** @param {number} n @returns {Uint8Array} n cryptographically random bytes */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** @param {Uint8Array} bytes @returns {string} lowercase hex */
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {number} n @returns {string} n random bytes as lowercase hex */
export const randomHex = (n) => toHex(randomBytes(n));

/**
 * Uniform integer in [0, max) via rejection sampling on random bytes (no modulo bias).
 * @param {number} max exclusive upper bound
 * @returns {number}
 */
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError(`randomInt: max must be a positive integer, got ${max}`);
  if (max > 0x100000000) throw new RangeError(`randomInt: max must be <= 2^32, got ${max}`);
  const limit = 0x100000000 - (0x100000000 % max); // largest multiple of max that fits in 32 bits
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % max;
}
