/**
 * Locate a Web Highlights mark's text inside a clip's Markdown source.
 *
 * A mark's `text` is the plain text the browser rendered; the clip is Markdown
 * that has been reflowed and re-marked-up by the clipper, so the two rarely line
 * up byte-for-byte. We therefore match on an *aggressively* normalized projection
 * of the source — links reduced to their visible text, emphasis/structure markers
 * stripped, smart punctuation folded to ASCII, lowercased, and whitespace removed
 * entirely — so a phrase still matches even when the clip wrapped it across lines,
 * mangled an `*italic*` onto its own lines, or turned a word into a `[link](url)`
 * (all real conversion artifacts). This mirrors the normalization the standalone
 * "Highlight Exporter" used, which is why import fidelity matches it.
 *
 * Crucially the projection keeps a per-character map back to true source offsets,
 * so a match yields an exact `[from, to)` range the store can highlight and the
 * resolver can re-anchor. First occurrence wins; an absent needle returns `null`
 * (reported as "not located", never guessed — §4.6).
 *
 * This is deliberately more lossy than {@link import('@/text/locate').findSourceRange}
 * (the reading-mode toolbar's locator, which only collapses whitespace and is
 * case/punctuation-sensitive); the two serve different callers and stay separate.
 */
import type { Range } from '@/model/types';
import { bodyStart } from '@/text/frontmatter';

/** Markdown markers that carry styling/structure, not rendered text. */
const MARKER_CHARS = new Set(['*', '_', '`', '#', '>', '|', '~']);

/** Smart punctuation → ASCII, so a curly quote in one side matches a straight one in the other. */
const SMART_PUNCTUATION: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '–': '-',
  '—': '-',
  '―': '-',
};

/**
 * Normalize one source character to its match form: `null` to drop it (whitespace,
 * a Markdown marker, or an escaping backslash), otherwise a single folded,
 * lowercased character. Always 1→{0,1} chars, so a parallel offset map stays exact.
 */
function normChar(c: string): string | null {
  if (/\s/.test(c)) return null;
  if (MARKER_CHARS.has(c)) return null;
  if (c === '\\') return null; // drop the backslash of a `\*` style escape
  return (SMART_PUNCTUATION[c] ?? c).toLowerCase();
}

// Link/image/footnote patterns, tried sticky (anchored at the cursor). Reducing
// them to their visible text is what lets a mark over a link still match (the
// renderer — and the mark — show only the text, never the URL/brackets).
const IMAGE = /!\[[^\]]*\]\([^)]*\)/y; // ![alt](url) → nothing
const FOOTNOTE = /\[\^[^\]\n]*\]/y; // [^id] → nothing
const WIKILINK = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/y; // [[t|a]]→a, [[t]]→t
const LINK = /\[([^\]]*)\]\([^)]*\)/y; // [text](url) → text

/** Append `sub`'s normalized chars to `norm`, mapping each to `start + localIndex`. */
function emitText(sub: string, start: number, norm: string[], off: number[]): void {
  for (let k = 0; k < sub.length; k++) {
    const n = normChar(sub[k]);
    if (n !== null) {
      norm.push(n);
      off.push(start + k);
    }
  }
}

/** Project the source to its match form plus a map from each char to a source offset. */
function projectSource(source: string): { norm: string[]; off: number[] } {
  const norm: string[] = [];
  const off: number[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '!' && tryAt(IMAGE, source, i)) {
      i = IMAGE.lastIndex; // drop the image entirely
      continue;
    }
    if (source[i] === '[') {
      const foot = tryAt(FOOTNOTE, source, i);
      if (foot) {
        i = FOOTNOTE.lastIndex; // drop the footnote ref
        continue;
      }
      const wiki = tryAt(WIKILINK, source, i);
      if (wiki) {
        const alias = wiki[2];
        if (alias !== undefined) emitText(alias, i + 2 + wiki[1].length + 1, norm, off);
        else emitText(wiki[1], i + 2, norm, off);
        i = WIKILINK.lastIndex;
        continue;
      }
      const link = tryAt(LINK, source, i);
      if (link) {
        emitText(link[1], i + 1, norm, off); // keep the link text, drop ](url)
        i = LINK.lastIndex;
        continue;
      }
    }
    const n = normChar(source[i]);
    if (n !== null) {
      norm.push(n);
      off.push(i);
    }
    i++;
  }
  return { norm, off };
}

/** Sticky-match `re` anchored exactly at `i`; returns the match or `null`. */
function tryAt(re: RegExp, source: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  const m = re.exec(source);
  return m && m.index === i ? m : null;
}

/** Project `text` to its match form, discarding offsets (used for the needle). */
function normalizeNeedle(text: string): string {
  let out = '';
  for (const c of text) {
    const n = normChar(c);
    if (n !== null) out += n;
  }
  return out;
}

/**
 * Best-effort source range `[from, to)` for a mark's `text`, or `null` when its
 * normalized form does not occur in the source.
 */
export function locateMark(source: string, text: string): Range | null {
  const needle = normalizeNeedle(text);
  if (needle.length === 0) return null;

  // Skip a leading YAML frontmatter block: the clip's `title`/`description`
  // duplicate body text, so a mark could otherwise locate into the un-annotatable
  // frontmatter (Design.md §6.5). `base` maps the hit back to a true source offset.
  const base = bodyStart(source);
  const { norm, off } = projectSource(source.slice(base));
  const i = norm.join('').indexOf(needle);
  if (i === -1) return null;
  return { from: base + off[i], to: base + off[i + needle.length - 1] + 1 };
}
