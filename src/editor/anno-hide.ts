/**
 * Hide the machine `anno` fenced code blocks in Live Preview (Design.md §4.4,
 * §7.1). Each `` ```anno `` block is replaced by a tiny collapsed widget so the
 * sidecar reads as a clean human note. When `revealAnnoBlocks` is on and the
 * selection intersects a block, it is shown raw instead — mirroring Obsidian's
 * native markup reveal on cursor-enter.
 *
 * Best-effort and defensive (§4.4): the primary path walks the CM6 syntax tree;
 * if that yields nothing (unexpected grammar, no markdown language loaded), it
 * falls back to a plain line scan for ``` fences. If hiding fails entirely, the
 * block simply stays visible as an inert code block — an acceptable worst case.
 * Nothing here ever throws.
 */

import { RangeSetBuilder, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/** The info-string that marks a machine block. */
const ANNO_INFO = 'anno';

/** A block's line span `[fromLine, toLine]` plus its char range `[from, to)`. */
interface AnnoBlock {
  from: number;
  to: number;
}

/** Collapsed marker rendered in place of a hidden `anno` block. */
class AnnoCollapsedWidget extends WidgetType {
  eq(): boolean {
    // All collapsed markers are interchangeable.
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'mrg-anno-collapsed';
    el.textContent = '⟨anno⟩';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const collapsedWidget = new AnnoCollapsedWidget();

/** True if `[a0,a1)` and `[b0,b1)` overlap (touching endpoints count). */
function intersects(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

/** Does any selection range touch `[from, to]`? Used for cursor-reveal. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (intersects(range.from, range.to, from, to)) return true;
  }
  return false;
}

/**
 * Primary path: find `anno` fenced blocks via the syntax tree. The CM6 markdown
 * grammar names fenced blocks `FencedCode` with a `CodeInfo` child carrying the
 * info string. Returns `null` (not `[]`) when the tree shape gives us no usable
 * fenced nodes at all, so the caller can decide to try the fallback.
 */
function blocksFromTree(state: EditorState): AnnoBlock[] | null {
  let sawFenced = false;
  const blocks: AnnoBlock[] = [];
  try {
    const tree = syntaxTree(state);
    tree.iterate({
      enter(node) {
        if (node.name !== 'FencedCode') return undefined;
        sawFenced = true;
        // The info string is the first line after the opening fence.
        const infoNode = node.node.getChild('CodeInfo');
        let info = '';
        if (infoNode) {
          info = state.doc.sliceString(infoNode.from, infoNode.to).trim();
        } else {
          // No CodeInfo child: read the remainder of the opening fence line.
          const openLine = state.doc.lineAt(node.from);
          info = openLine.text.replace(/^\s*(`{3,}|~{3,})/, '').trim();
        }
        if (info.toLowerCase() === ANNO_INFO) {
          blocks.push({ from: node.from, to: node.to });
        }
        return false; // do not descend into the block's children
      },
    });
  } catch {
    return null; // tree unavailable/unexpected — let caller try the fallback
  }
  return sawFenced ? blocks : null;
}

/**
 * Fallback path: a tolerant line scan for ``` ```anno ``` (or `~~~anno`) fences.
 * Pairs each opener with the next matching closing fence; an unterminated fence
 * runs to end-of-document. Never throws.
 */
function blocksFromLineScan(state: EditorState): AnnoBlock[] {
  const blocks: AnnoBlock[] = [];
  const doc = state.doc;
  const total = doc.lines;
  const fenceRe = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)/;
  let i = 1;
  while (i <= total) {
    const line = doc.line(i);
    const open = fenceRe.exec(line.text);
    if (!open) {
      i += 1;
      continue;
    }
    const fenceChar = open[2][0];
    const fenceLen = open[2].length;
    const info = open[3].trim().toLowerCase();
    // Find the closing fence: same char, length >= opener, no info string.
    let endLine = total;
    let j = i + 1;
    const closeRe = new RegExp(`^\\s*\\${fenceChar}{${fenceLen},}\\s*$`);
    while (j <= total) {
      if (closeRe.test(doc.line(j).text)) {
        endLine = j;
        break;
      }
      j += 1;
    }
    if (info === ANNO_INFO) {
      blocks.push({ from: line.from, to: doc.line(endLine).to });
    }
    i = endLine + 1;
  }
  return blocks;
}

/**
 * Pure-ish builder (no view needed): produce the replace-decoration set hiding
 * each `anno` block, except blocks the selection touches when `reveal` is on.
 */
function buildAnnoDecorations(state: EditorState, reveal: boolean): DecorationSet {
  const fromTree = blocksFromTree(state);
  const blocks = fromTree ?? blocksFromLineScan(state);
  if (blocks.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  for (const block of blocks) {
    if (block.to <= block.from) continue;
    if (reveal && selectionTouches(state, block.from, block.to)) continue;
    ranges.push(
      Decoration.replace({ block: true, widget: collapsedWidget }).range(
        block.from,
        block.to,
      ),
    );
  }
  // `blocksFrom*` already yields blocks in document order; sort defensively.
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

/**
 * Build the `anno`-hiding StateField. `reveal` comes from
 * `settings.revealAnnoOnCursor`. The set is rebuilt on any doc change, and —
 * when revealing — on selection change too (so entering/leaving a block toggles
 * it). Returns the field wired to provide its decorations to the view.
 */
export function annoHideField(reveal: boolean): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return safeBuild(state, reveal);
    },
    update(value, tr) {
      if (tr.docChanged || (reveal && tr.selection)) {
        return safeBuild(tr.state, reveal);
      }
      return value.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Wrap the builder so a defensive failure degrades to "show the block". */
function safeBuild(state: EditorState, reveal: boolean): DecorationSet {
  try {
    return buildAnnoDecorations(state, reveal);
  } catch {
    return Decoration.none;
  }
}
