import { describe, it, expect } from 'vitest';
import { sha1Hex, contentHash, qhash, fnv1a32 } from './hash';

describe('sha1Hex', () => {
  it('matches known answers', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    );
  });

  it('handles multibyte UTF-8 input', () => {
    // SHA-1 of "café" (é = U+00E9, 2 bytes in UTF-8)
    expect(sha1Hex('café')).toBe('f424452a9673918c6f09b0cdd35b20be8e6ae7d7');
  });

  it('crosses the 55/56-byte padding boundary correctly', () => {
    // 56 bytes forces the length field into a fresh padding block.
    expect(sha1Hex('a'.repeat(56))).toBe('c2db330f6083854c99d4b5bfb6e8f29f201be699');
    // 64 bytes is an exact block multiple, forcing an entire extra block.
    expect(sha1Hex('a'.repeat(64))).toBe('0098ba824b5c16427bd7a1122a5a442a25ec644d');
  });
});

describe('contentHash', () => {
  it('is algorithm-tagged', () => {
    expect(contentHash('abc')).toBe('sha1:a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('qhash / fnv1a32', () => {
  it('is deterministic and hex of the requested length', () => {
    const h = qhash('the sentence i care about');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(qhash('the sentence i care about')).toBe(h);
  });

  it('distinguishes different inputs', () => {
    expect(qhash('alpha')).not.toBe(qhash('beta'));
  });

  it('respects a custom length', () => {
    expect(qhash('something', 4)).toMatch(/^[0-9a-f]{4}$/);
  });

  it('fnv1a32 returns an unsigned 32-bit integer', () => {
    const n = fnv1a32('hello world');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0xffffffff);
  });
});
