/**
 * Parse a sidecar `.md` file into the shared {@link Sidecar} model (Design.md §5).
 *
 * Units are detected *structurally*, never by the cosmetic `---` separators of
 * the §5.2 example. The unambiguous anchor of a unit is its `` ```anno `` fenced
 * code block; from each one we walk backward (over blank lines) to the
 * contiguous blockquote that carries the quote, and forward to the comment prose
 * that runs up to the next unit's blockquote (or EOF). Because comments are
 * bounded by the *next anno fence's* blockquote — not by any `---` or `>` line —
 * a comment may freely contain horizontal rules and quoted lines (§10 #10 test).
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
/** A bare horizontal-rule separator line (cosmetic between units). */
const HR_LINE = /^-{3,}$/;
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
  // `raw` already carries every key (known + unknown); just assert the shape.
  return raw as { id: string; status: AnnotationStatus } & AnnoRecord;
}

/** Locate every `anno` fenced block in the body, in document order. */
function findAnnoFences(bodyLines: string[]): AnnoFence[] {
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
      throw new SidecarParseError(
        `Unterminated anno code block opened at body line ${i + 1}.`,
      );
    }
    const yamlText = bodyLines.slice(i + 1, close).join('\n');
    let raw: Record<string, unknown>;
    try {
      raw = loadYaml(yamlText);
    } catch (err) {
      throw new SidecarParseError(
        `Invalid YAML in anno block at body line ${i + 1}: ${(err as Error).message}`,
      );
    }
    fences.push({ open: i, close, record: toAnnoRecord(raw, i) });
    i = close + 1;
  }
  return fences;
}

/**
 * Walk backward from `beforeIndex` (exclusive) over blank lines, then capture
 * the contiguous run of blockquote lines immediately above. Returns the raw
 * blockquote line indices `[start, end)` or `null` if none is found.
 */
function findBlockquoteAbove(
  bodyLines: string[],
  beforeIndex: number,
  lowerBound: number,
): { start: number; end: number } | null {
  let k = beforeIndex - 1;
  while (k >= lowerBound && bodyLines[k].trim() === '') k--;
  if (k < lowerBound || !BLOCKQUOTE_LINE.test(bodyLines[k])) return null;
  const end = k + 1;
  while (k >= lowerBound && BLOCKQUOTE_LINE.test(bodyLines[k])) k--;
  return { start: k + 1, end };
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
 * Extract comment prose from `bodyLines[from, to)`: drop surrounding blank lines
 * and a single lone `---` HR separator (cosmetic between units, §5.2).
 */
function extractComment(bodyLines: string[], from: number, to: number): string {
  let lo = from;
  let hi = to;
  while (lo < hi && bodyLines[lo].trim() === '') lo++;
  while (hi > lo && bodyLines[hi - 1].trim() === '') hi--;
  // A trailing lone HR that separates this unit from the next is cosmetic.
  if (hi > lo && HR_LINE.test(bodyLines[hi - 1].trim())) {
    hi--;
    while (hi > lo && bodyLines[hi - 1].trim() === '') hi--;
  }
  return bodyLines.slice(lo, hi).join('\n');
}

/**
 * Parse a complete sidecar file. Throws {@link SidecarSchemaError} if the schema
 * is missing/unsupported (§5.3) and {@link SidecarParseError} on malformed units.
 */
export function parseSidecar(text: string): Sidecar {
  const { frontmatter, bodyLines } = splitFrontmatter(text);
  const fences = findAnnoFences(bodyLines);

  const annotations: Annotation[] = [];
  for (let f = 0; f < fences.length; f++) {
    const fence = fences[f];
    const prevClose = f === 0 ? 0 : fences[f - 1].close + 1;

    const bq = findBlockquoteAbove(bodyLines, fence.open, prevClose);
    if (!bq) {
      throw new SidecarParseError(
        `anno block "${fence.record.id}" has no blockquote above it.`,
      );
    }
    const { quote, refId } = parseBlockquote(bodyLines.slice(bq.start, bq.end));
    if (refId !== null && refId !== fence.record.id) {
      // Spec: prefer the anno block's id when they disagree (§5.4 / requirement 3).
      // The quote ref is purely cosmetic and re-emitted from record.id on serialize.
    }

    // Comment runs from just after this anno block to the next unit's blockquote
    // (its preceding blank lines), or to EOF for the last unit.
    const commentEnd =
      f + 1 < fences.length
        ? (findBlockquoteAbove(bodyLines, fences[f + 1].open, fence.close + 1)?.start ??
          fences[f + 1].open)
        : bodyLines.length;
    const comment = extractComment(bodyLines, fence.close + 1, commentEnd);

    annotations.push({ id: fence.record.id, quote, record: fence.record, comment });
  }

  return { frontmatter, annotations };
}
