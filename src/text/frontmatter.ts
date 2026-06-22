/**
 * Leading-frontmatter detection, shared by every content matcher (resolver,
 * highlight creation, reading-mode locate, import locate).
 *
 * YAML frontmatter is *metadata*, never annotatable body text — yet its
 * `title` / `description` routinely duplicate body text verbatim (a web clip's
 * H1 *is* the page title; the `description` repeats the lede). A matcher that
 * searched the whole file could therefore anchor a body highlight **into the
 * frontmatter**, where Live Preview renders it as the Properties widget (no
 * decoratable text → it silently vanishes) while reading mode's best-effort
 * painter finds the body copy instead — the exact mode-split this guards against.
 *
 * So matching always starts at {@link bodyStart}. Pure (no Obsidian), so the
 * resolver stays testable and this works even when the metadata cache lags.
 */

// A leading YAML frontmatter block: `---` on the first line, then any content,
// then a `---` (or `...`) line. The content + its newline are optional so an
// empty block (`---\n---\n`) is still recognized. `\r?\n` tolerates CRLF.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Offset in `source` where the document body begins — just past a leading YAML
 * frontmatter block, or `0` when there is none (so callers can unconditionally
 * `source.slice(bodyStart(source))` and add it back to map offsets home).
 *
 * An unterminated leading `---` is *not* treated as frontmatter (no match → 0):
 * permissive on purpose, matching how Obsidian itself declines to parse it.
 */
export function bodyStart(source: string): number {
  const m = FRONTMATTER_RE.exec(source);
  return m ? m[0].length : 0;
}
