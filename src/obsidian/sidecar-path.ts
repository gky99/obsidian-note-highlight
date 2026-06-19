/**
 * Pure mapping between a source note's vault path and its sidecar's path
 * (Design.md §4.1 — one sidecar per source). No Obsidian dependency, so it is
 * unit-tested directly.
 *
 * The authoritative source→sidecar link at runtime is the sidecar's
 * `frontmatter.annotates` field; this path convention is how we *find* a
 * sidecar for a source (and decide where to create one) without reading files.
 *
 * An optional `folder` re-roots sidecars under a chosen vault folder, mirroring
 * the source's full path beneath it (so two same-named notes in different
 * folders never collide). An empty folder keeps the sidecar alongside its source.
 */

const MD_EXT = '.md';

/** Strip leading/trailing slashes from a folder path (`/A/B/` → `A/B`). */
function trimSlashes(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '');
}

/** The sidecar name alongside the source, e.g. `Clips/The Article.annotations.md`. */
function alongsideSidecar(sourcePath: string, suffix: string): string {
  const slash = sourcePath.lastIndexOf('/');
  const dot = sourcePath.lastIndexOf('.');
  if (dot <= slash) {
    // No file extension — append suffix + .md.
    return `${sourcePath}${suffix}${MD_EXT}`;
  }
  return `${sourcePath.slice(0, dot)}${suffix}${sourcePath.slice(dot)}`;
}

/**
 * `Clips/The Article.md` → `Clips/The Article.annotations.md`, or, when `folder`
 * is set, `<folder>/Clips/The Article.annotations.md`.
 */
export function sidecarPathForSource(sourcePath: string, suffix = '.annotations', folder = ''): string {
  const base = alongsideSidecar(sourcePath, suffix);
  const root = trimSlashes(folder);
  return root ? `${root}/${base}` : base;
}

/** Does this path look like a sidecar (by naming convention)? */
export function isSidecarPath(path: string, suffix = '.annotations'): boolean {
  return path.endsWith(`${suffix}${MD_EXT}`);
}

/**
 * Best-effort inverse of {@link sidecarPathForSource}, used to guess the source
 * for a sidecar by name alone. Returns `null` if the path is not a sidecar.
 * When `folder` is set, its prefix is stripped before inverting. Callers that
 * have the file should prefer the sidecar's `annotates` frontmatter.
 */
export function sourcePathForSidecar(
  sidecarPath: string,
  suffix = '.annotations',
  folder = '',
): string | null {
  const tail = `${suffix}${MD_EXT}`;
  if (!sidecarPath.endsWith(tail)) return null;
  let path = sidecarPath;
  const root = trimSlashes(folder);
  if (root) {
    const prefix = `${root}/`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
  }
  return `${path.slice(0, -tail.length)}${MD_EXT}`;
}
