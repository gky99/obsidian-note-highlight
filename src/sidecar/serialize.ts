/**
 * Serialize a {@link Sidecar} back to Markdown matching the §5.2 example shape:
 * frontmatter, then per unit a `> `-prefixed blockquote (with `^anno-<id>` on its
 * last line), a blank line, the `` ```anno `` block, a blank line, the comment,
 * and a `---` separator between units for readability.
 *
 * The `anno` block uses a fence longer than the longest backtick run in its YAML
 * body (Design.md §4.4 / §10 #10) so backtick-bearing context never breaks out.
 * Content is emitted verbatim — never escaped.
 */
import { annoRef, type Annotation, type Sidecar } from '@/model/types';

import { dumpAnnoRecord, dumpFrontmatter } from './yaml';

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
  const body = dumpAnnoRecord(annotation.record).replace(/\n$/, '');
  const fence = chooseFence(body);
  return `${fence}anno\n${body}\n${fence}`;
}

/** Render one complete annotation unit (blockquote + anno block + comment). */
function serializeUnit(annotation: Annotation): string {
  const parts = [serializeBlockquote(annotation), '', serializeAnnoBlock(annotation)];
  if (annotation.comment.length > 0) {
    parts.push('', annotation.comment);
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
  // Units are separated by a blank line, an HR, and a blank line for readability.
  const body = units.join('\n\n---\n\n');
  const blocks = [`---\n${fm}\n---`];
  if (body.length > 0) blocks.push(body);
  return `${blocks.join('\n\n')}\n`;
}
