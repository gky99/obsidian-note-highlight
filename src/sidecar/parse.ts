/**
 * Parse a sidecar `.md` file into the shared {@link Sidecar} model (Design.md §5).
 *
 * The unit anchor is the **quote**: a blockquote whose last line carries an
 * `^anno-<id>` ref. Its comment is the prose that follows, up to an explicit
 * `[/]:#` terminator (§5.1). The machine `anno` blocks live collected at the end
 * of the file and bind back to their quotes **by id** (`^anno-<id>` ↔ `id:`), not
 * by position — so an anno block is never required to sit beside its quote.
 *
 * The comment also ends at a fenced code block or another blockquote (a safeguard
 * so it can't run away), which means comments support lists and inline syntax (a
 * `---` thematic rule is ordinary content) but not blockquotes or code blocks.
 */
import {
  ANNO_REF_PREFIX,
  SCHEMA_VERSION,
  type AnnoRecord,
  type Annotation,
  type AnnotationStatus,
  type Sidecar,
  type SidecarFrontmatter,
} from '@/model/types';

import { SidecarParseError, SidecarSchemaError } from './errors';
import { loadYaml } from './yaml';

/** Matches the opening fence of an `anno` block, e.g. ```` ```anno ```` (3+ ticks). */
const ANNO_FENCE_OPEN = /^(`{3,})anno\s*$/;
/** A blockquote line: `>` optionally followed by a space and content. */
const BLOCKQUOTE_LINE = /^>(?: ?(.*))?$/;
/** The comment terminator: the invisible `[/]:#` link-reference-definition sentinel. */
const COMMENT_END = /^\[\/\]:/;
/** A fenced code block opener (``` or ~~~) — a comment-ending safeguard. */
const CODE_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
/** Trailing `^anno-<id>` block ref on the last blockquote line. */
const ANNO_REF = new RegExp(`\\s*\\${ANNO_REF_PREFIX}([A-Za-z0-9]+)\\s*$`);

interface FrontmatterSplit {
  frontmatter: SidecarFrontmatter;
  /** The raw frontmatter block (incl. both `---` delimiters), normalized, no trailing newline. */
  frontmatterRaw: string;
  /** Body lines (everything after the closing frontmatter `---`). */
  bodyLines: string[];
}

/** A located `anno` fenced block within the body line array. */
interface AnnoFence {
  /** Index of the opening fence line. */
  open: number;
  /** Index of the closing fence line. */
  close: number;
  /** The parsed machine record. */
  record: AnnoRecord;
  /**
   * Whether the block carried `comment: true` — the load-bearing signal that this
   * annotation has a comment (§5.1). Captured before {@link toAnnoRecord} strips
   * the derived hint off the record; the quote scan reads it to decide whether to
   * extract a comment at all.
   */
  hasComment: boolean;
}

/**
 * A non-fatal problem with a single annotation unit. In **tolerant** mode (an
 * `onIssue` callback is passed to {@link parseSidecar}) the offending unit is
 * skipped and reported as one of these, so one corrupt unit never blanks the
 * rest of the sidecar's rendering. Frontmatter/schema problems stay fatal (throw).
 */
export interface ParseIssue {
  /** 1-based body line where the problem was detected (best effort). */
  line: number;
  /** Human-readable description of what went wrong. */
  message: string;
  /** The annotation id, when it could be recovered. */
  id?: string;
}

/** Strip the top-of-file YAML frontmatter (`---` … `---`) and validate its schema. */
function splitFrontmatter(text: string): FrontmatterSplit {
  // Tolerate a leading BOM and normalize CRLF so line handling is uniform.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0] !== '---') {
    throw new SidecarParseError(
      'Sidecar must begin with a YAML frontmatter block delimited by "---".',
    );
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new SidecarParseError('Unterminated frontmatter: missing closing "---".');
  }

  const yamlText = lines.slice(1, end).join('\n');
  let raw: Record<string, unknown>;
  try {
    raw = loadYaml(yamlText);
  } catch (err) {
    throw new SidecarParseError(`Invalid frontmatter YAML: ${(err as Error).message}`);
  }

  const version = raw['annotation_schema'];
  if (version !== SCHEMA_VERSION) {
    throw new SidecarSchemaError(
      typeof version === 'number' ? version : undefined,
      SCHEMA_VERSION,
    );
  }
  if (typeof raw['annotates'] !== 'string') {
    throw new SidecarParseError('Frontmatter is missing a string "annotates" link.');
  }

  return {
    frontmatter: raw as SidecarFrontmatter,
    frontmatterRaw: lines.slice(0, end + 1).join('\n'),
    bodyLines: lines.slice(end + 1),
  };
}

/**
 * Validate and normalize a record's `status`, migrating the legacy two-value
 * enum to the §6.5 confidence enum: `anchored → exact` (never `unique` without
 * evidence), `orphaned → orphan`. Returns `undefined` for an unrecognized value
 * so the caller can raise a precise parse error.
 */
function migrateAnnoStatus(raw: unknown): AnnotationStatus | undefined {
  switch (raw) {
    case 'unique':
    case 'exact':
    case 'orphan':
      return raw;
    case 'anchored':
      return 'exact';
    case 'orphaned':
      return 'orphan';
    default:
      return undefined;
  }
}

/** Coerce a parsed `anno` YAML mapping into a typed {@link AnnoRecord}. */
function toAnnoRecord(raw: Record<string, unknown>, fenceLine: number): AnnoRecord {
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new SidecarParseError(`anno block near line ${fenceLine + 1} is missing a string "id".`);
  }
  const status = migrateAnnoStatus(raw['status']);
  if (status === undefined) {
    throw new SidecarParseError(
      `anno block "${id}" has an invalid status ${JSON.stringify(raw['status'])}; ` +
        'expected "unique", "exact", or "orphan".',
    );
  }
  // Normalize a legacy value in place so a round-trip rewrites it to the new
  // enum (§6.5 migration); the cast below then carries the normalized record.
  raw['status'] = status;
  // `comment` in an anno block is a derived presence hint (set on serialize from
  // the actual prose); never keep it on the in-memory record — the parsed
  // `Annotation.comment` is the single source of truth for the comment.
  delete raw['comment'];
  // `raw` already carries every key (known + unknown); just assert the shape.
  return raw as { id: string; status: AnnotationStatus } & AnnoRecord;
}

/**
 * Locate every well-formed `anno` fenced block in the body, in document order.
 * A fence that is unterminated, carries invalid YAML, or fails record validation
 * is `report`ed and skipped — an unterminated fence also stops the scan, since
 * everything after it is *inside* the still-open block. In strict mode `report`
 * throws, preserving the all-or-nothing contract the write path relies on.
 */
function findAnnoFences(
  bodyLines: string[],
  report: (issue: ParseIssue) => void,
  seenIds: Set<string>,
): AnnoFence[] {
  const fences: AnnoFence[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    const m = ANNO_FENCE_OPEN.exec(bodyLines[i]);
    if (!m) {
      i++;
      continue;
    }
    const fence = m[1]; // the exact run of backticks that opened
    const closeRe = new RegExp(`^${fence}\\s*$`);
    let close = -1;
    for (let j = i + 1; j < bodyLines.length; j++) {
      if (closeRe.test(bodyLines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      report({ line: i + 1, message: `Unterminated anno code block opened at body line ${i + 1}.` });
      break;
    }
    const yamlText = bodyLines.slice(i + 1, close).join('\n');
    let raw: Record<string, unknown>;
    try {
      raw = loadYaml(yamlText);
    } catch (err) {
      report({
        line: i + 1,
        message: `Invalid YAML in anno block at body line ${i + 1}: ${(err as Error).message}`,
      });
      i = close + 1;
      continue;
    }
    // Remember the id even if validation rejects the block, so a quote referencing
    // it reports a *single* specific error (here) rather than also "no anno block".
    if (typeof raw['id'] === 'string') seenIds.add(raw['id']);
    // Read the comment-presence flag before `toAnnoRecord` strips it off the record.
    const hasComment = raw['comment'] === true;
    let record: AnnoRecord;
    try {
      record = toAnnoRecord(raw, i);
    } catch (err) {
      report({ line: i + 1, message: (err as Error).message });
      i = close + 1;
      continue;
    }
    fences.push({ open: i, close, record, hasComment });
    i = close + 1;
  }
  return fences;
}

/** The id in a blockquote line's trailing `^anno-<id>` ref, or `null`. */
function refIdOfLine(line: string): string | null {
  const bm = BLOCKQUOTE_LINE.exec(line);
  if (!bm) return null;
  const rm = ANNO_REF.exec(bm[1] ?? '');
  return rm ? rm[1] : null;
}

/**
 * From a blockquote's raw lines, recover the quote text and its `^anno-<id>`.
 * Strips the leading `>`/`> ` from each line, joins with `\n`, and splits off
 * the trailing block ref. Returns `quote` with trailing ref-whitespace trimmed.
 */
function parseBlockquote(quoteLines: string[]): { quote: string; refId: string | null } {
  const stripped = quoteLines.map((line) => {
    const m = BLOCKQUOTE_LINE.exec(line);
    // Every line was validated as a blockquote line before we got here.
    return m && m[1] !== undefined ? m[1] : '';
  });
  let text = stripped.join('\n');
  let refId: string | null = null;
  const refMatch = ANNO_REF.exec(text);
  if (refMatch) {
    refId = refMatch[1];
    text = text.slice(0, refMatch.index);
  }
  // Trim trailing whitespace left where the ref was (but keep internal newlines).
  return { quote: text.replace(/[ \t]+$/, ''), refId };
}

interface CommentScan {
  /** Trimmed comment prose (terminator excluded). */
  text: string;
  /**
   * Exclusive body-line index where the unit's comment region ends on disk — the
   * line *after* the `[/]:#` terminator when one closed it, else the trimmed
   * content end (so a comment-less unit yields `from`). {@link parseLayout} uses
   * this to know a unit's full span for in-place patching.
   */
  regionEnd: number;
}

/**
 * Scan a unit's comment region starting at `from` (just after the blockquote run).
 *
 * The `comment: true` flag on the `anno` block is **authoritative** (§5.1): when
 * `hasComment` is false the annotation has no comment, so we return immediately
 * (region collapses to `from`) and any prose that follows the quote is left as
 * custom content rather than absorbed. When `hasComment` is true, the comment ends
 * at the FIRST of:
 *   - the `[/]:#` terminator line (consumed — part of the region, not the prose);
 *   - a fenced code block or blockquote line (the **safeguard**, used only when the
 *     `[/]:#` end mark is missing — the next unit's head, or block content a comment
 *     can't hold; left in place, never eaten);
 *   - end of file.
 * Surrounding blank lines are trimmed from the prose.
 */
function scanComment(bodyLines: string[], from: number, hasComment: boolean): CommentScan {
  if (!hasComment) return { text: '', regionEnd: from };
  let hi = from;
  let terminator = -1;
  while (hi < bodyLines.length) {
    const line = bodyLines[hi];
    if (COMMENT_END.test(line.trim())) {
      terminator = hi;
      break;
    }
    if (CODE_FENCE.test(line) || BLOCKQUOTE_LINE.test(line)) break;
    hi++;
  }
  // Trim trailing blanks down toward `from` first (guarded by `from`, not the
  // leading cursor) so a comment-LESS unit collapses its region to `from` instead
  // of swallowing the blank separator that follows the blockquote.
  let contentHi = hi;
  while (contentHi > from && bodyLines[contentHi - 1].trim() === '') contentHi--;
  let lo = from;
  while (lo < contentHi && bodyLines[lo].trim() === '') lo++;
  return {
    text: bodyLines.slice(lo, contentHi).join('\n'),
    regionEnd: terminator !== -1 ? terminator + 1 : contentHi,
  };
}

/** The trimmed comment prose for a unit (see {@link scanComment}). */
function extractComment(bodyLines: string[], from: number, hasComment: boolean): string {
  return scanComment(bodyLines, from, hasComment).text;
}

/**
 * Parse a complete sidecar file. Frontmatter/schema problems are always fatal
 * ({@link SidecarSchemaError} / {@link SidecarParseError}).
 *
 * Per-*unit* problems are handled by mode. Pass `onIssue` for **tolerant** parsing:
 * the bad unit is skipped and reported (one corrupt unit never blanks the file's
 * rendering — the read path). Omit it for **strict** parsing: the first unit
 * problem throws, so a read-modify-write refuses rather than clobbering an
 * unparseable unit (the write path).
 */
export function parseSidecar(text: string, onIssue?: (issue: ParseIssue) => void): Sidecar {
  const report = (issue: ParseIssue): void => {
    if (onIssue) onIssue(issue);
    else throw new SidecarParseError(issue.message);
  };

  const { frontmatter, bodyLines } = splitFrontmatter(text);

  // Collect every `anno` block (by design they trail at the end of the file) and
  // index its record by id; remember the fence line ranges so the quote scan below
  // never mistakes an anno block's YAML for a blockquote.
  const seenIds = new Set<string>();
  const fences = findAnnoFences(bodyLines, report, seenIds);
  const recordsById = new Map<string, AnnoRecord>();
  const hasCommentById = new Map<string, boolean>();
  const fenceLines = new Set<number>();
  for (const fence of fences) {
    for (let l = fence.open; l <= fence.close; l++) fenceLines.add(l);
    if (recordsById.has(fence.record.id)) {
      report({
        line: fence.open + 1,
        id: fence.record.id,
        message: `duplicate anno block id "${fence.record.id}"; keeping the first.`,
      });
      continue;
    }
    recordsById.set(fence.record.id, fence.record);
    hasCommentById.set(fence.record.id, fence.hasComment);
  }

  // The spine is the quote: each blockquote ending in `^anno-<id>` is a unit. Its
  // record is looked up by id (bound by the ref, not position); its comment is the
  // prose that follows *iff its record says `comment: true`* (§5.1). A record with
  // no quote is dead data and silently ignored.
  const annotations: Annotation[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    if (fenceLines.has(i) || !BLOCKQUOTE_LINE.test(bodyLines[i])) {
      i++;
      continue;
    }
    // Capture the contiguous blockquote run; its last line carries the ref.
    let end = i;
    while (end < bodyLines.length && !fenceLines.has(end) && BLOCKQUOTE_LINE.test(bodyLines[end])) {
      end++;
    }
    const id = refIdOfLine(bodyLines[end - 1]);
    if (id === null) {
      i = end; // a blockquote with no `^anno-<id>` ref is ordinary content, not a unit
      continue;
    }
    const record = recordsById.get(id);
    if (!record) {
      // Suppress the miss if a fence with this id existed but failed validation —
      // that specific error was already reported by findAnnoFences.
      if (!seenIds.has(id)) {
        report({ line: i + 1, id, message: `quote "^anno-${id}" has no matching anno block.` });
      }
      i = end;
      continue;
    }
    const { quote } = parseBlockquote(bodyLines.slice(i, end));
    const comment = extractComment(bodyLines, end, hasCommentById.get(id) ?? false);
    annotations.push({ id, quote, record, comment });
    i = end;
  }

  return { frontmatter, annotations };
}

/** The on-disk line span of one annotation, for in-place patching (half-open `[start, end)`). */
export interface UnitLayout {
  id: string;
  /** Body-line span of the unit's human head: blockquote + comment + `[/]:#` terminator. */
  unitStart: number;
  unitEnd: number;
  /** Body-line span of this id's machine `anno` fenced block. */
  annoStart: number;
  annoEnd: number;
}

/**
 * A strict parse that additionally exposes the body-line layout needed to patch a
 * sidecar **in place** (Design.md §5.5 / structure-preserving writes): per-id unit
 * and `anno`-block spans, plus the two insertion points. Used by `patchSidecar`,
 * never the read path. Errors are fatal here (no tolerant mode) — matching the
 * strict write contract (a malformed unit refuses the write, never clobbers).
 */
export interface SidecarLayout {
  sidecar: Sidecar;
  /** Raw frontmatter block (incl. both `---`), normalized, no trailing newline. */
  frontmatterRaw: string;
  /** Body lines (everything after the closing frontmatter `---`). */
  bodyLines: string[];
  /** One entry per parsed unit, in document order of its blockquote. */
  units: UnitLayout[];
  /**
   * Every `anno` fenced block's body-line span (half-open), in document order —
   * including any whose quote was dropped. Consumers that reorder content (the
   * highlight sort) treat these as immovable boundaries.
   */
  annoSpans: { start: number; end: number }[];
  /**
   * Body-line index at which to insert a NEW unit: immediately before the first
   * fence of the **last** contiguous `anno`-block group (so a new highlight lands
   * right before the trailing machine blocks, after any custom content). Equals
   * `bodyLines.length` when there are no `anno` blocks.
   */
  newUnitAt: number;
  /**
   * Body-line index at which to append a NEW `anno` block: after the last existing
   * `anno` block (= end of body in the normal case). Equals `bodyLines.length`
   * when there are no `anno` blocks.
   */
  newAnnoAt: number;
}

export function parseLayout(text: string): SidecarLayout {
  // Strict: any per-unit problem throws (a malformed unit must refuse the write).
  const report = (issue: ParseIssue): never => {
    throw new SidecarParseError(issue.message);
  };

  const { frontmatter, frontmatterRaw, bodyLines } = splitFrontmatter(text);

  const seenIds = new Set<string>();
  const fences = findAnnoFences(bodyLines, report, seenIds);
  const recordsById = new Map<string, AnnoRecord>();
  const hasCommentById = new Map<string, boolean>();
  const annoSpanById = new Map<string, { start: number; end: number }>();
  const fenceLines = new Set<number>();
  for (const fence of fences) {
    for (let l = fence.open; l <= fence.close; l++) fenceLines.add(l);
    if (recordsById.has(fence.record.id)) {
      report({
        line: fence.open + 1,
        id: fence.record.id,
        message: `duplicate anno block id "${fence.record.id}"; keeping the first.`,
      });
    }
    recordsById.set(fence.record.id, fence.record);
    hasCommentById.set(fence.record.id, fence.hasComment);
    annoSpanById.set(fence.record.id, { start: fence.open, end: fence.close + 1 });
  }

  const annotations: Annotation[] = [];
  const units: UnitLayout[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    if (fenceLines.has(i) || !BLOCKQUOTE_LINE.test(bodyLines[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < bodyLines.length && !fenceLines.has(end) && BLOCKQUOTE_LINE.test(bodyLines[end])) {
      end++;
    }
    const id = refIdOfLine(bodyLines[end - 1]);
    if (id === null) {
      i = end;
      continue;
    }
    const record = recordsById.get(id);
    if (!record) {
      if (!seenIds.has(id)) {
        report({ line: i + 1, id, message: `quote "^anno-${id}" has no matching anno block.` });
      }
      i = end;
      continue;
    }
    const { quote } = parseBlockquote(bodyLines.slice(i, end));
    const { text: comment, regionEnd } = scanComment(bodyLines, end, hasCommentById.get(id) ?? false);
    const annoSpan = annoSpanById.get(id);
    // `record` came from `recordsById`, so its span is always present.
    if (annoSpan) {
      annotations.push({ id, quote, record, comment });
      units.push({
        id,
        unitStart: i,
        unitEnd: regionEnd,
        annoStart: annoSpan.start,
        annoEnd: annoSpan.end,
      });
    }
    i = end;
  }

  // Insertion points. New `anno` blocks trail after the last existing one.
  const newAnnoAt =
    fences.length > 0 ? Math.max(...fences.map((f) => f.close)) + 1 : bodyLines.length;
  // A new unit goes before the **last contiguous `anno`-block group**. A "group" is a
  // maximal run of fences separated only by blank lines; any non-blank line between two
  // fences (a unit, a heading, prose) starts a new group. Walk back from the final fence
  // while consecutive fences are blank-separated, and insert at that group's first fence.
  // (This is independent of where the units sit — a file may keep every quote at the top
  // and still have several anno-block groups, so anchoring on the last unit's end would
  // wrongly pick the *first* group.)
  let newUnitAt: number;
  if (fences.length === 0) {
    newUnitAt = bodyLines.length;
  } else {
    let groupStart = fences[fences.length - 1].open;
    for (let k = fences.length - 1; k > 0; k--) {
      let onlyBlank = true;
      for (let l = fences[k - 1].close + 1; l < fences[k].open; l++) {
        if (bodyLines[l].trim() !== '') {
          onlyBlank = false;
          break;
        }
      }
      if (!onlyBlank) break;
      groupStart = fences[k - 1].open;
    }
    newUnitAt = groupStart;
  }

  const annoSpans = fences.map((f) => ({ start: f.open, end: f.close + 1 }));
  return {
    sidecar: { frontmatter, annotations },
    frontmatterRaw,
    bodyLines,
    units,
    annoSpans,
    newUnitAt,
    newAnnoAt,
  };
}
