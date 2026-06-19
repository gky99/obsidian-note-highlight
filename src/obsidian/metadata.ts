/**
 * Adapter from Obsidian's metadata cache to the resolver's {@link SourceStructure}
 * (Design.md §9: map `pin`/`heading` → offsets without re-parsing).
 *
 * Only *type* imports from `obsidian` are used, so this module carries no runtime
 * dependency on Obsidian and is unit-tested against plain `CachedMetadata`-shaped
 * fixtures. The structural regions it produces are exactly the scopes the
 * resolver narrows its search to (§6.1–§6.2).
 */
import type { CachedMetadata, HeadingCache } from 'obsidian';
import type { Range } from '@/model/types';
import type { SourceStructure } from '@/resolver';

/** Separator used in stored heading paths, e.g. `"Intro › Background"`. */
export const HEADING_PATH_SEP = ' › ';

/**
 * For each heading, the `›`-joined path of its ancestor headings plus itself,
 * reconstructed from the flat heading list by tracking a level stack.
 * The returned array is index-aligned with `headings`.
 */
export function buildHeadingPaths(headings: readonly HeadingCache[]): string[] {
  const stack: { level: number; text: string }[] = [];
  return headings.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    const path = [...stack.map((s) => s.text), h.heading].join(HEADING_PATH_SEP);
    stack.push({ level: h.level, text: h.heading });
    return path;
  });
}

/** Start offset of the next heading whose level is `<=` `level`, else `sourceLength`. */
function sectionEnd(
  headings: readonly HeadingCache[],
  index: number,
  level: number,
  sourceLength: number,
): number {
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= level) return headings[j].position.start.offset;
  }
  return sourceLength;
}

interface HeadingRegions {
  /** Body only: from just after the heading line to the section end. */
  body: Range;
  /** Heading line through the section end — the widened window for §6.4. */
  through: Range;
}

/** Map each heading path to its body and heading-through-following regions. */
function headingRegionMap(
  cache: CachedMetadata,
  sourceLength: number,
): Map<string, HeadingRegions> {
  const headings = cache.headings ?? [];
  const paths = buildHeadingPaths(headings);
  const map = new Map<string, HeadingRegions>();
  headings.forEach((h, i) => {
    const end = sectionEnd(headings, i, h.level, sourceLength);
    const regions: HeadingRegions = {
      body: { from: h.position.end.offset, to: Math.max(h.position.end.offset, end) },
      through: { from: h.position.start.offset, to: Math.max(h.position.start.offset, end) },
    };
    // First occurrence of a path wins; also index the bare last segment as a
    // fallback so a stored full path still resolves if outer headings changed.
    if (!map.has(paths[i])) map.set(paths[i], regions);
    if (!map.has(h.heading)) map.set(h.heading, regions);
  });
  return map;
}

/** Map each block pin (`^id`) to its content region. */
function blockRegionMap(cache: CachedMetadata): Map<string, Range> {
  const map = new Map<string, Range>();
  const blocks = cache.blocks ?? {};
  for (const id of Object.keys(blocks)) {
    const b = blocks[id];
    map.set(`^${id}`, { from: b.position.start.offset, to: b.position.end.offset });
  }
  return map;
}

/**
 * Build a {@link SourceStructure} from a file's metadata cache. `sourceLength` is
 * the length of the current source text (used as the end sentinel for the last
 * section). Unknown pins/headings resolve to `null`, prompting the resolver to
 * widen scope rather than treat absence as the whole document (§6.2).
 */
export function buildStructure(cache: CachedMetadata, sourceLength: number): SourceStructure {
  const blocks = blockRegionMap(cache);
  const headings = headingRegionMap(cache, sourceLength);
  return {
    blockRegion(pin: string): Range | null {
      return blocks.get(pin) ?? null;
    },
    headingRegion(headingPath: string): Range | null {
      return headings.get(headingPath)?.body ?? null;
    },
    headingThroughFollowing(headingPath: string): Range | null {
      return headings.get(headingPath)?.through ?? null;
    },
  };
}

/** Heading path of the innermost section containing `offset`, or `undefined`. */
export function findEnclosingHeadingPath(
  cache: CachedMetadata,
  offset: number,
): string | undefined {
  const headings = cache.headings ?? [];
  const paths = buildHeadingPaths(headings);
  let result: string | undefined;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].position.start.offset <= offset) result = paths[i];
    else break;
  }
  return result;
}

/**
 * Id (without `^`) of the explicitly-id'd block containing `offset`, or
 * `undefined`. Only blocks that already carry a `^id` appear in the cache;
 * Marginalia never injects one (that would mutate the source, §4.1), so a
 * pin is simply omitted when the enclosing block is unlabelled.
 */
export function findEnclosingBlockId(cache: CachedMetadata, offset: number): string | undefined {
  const blocks = cache.blocks ?? {};
  for (const id of Object.keys(blocks)) {
    const p = blocks[id].position;
    if (p.start.offset <= offset && offset <= p.end.offset) return id;
  }
  return undefined;
}
