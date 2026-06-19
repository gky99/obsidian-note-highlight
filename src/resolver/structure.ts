/**
 * Obsidian-agnostic structural scope provider for the resolver.
 *
 * The resolver narrows its search to a *region* of the source before it ever
 * looks at text (Design.md §6.1 step 3, §6.2 step 2). Where those regions come
 * from — Obsidian's `metadataCache` (blocks / headings / sections, §9) in
 * production, or explicit offsets in tests — is hidden behind this interface so
 * the resolver itself stays pure and fully testable without Obsidian.
 *
 * Every region is a half-open {@link Range} in *original source offsets* (the
 * same offset space the resolver returns). `null` means "I don't know that
 * structural element" — the resolver then widens to the next scope rather than
 * treating absence as the whole document.
 */
import type { Range } from '@/model/types';

export interface SourceStructure {
  /**
   * Region (source offsets) of the pinned block's content, or `null` if the pin
   * id is unknown. This is the narrowest, least-fragile scope (§6.1).
   */
  blockRegion(pin: string): Range | null;

  /**
   * Region of the section *body* under a heading path (e.g. `"Intro › Background"`),
   * or `null` if the heading path is unknown. The fallback scope when the pin is
   * gone or too small (§6.2).
   */
  headingRegion(headingPath: string): Range | null;

  /**
   * Region running from a heading *through its following block(s)* — the widened
   * window for heading-spanning quotes that legitimately include the `##` line
   * plus the paragraph(s) beneath it (§6.4). `null` if the heading is unknown.
   *
   * In practice this is `headingRegion` extended to also cover the heading line
   * itself; a caller may make it identical to `headingRegion` when that already
   * includes the heading text.
   */
  headingThroughFollowing(headingPath: string): Range | null;
}

/**
 * Explicit region tables for an in-memory {@link SourceStructure}, keyed by pin
 * id / heading path. Anything absent resolves to `null`.
 */
export interface InMemoryStructureSpec {
  blocks?: Record<string, Range>;
  headings?: Record<string, Range>;
  headingThrough?: Record<string, Range>;
}

/**
 * Build a pure, in-memory {@link SourceStructure} from explicit region tables.
 * Used by tests (and any caller that already knows offsets) so the resolver can
 * be exercised without Obsidian's metadata cache.
 *
 * If `headingThrough` is omitted for a heading present in `headings`, the
 * heading region is reused — a convenient default when the heading region
 * already spans the heading line and its body.
 */
export function inMemoryStructure(
  spec: InMemoryStructureSpec = {},
): SourceStructure {
  const blocks = spec.blocks ?? {};
  const headings = spec.headings ?? {};
  const headingThrough = spec.headingThrough ?? {};
  return {
    blockRegion(pin: string): Range | null {
      return blocks[pin] ?? null;
    },
    headingRegion(headingPath: string): Range | null {
      return headings[headingPath] ?? null;
    },
    headingThroughFollowing(headingPath: string): Range | null {
      return headingThrough[headingPath] ?? headings[headingPath] ?? null;
    },
  };
}
