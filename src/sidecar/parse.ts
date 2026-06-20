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

  const schema = raw['schema'];
  if (typeof schema !== 'string' || schema !== SCHEMA_VERSION) {
    throw new SidecarSchemaError(
      typeof schema === 'string' ? schema : undefined,
      SCHEMA_VERSION,
    );
  }
  if (typeof raw['annotates'] !== 'string') {
    throw new SidecarParseError('Frontmatter is missing a string "annotates" path.');
  }

  return {
    frontmatter: raw as SidecarFrontmatter,
    bodyLines: lines.slice(end + 1),
  };
}

/** Coerce a parsed `anno` YAML mapping into a typed {@link AnnoRecord}. */
function toAnnoRecord(raw: Record<string, unknown>, fenceLine: number): AnnoRecord {
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new SidecarParseError(`anno block near line ${fenceLine + 1} is missing a string "id".`);
  }
  const status = raw['status'];
  if (status !== 'anchored' && status !== 'orphaned') {
    throw new SidecarParseError(
      `anno block "${id}" has an invalid status ${JSON.stringify(status)}; ` +
        'expected "anchored" or "orphaned".',
    );
  }
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
    let record: AnnoRecord;
    try {
      record = toAnnoRecord(raw, i);
    } catch (err) {
      report({ line: i + 1, message: (err as Error).message });
      i = close + 1;
      continue;
    }
    fences.push({ open: i, close, record });
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

/**
 * Extract a unit's comment prose, scanning forward from `from` (just after the
 * anno block). The comment ends at the FIRST of:
 *   - the `[/]:#` terminator line (consumed);
 *   - a fenced code block or blockquote line (safeguard — the next unit's head,
 *     or block content a comment does not support; left in place, never eaten);
 *   - end of file.
 * Surrounding blank lines are trimmed.
 */
function extractComment(bodyLines: string[], from: number): string {
  let hi = from;
  while (hi < bodyLines.length) {
    const line = bodyLines[hi];
    if (COMMENT_END.test(line.trim())) break;
    if (CODE_FENCE.test(line) || BLOCKQUOTE_LINE.test(line)) break;
    hi++;
  }
  let lo = from;
  while (lo < hi && bodyLines[lo].trim() === '') lo++;
  while (hi > lo && bodyLines[hi - 1].trim() === '') hi--;
  return bodyLines.slice(lo, hi).join('\n');
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
  }

  // The spine is the quote: each blockquote ending in `^anno-<id>` is a unit. Its
  // record is looked up by id (bound by the ref, not position); its comment is the
  // prose that follows. A record with no quote is dead data and silently ignored.
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
    const comment = extractComment(bodyLines, end);
    annotations.push({ id, quote, record, comment });
    i = end;
  }

  return { frontmatter, annotations };
}
