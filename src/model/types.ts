/**
 * Core data model for Marginalia sidecar annotations.
 *
 * These types are the contract shared by every layer: sidecar I/O parses into
 * them and serializes from them; the resolver consumes a {@link Annotation}'s
 * selectors; the renderers and the aside panel read them out of the store.
 *
 * See Design.md §5 (file format) and §4 (key decisions).
 */

/** The only schema version this build understands. Gate parsing on it (§5.3). */
export const SCHEMA_VERSION = 'webclip-annotations/1';

/** A half-open character range `[from, to)` in some text's offset space. */
export interface Range {
  from: number;
  to: number;
}

/** An annotation is either anchored to a live source range, or orphaned (§4.6). */
export type AnnotationStatus = 'anchored' | 'orphaned';

/**
 * File-level metadata, stored as YAML frontmatter at the top of a sidecar.
 * See Design.md §5.3.
 */
export interface SidecarFrontmatter {
  /** Versioned format tag; gate parsing/migrations on it. */
  schema: string;
  /** Vault path of the source note this sidecar annotates. */
  annotates: string;
  /** Origin URL of the clip (provenance). */
  source_url?: string;
  /** Date the source was clipped (ISO `YYYY-MM-DD`). */
  clipped?: string;
  /** Hash of the source file's content; fast "did anything change?" check. */
  source_hash?: string;
  /** Unknown/forward-compatible frontmatter keys are preserved on round-trip. */
  [key: string]: unknown;
}

/**
 * The machine record carried by the `` ```anno `` fenced code block that sits
 * immediately after an annotation's blockquote (§4.4, §5.4).
 *
 * The exact quote is deliberately NOT duplicated here — it *is* the blockquote
 * (§4.3). Everything in this record is the durable, content-based target plus
 * presentation metadata.
 */
export interface AnnoRecord {
  /** Annotation identity; mirrors the `^anno-<id>` block ref on the quote. */
  id: string;
  /** Enclosing source block ID, e.g. `"^h1"`. Shrinks the search scope (§6.1). */
  pin?: string;
  /** Heading path of the enclosing section, e.g. `"Intro › Background"`. Fallback scope. */
  heading?: string;
  /** ~30 chars / few words of context immediately before the quote. */
  before?: string;
  /** ~30 chars / few words of context immediately after the quote. */
  after?: string;
  /** Hash of the whitespace-normalized quote; matches across reformatting. */
  qhash?: string;
  /** Whether the resolver could currently locate the quote. */
  status: AnnotationStatus;
  /** Presentation: highlight color name/token. */
  color?: string;
  /** Creation timestamp (ISO 8601). */
  created?: string;
  // Note: the on-disk `comment: true` flag is a *derived* presence hint emitted
  // by the serializer and stripped by the parser; it is intentionally NOT a field
  // here — the parsed {@link Annotation.comment} prose is the source of truth.
  /** Unknown/forward-compatible fields are preserved on round-trip. */
  [key: string]: unknown;
}

/**
 * One annotation unit: the three adjacent pieces of §5.1, parsed into a single
 * self-contained record (the locality rule means a unit never splits).
 */
export interface Annotation {
  /** Stable identity (mirrors {@link AnnoRecord.id} and the `^anno-<id>` ref). */
  id: string;
  /**
   * The blockquote text — the exact-match primary selector AND the human
   * reading-quote, the very same bytes (§4.3). May legitimately contain
   * Markdown markers (`##`, `**`) for heading-spanning refs (§6.4); these are
   * kept, not stemmed.
   */
  quote: string;
  /** The machine record from the `anno` block. */
  record: AnnoRecord;
  /** Free-form Markdown comment prose that follows the `anno` block (§5.1). */
  comment: string;
}

/** A fully parsed sidecar file: frontmatter + ordered annotation units. */
export interface Sidecar {
  frontmatter: SidecarFrontmatter;
  annotations: Annotation[];
}

/** The `^anno-` prefix used for the block reference on a quote. */
export const ANNO_REF_PREFIX = '^anno-';

/** Build the block-reference token (e.g. `"^anno-01J8X2"`) for an id. */
export function annoRef(id: string): string {
  return `${ANNO_REF_PREFIX}${id}`;
}
