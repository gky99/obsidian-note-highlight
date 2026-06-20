/**
 * Serialize a {@link Sidecar} back to Markdown matching the §5.2 example shape:
 * frontmatter, then per unit a `> `-prefixed blockquote (with `^anno-<id>` on its
 * last line), a blank line, the `` ```anno `` block, and — when the unit has a
 * comment — a blank line, the comment prose, and the invisible `[/]:#` terminator
 * that closes it (§5.1). Units are separated by a blank line; no `---` rule is
 * emitted (a comment-less unit's forward scan would absorb it).
 *
 * The `anno` block carries `comment: true` exactly when comment prose follows — a
 * derived presence hint (the prose is the source of truth). It uses a fence
 * longer than the longest backtick run in its YAML body (Design.md §4.4 / §10
 * #10) so backtick-bearing context never breaks out. Content is verbatim.
 */
import { annoRef, type AnnoRecord, type Annotation, type Sidecar } from '@/model/types';

import { dumpAnnoRecord, dumpFrontmatter } from './yaml';

/** The invisible link-reference-definition that terminates a comment (§5.1). */
const COMMENT_END = '[/]:#';

/** Choose a backtick fence at least 3 long and longer than any run in `body`. */
function chooseFence(body: string): string {
  let longest = 0;
  const runs = body.match(/`+/g);
  if (runs) {
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Render one blockquote: each line `> `-prefixed, with the ref on the last line. */
function serializeBlockquote(annotation: Annotation): string {
  const ref = annoRef(annotation.record.id);
  const lines = annotation.quote.split('\n');
  const out = lines.map((line) => (line.length > 0 ? `> ${line}` : '>'));
  // Append the block ref to the last quote line, separated by three spaces to
  // mirror the §5.2 example.
  const last = out.length - 1;
  out[last] = `${out[last]}   ${ref}`;
  return out.join('\n');
}

/** Render the `` ```anno `` fenced block for an annotation. */
function serializeAnnoBlock(annotation: Annotation): string {
  // `comment: true` is a derived presence hint — emit it iff comment prose
  // actually follows, and never carry a stale flag from the record itself.
  const record: AnnoRecord = { ...annotation.record };
  delete (record as Record<string, unknown>).comment;
  if (annotation.comment.length > 0) {
    (record as Record<string, unknown>).comment = true;
  }
  const body = dumpAnnoRecord(record).replace(/\n$/, '');
  const fence = chooseFence(body);
  return `${fence}anno\n${body}\n${fence}`;
}

/** Render one unit's human-readable head: the blockquote, then its comment (if any). */
function serializeUnit(annotation: Annotation): string {
  const parts = [serializeBlockquote(annotation)];
  if (annotation.comment.length > 0) {
    // Comment follows the quote directly; `[/]:#` closes it (the anno block is no
    // longer adjacent to mark the end — it lives at the end of the file).
    parts.push('', annotation.comment, '', COMMENT_END);
  }
  return parts.join('\n');
}

/**
 * Serialize a sidecar to its Markdown form. The result re-parses to a value
 * deep-equal to the input (`parseSidecar(serializeSidecar(s))` is stable).
 */
export function serializeSidecar(sidecar: Sidecar): string {
  const fm = dumpFrontmatter(sidecar.frontmatter).replace(/\n$/, '');
  const units = sidecar.annotations.map(serializeUnit);
  const annoBlocks = sidecar.annotations.map(serializeAnnoBlock);
  // Human-readable quotes + comments first, then every machine `anno` block
  // collected at the END of the file (Design.md §5.1); each binds back to its quote
  // by the `^anno-<id>` ref, not by position. Blank-line separated, no `---` rule
  // (a comment-less unit's forward scan would absorb it).
  const sections = [`---\n${fm}\n---`];
  if (units.length > 0) sections.push(units.join('\n\n'));
  if (annoBlocks.length > 0) sections.push(annoBlocks.join('\n\n'));
  return `${sections.join('\n\n')}\n`;
}
