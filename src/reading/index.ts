/**
 * Reading-mode render path (Design.md §7.2) — public surface.
 *
 *  - {@link renderAnnoBlock}: body for
 *    `plugin.registerMarkdownCodeBlockProcessor('anno', renderAnnoBlock)` —
 *    hides the machine `anno` block.
 *  - {@link makeReadingHighlighter}: factory for
 *    `plugin.registerMarkdownPostProcessor(makeReadingHighlighter(store))` —
 *    best-effort highlight painting (the offset-accurate path is the CM6 editor
 *    extension, §7.1).
 *  - {@link ANNO_LANGUAGE}: the `` ```anno `` code-block language token.
 */
export {
  renderAnnoBlock,
  makeReadingHighlighter,
  ANNO_LANGUAGE,
  paintMissingHighlights,
} from './reading';

// Pure helpers, exported for unit testing and reuse.
export { projectQuoteToText, rangesOverlap, sectionSpan } from './project';
