/**
 * Pure mapping between a source note's vault path and its sidecar's path
 * (Design.md §4.1 — one sidecar per source). No Obsidian dependency, so it is
 * unit-tested directly.
 *
 * The authoritative source→sidecar link at runtime is the sidecar's
 * `frontmatter.annotates` field; this path convention is how we *find* a
 * sidecar for a source (and decide where to create one) without reading files.
 *
 * An optional `folder` stores sidecars **directly** in that exact vault folder,
 * named by the source's basename — the source's directory path is NOT mirrored
 * beneath it. An empty folder keeps the sidecar alongside its source. (Trade-off:
 * two same-named notes in different folders map to the same sidecar; the sidecar's
 * `annotates` frontmatter remains the authoritative source link.)
 */

const MD_EXT = '.md';

/** Strip leading/trailing slashes from a folder path (`/A/B/` → `A/B`). */
function trimSlashes(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, '');
}

/** The last path segment (`Clips/The Article.md` → `The Article.md`). */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
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
 * is set, the sidecar is placed *directly* in that exact folder by basename:
 * `<folder>/The Article.annotations.md` (the source's directory is not mirrored).
 *
 * `disambiguator` (folder mode only) appends a `-N` number before the suffix to
 * resolve a basename collision between two same-named notes in different folders:
 * `Note.md` → `<folder>/Note.annotations.md` (N=0), `<folder>/Note-1.annotations.md`
 * (N=1), … The number is a free *slot*, not derived from the source — the store
 * locates a colliding sidecar by probing slots and matching `annotates`, never by
 * a stored offset.
 */
export function sidecarPathForSource(
  sourcePath: string,
  suffix = '.annotations',
  folder = '',
  disambiguator = 0,
): string {
  const root = trimSlashes(folder);
  if (!root) return alongsideSidecar(sourcePath, suffix);
  const name = basename(sourcePath);
  const extra = disambiguator > 0 ? `-${disambiguator}` : '';
  return `${root}/${alongsideSidecar(name, `${extra}${suffix}`)}`;
}

/** Does this path look like a sidecar (by naming convention)? */
export function isSidecarPath(path: string, suffix = '.annotations'): boolean {
  return path.endsWith(`${suffix}${MD_EXT}`);
}

/**
 * Best-effort inverse of {@link sidecarPathForSource}, used to guess the source
 * for a sidecar by name alone. Returns `null` if the path is not a sidecar.
 * When `folder` is set, its prefix is stripped before inverting — but because a
 * folder flattens sidecars by basename, only the basename can be recovered (the
 * source's original directory is lost). Callers that have the file should prefer
 * the sidecar's `annotates` frontmatter, which records the true source path.
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
