/**
 * The Web Highlights export format and the pure helpers that read it.
 *
 * Marginalia can import highlights made with the Web Highlights browser
 * extension: a JSON backup holds an array of "marks" (highlighted text + color +
 * an optional HTML note), each tagged with the page URL it was made on. We match
 * those to a *clip* note in the vault (a note whose frontmatter records the same
 * source URL) and re-anchor each mark's text into the clip with the resolver's
 * content-based machinery — see {@link planImport}.
 *
 * This module is pure (no `obsidian`, no DOM): it parses the export, selects the
 * marks for a URL, and projects a mark's color/note into Marginalia's shapes.
 * Ported and trimmed from the standalone "Highlight Exporter" plugin — the parts
 * that built reading notes or rewrote the clip in place are intentionally gone.
 */

import { parseHex } from '@/color';

/** A single highlight ("mark") as stored by the Web Highlights extension. */
export interface Mark {
  /** Page URL the highlight was made on; matched against a clip's source URL. */
  url?: string;
  /** The highlighted text — the needle we re-anchor into the clip source. */
  text?: string;
  /** Highlight color as a hex string, e.g. `#fdffb4`. */
  color?: string;
  /** A user comment attached to the highlight, stored as an HTML fragment. */
  notes?: string;
  /** Creation timestamp (epoch ms). */
  createdAt?: number;
  /** Forward-compatible: other fields are preserved but unused. */
  [key: string]: unknown;
}

/** Top-level shape of a Web Highlights JSON backup. */
export interface WebHighlightsExport {
  marks: Mark[];
  [key: string]: unknown;
}

/** Parse (or accept already-parsed) export JSON, validating the `marks` array. */
export function parseExport(input: string | WebHighlightsExport): WebHighlightsExport {
  const data = typeof input === 'string' ? (JSON.parse(input) as WebHighlightsExport) : input;
  if (!data || !Array.isArray(data.marks)) {
    throw new Error('Invalid Web Highlights export: expected a "marks" array.');
  }
  return data;
}

/** Canonicalize a URL for matching: drop the hash fragment and trailing slash. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return u
      .replace(/#.*$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

/** Return the marks belonging to a given page URL, in their stored order. */
export function marksForUrl(data: WebHighlightsExport, url: string): Mark[] {
  const target = normalizeUrl(url);
  return data.marks.filter((m) => typeof m.url === 'string' && normalizeUrl(m.url) === target);
}

/** The set of normalized page URLs that have at least one mark in the export. */
export function urlsWithMarks(data: WebHighlightsExport): Set<string> {
  const urls = new Set<string>();
  for (const m of data.marks) if (typeof m.url === 'string') urls.add(normalizeUrl(m.url));
  return urls;
}

/**
 * Pull a page URL out of a clip's frontmatter (a `source`/`url`/… field). Accepts
 * both a bare URL and a `[title](url)` markdown link, matching the shapes web
 * clippers write. Returns `null` when no recognizable URL is present.
 */
export function urlFromMeta(meta: Record<string, unknown> | undefined | null): string | null {
  if (!meta) return null;
  for (const key of ['source', 'url', 'link', 'source_url', 'permalink']) {
    const raw = meta[key];
    if (raw == null) continue;
    const v = String(raw);
    const md = /\((https?:\/\/[^)]+)\)/.exec(v); // markdown link: [title](url)
    if (md) return md[1]!;
    const bare = /(https?:\/\/\S+)/.exec(v);
    if (bare) return bare[1]!.replace(/["')\]]+$/, '');
  }
  return null;
}

/** A mark's color as a Marginalia-renderable value (normalized `#rrggbb`), or undefined. */
export function markColor(mark: Mark): string | undefined {
  if (typeof mark.color !== 'string') return undefined;
  const c = mark.color.trim();
  if (!c) return undefined;
  return parseHex(c.startsWith('#') ? c : `#${c}`) ?? undefined;
}

/** A mark's comment as Markdown (its HTML note converted), or '' when it has none. */
export function markComment(mark: Mark): string {
  return mark.notes ? htmlToMarkdown(mark.notes) : '';
}

/**
 * Distinct mark colors in an export (normalized `#rrggbb`), most-used first. The
 * palette settings autocomplete offers these so you pick the colors you actually
 * highlight with instead of recalling hex codes.
 */
export function colorsInExport(data: WebHighlightsExport): string[] {
  const counts = new Map<string, number>();
  for (const m of data.marks) {
    const c = markColor(m);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

// --- HTML note → Markdown -------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Convert the small HTML fragments Web Highlights stores for comments
 * (`<p>…</p>`, lists, basic inline formatting) into Markdown. Intentionally
 * lightweight — no DOM dependency, just the tags that appear in practice — and
 * deliberately avoids producing blockquotes or code blocks, which a sidecar
 * comment can't contain (§5.1).
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  let s = html;
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6])\s*>/gi, '\n\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '');
  s = s.replace(/<\/(ul|ol)\s*>/gi, '\n');
  s = s.replace(/<\s*(strong|b)\s*>/gi, '**').replace(/<\/\s*(strong|b)\s*>/gi, '**');
  s = s.replace(/<\s*(em|i)\s*>/gi, '*').replace(/<\/\s*(em|i)\s*>/gi, '*');
  s = s.replace(/<\s*code\s*>/gi, '`').replace(/<\/\s*code\s*>/gi, '`');
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<[^>]+>/g, ''); // drop any remaining tags
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
