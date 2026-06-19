import { describe, it, expect } from 'vitest';

import {
  isBuiltinColor,
  parseHex,
  renderColor,
  colorLabel,
  normalizeColorValue,
} from './color';

describe('isBuiltinColor', () => {
  it('recognizes the five built-in tokens', () => {
    for (const c of ['yellow', 'green', 'blue', 'pink', 'orange']) {
      expect(isBuiltinColor(c)).toBe(true);
    }
  });

  it('rejects hex and unknown strings', () => {
    expect(isBuiltinColor('#aabbcc')).toBe(false);
    expect(isBuiltinColor('chartreuse')).toBe(false);
  });
});

describe('parseHex', () => {
  it('expands 3-digit hex to 6 and lower-cases', () => {
    expect(parseHex('#ABC')).toBe('#aabbcc');
    expect(parseHex('#fff')).toBe('#ffffff');
  });

  it('passes through 6-digit hex (trimmed, lower-cased)', () => {
    expect(parseHex('  #12AB56 ')).toBe('#12ab56');
  });

  it('returns null for non-hex', () => {
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('#1234')).toBeNull();
    expect(parseHex('aabbcc')).toBeNull();
  });
});

describe('renderColor', () => {
  it('maps a built-in token to its theme class + var', () => {
    expect(renderColor('green')).toEqual({
      className: 'mrg-color-green',
      solid: 'var(--mrg-green-border)',
    });
  });

  it('maps a hex to an inline rgba background + solid hex', () => {
    expect(renderColor('#aabbcc')).toEqual({
      background: 'rgba(170, 187, 204, 0.35)',
      solid: '#aabbcc',
    });
  });

  it('normalizes a 3-digit hex before rendering', () => {
    expect(renderColor('#abc').solid).toBe('#aabbcc');
  });

  it('falls back to yellow for unknown or missing colors', () => {
    const yellow = { className: 'mrg-color-yellow', solid: 'var(--mrg-yellow-border)' };
    expect(renderColor('chartreuse')).toEqual(yellow);
    expect(renderColor(undefined)).toEqual(yellow);
  });
});

describe('colorLabel', () => {
  it('title-cases a built-in token', () => {
    expect(colorLabel('orange')).toBe('Orange');
  });

  it('shows the normalized hex for custom colors', () => {
    expect(colorLabel('#ABC')).toBe('#aabbcc');
  });

  it('passes through an unrecognized value as-is', () => {
    expect(colorLabel('weird')).toBe('weird');
  });
});

describe('normalizeColorValue', () => {
  it('keeps built-ins and normalizes hex', () => {
    expect(normalizeColorValue('blue')).toBe('blue');
    expect(normalizeColorValue('#aBc')).toBe('#aabbcc');
  });

  it('coerces unknown/missing to yellow', () => {
    expect(normalizeColorValue('bogus')).toBe('yellow');
    expect(normalizeColorValue(undefined)).toBe('yellow');
  });
});
