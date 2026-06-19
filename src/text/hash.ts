/**
 * Hashing primitives, dependency-free and synchronous so they run identically
 * in the Obsidian bundle and in vitest.
 *
 * - {@link qhash}: a short non-cryptographic hash of the normalized quote, used
 *   as a fast cross-reformatting equality check (§5.4, §6.1). Collisions are
 *   tolerable — it is a disambiguator, never the sole matcher.
 * - {@link sha1Hex} / {@link contentHash}: a portable, verifiable digest of the
 *   whole source file for the "did anything change?" gate (§5.3, §6.1).
 */

/** 32-bit FNV-1a over UTF-16 code units. Deterministic; not collision-proof. */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Short hex hash of an already-normalized quote (default 8 hex chars). */
export function qhash(normalizedQuote: string, len = 8): string {
  return fnv1a32(normalizedQuote).toString(16).padStart(8, '0').slice(0, len);
}

/**
 * SHA-1 of a string (UTF-8 encoded), returned as 40 lowercase hex chars.
 * A self-contained implementation so `source_hash` is portable and verifiable
 * by any tool, matching the `sha1:` prefix used in the file format (§5.2).
 */
export function sha1Hex(message: string): string {
  const msg = new TextEncoder().encode(message);
  const L = msg.length;
  const total = Math.ceil((L + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[L] = 0x80;

  const dv = new DataView(buf.buffer);
  const bitLen = L * 8;
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** Algorithm-tagged content hash for `source_hash`, e.g. `"sha1:da39a3ee…"`. */
export function contentHash(text: string): string {
  return `sha1:${sha1Hex(text)}`;
}
