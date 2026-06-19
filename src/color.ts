/**
 * Color resolution shared by the editor highlighter, the reading-mode painter,
 * the aside cards, and the selection toolbar.
 *
 * A stored color is EITHER a built-in token (yellow/green/blue/pink/orange),
 * which renders via the theme-aware `mrg-color-*` CSS classes and `--mrg-*`
 * variables, OR an arbitrary `#rgb`/`#rrggbb` hex from a user's custom palette,
 * which renders via inline styles. Storing the literal value (not a palette
 * index) keeps an annotation's appearance stable even if the palette is later
 * edited or the color removed from it.
 */
import { BUILTIN_COLORS, type BuiltinColor } from '@/settings';

const BUILTIN_SET = new Set<string>(BUILTIN_COLORS);

/** Highlight-background opacity applied to a custom hex color. */
const HIGHLIGHT_ALPHA = 0.35;

/** Is `color` one of the built-in, CSS-class-backed tokens? */
export function isBuiltinColor(color: string): color is BuiltinColor {
  return BUILTIN_SET.has(color);
}

/** Normalize a `#rgb`/`#rrggbb` string to lower-case 6-digit `#rrggbb`, else null. */
export function parseHex(color: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  return `#${hex}`;
}

/** `#rrggbb` → `rgba(r, g, b, alpha)`. Assumes a normalized 6-digit hex. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface ColorRender {
  /** CSS class to add for a built-in color (theme-aware); absent for custom hex. */
  className?: string;
  /** Inline `background-color` for a custom highlight (hex); absent for built-ins. */
  background?: string;
  /** Solid color for swatches and the card's left border (token var or hex). */
  solid: string;
}

/**
 * Resolve a stored color value (token or hex) into renderable CSS. An
 * unrecognized value falls back to yellow, matching the legacy default so a
 * stale or malformed color never blanks a highlight.
 */
export function renderColor(color: string | undefined): ColorRender {
  if (color && isBuiltinColor(color)) {
    return { className: `mrg-color-${color}`, solid: `var(--mrg-${color}-border)` };
  }
  const hex = color ? parseHex(color) : null;
  if (hex) {
    return { background: hexToRgba(hex, HIGHLIGHT_ALPHA), solid: hex };
  }
  return { className: 'mrg-color-yellow', solid: 'var(--mrg-yellow-border)' };
}

/** Human-friendly label: `Yellow` for tokens, the normalized hex for custom colors. */
export function colorLabel(color: string): string {
  if (isBuiltinColor(color)) return color[0].toUpperCase() + color.slice(1);
  return parseHex(color) ?? color;
}

/** Coerce an arbitrary stored color to one we can render (token or hex), else yellow. */
export function normalizeColorValue(color: string | undefined): string {
  if (color && isBuiltinColor(color)) return color;
  return (color ? parseHex(color) : null) ?? 'yellow';
}
