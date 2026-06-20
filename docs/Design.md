# Marginalia — Design Document

> **Working title.** "Marginalia" is a placeholder; rename freely.

| | |
|---|---|
| **Status** | Draft — design agreed, not yet implemented |
| **Schema version** | `webclip-annotations/1` |
| **Last updated** | 2026-06-19 |
| **Author** | _(you)_ |

---

## 1. Summary

An Obsidian plugin that brings PDF-style annotation to **web clips and other Markdown notes**: highlight arbitrary spans of a source note, attach comments, and review them in a side panel that lines up with the text. Annotations are stored **non-destructively in a per-source sidecar file** written in plain, portable Markdown, and the link from an annotation back to its exact place in the source is **re-resolved live on every use** so it never goes stale across edits or re-clips.

The defining constraint, and the thing every decision below serves: **the stored file must be a useful, human-readable reading-note in any Markdown tool, while remaining a complete, machine-parseable anchor record that survives the source being edited underneath it.**

---

## 2. Goals and non-goals

### Goals

- Highlight **sub-block** spans (a phrase, a sentence) in a source note, not just whole blocks.
- Attach free-form Markdown comments to each highlight.
- Review all annotations for a note in a **side panel ("aside")**, ideally aligned vertically with their highlights.
- **Two-way navigation:** jump from an annotation to its exact source location, and from a highlight to its annotation card.
- **Non-destructive:** never modify the source clip.
- **Portable:** the annotation file is readable and meaningful outside Obsidian; the machine data survives sanitizers and foreign editors.
- **Re-anchor robustly:** survive edits to the source, including wholesale re-clips, or fail loudly (orphan) rather than silently mis-point.

### Non-goals (for v1)

- Annotating PDFs or EPUBs (Obsidian and other tools already do this).
- Real-time multi-user / collaborative annotation.
- Annotating arbitrary remote web pages in a browser (this is about *clipped* Markdown already in the vault).
- A bespoke clipper. We consume whatever Markdown the user's existing clipper produces.

---

## 3. Motivation

Obsidian's native cross-references are limited in exactly the ways this workflow needs them not to be:

- **Block references are block-granular.** `[[note#^id]]` lands on a whole paragraph; you cannot natively target a phrase inside it, and Obsidian explicitly does not support links into parts of quotes, callouts, or tables.
- **Backlinks are inferred, not stored.** The source→note connection lives only in Obsidian's index, not in the file, so it is neither portable nor guaranteed.
- **Native links resolve by ID, not by content.** A `^id` that survives a re-clip can silently point at different text; there is no notion of "I can no longer find this passage."

The plugin replaces ID-based targeting with **content-based targeting** (text-quote selectors with context), which simultaneously buys sub-block precision, portability, and honest orphan detection.

---

## 4. Key design decisions

These are the load-bearing choices. Each was chosen against a specific failure mode; record the *why* so they aren't accidentally reverted.

### 4.1 Storage: sidecar, one file per source

Annotations live in a companion file (e.g. `Clips/The Article.annotations.md`), **not inline in the source**. The source clip is never touched.

- **Why:** non-destructive; the source stays byte-identical and re-clippable. The sidecar doubles as the "reading note" the user wanted.
- **Cost accepted:** highlights are invisible in *other* Markdown apps (there's no markup in the source), and the link is "soft" — resolved by search rather than stored. Both are acceptable given the goals.
- **Alternative recorded:** *one note per annotation* in a folder. Better if the future need is cross-document thematic coding (each annotation becomes a queryable entity for Bases/Dataview), at the cost of file explosion and a worse per-document overview. Same anchor schema either way — only the container changes. **Chosen: single-file-per-source.** Revisit if cross-doc querying becomes primary.

### 4.2 Separate the anchor from the annotation

An annotation is a record of *(target, comment, presentation)*. The **target is a set of selectors**, never a single stored coordinate. This separation is what makes everything else possible.

### 4.3 The visible blockquote IS the primary selector

The human-readable quote and the machine's exact-match selector are **the same bytes**. The re-anchoring engine reads the blockquote text directly.

- **Why:** one copy → no drift between "what the user sees" and "what the machine matches"; the single most important anchor datum is also the most readable thing in the file.

### 4.4 Machine layer = a fenced code block (`` ```anno ```), not HTML

The non-human anchor data sits in a fenced code block immediately after the blockquote.

- **Rejected — HTML comment:** comments legally cannot contain `--`, and `-->` terminates them; clipped context text routinely contains both, silently truncating data. No standard escaping.
- **Rejected — hidden HTML element:** stripped by sanitizers (GitHub, static-site pipelines remove `data-*`, `hidden`, custom elements → data loss) and *leaks as visible escaped text* in renderers that default to `html: false`.
- **Chosen — fenced code block:**
  - Content is **verbatim** — no escaping; `-->`, `--`, em-dashes, quotes all pass through. The only reserved string is the closing fence, neutralized with a longer fence or tildes.
  - **Sanitizer- and renderer-proof:** every Markdown tool renders a code block as a code block; never stripped, never reflowed, never leaked as broken markup.
  - **Worst-case failure mode is "inert grey box"** — visibly contained, never corrupted. (Note the hidden element's worst case is *worse*: corrupted or visibly broken.)
  - **Hidden inside Obsidian** via `registerMarkdownCodeBlockProcessor("anno", …)` (reading mode) + a `Decoration.replace` in the editor extension (Live Preview), revealing raw text on cursor-enter.

### 4.5 Never store raw character offsets

Offsets are the most brittle selector, are wrong after almost any edit, and only help in the no-change case — where a quote search scoped to a block is already instant. Storing them mostly creates a bug surface where stale positions get trusted.

- **The durable target is the quad:** *quote + prefix + suffix + structural pin.* Offsets are a false sense of precision and are omitted.

### 4.6 Orphan, never silently drop or mis-point

If the resolver cannot find a passage, the annotation is marked `status: orphaned`, kept, and surfaced for review. The plugin **refuses to jump** rather than scroll to a plausible-looking wrong location. Honesty about "I lost this" is a feature, not a default.

### 4.7 Two distinct IDs

- `^anno-<id>` — durable identity of *the annotation* (a short, content-independent base36 id; per-file unique). Lets other notes link to it and lets re-anchoring rewrite every other field without breaking inbound links.
- `pin: "^h1"` — the *target block* in the source.
- The annotation `id` is **also stored inside the `anno` block** (`id:`), and it is now **the binding key**: the quote's `^anno-<id>` ref and the record's `id:` bind quote↔record *by id, not by position*. This is what lets the machine `anno` blocks be collected at the end of the file (§5.1) while each still resolves to its quote — the ref is load-bearing, no longer cosmetic.

### 4.8 Normalize whitespace everywhere

Web clips get reflowed and re-wrapped constantly — the #1 cause of "it broke on re-clip." Store quote/context whitespace-collapsed, and match against a whitespace-collapsed *projection* of the source with an index map back to real offsets.

---

## 5. File format

### 5.1 Anatomy

A sidecar is: **YAML frontmatter** (file-level metadata), then a sequence of **quote units**, then all the machine **`anno` blocks collected at the end of the file**. A quote unit is:

1. a **blockquote** carrying the quote and the `^anno-<id>` ref;
2. **comment prose** (ordinary Markdown — paragraphs, links, tags, lists, inline formatting), closed by an invisible `[/]:#` terminator.

The matching **`anno` block** (the machine record) lives in the trailing section and binds back to its quote **by id** (`^anno-<id>` ↔ `id:`), not by position (§4.7) — so it never has to interrupt the human-readable quote + comment. The reader sees quotes and notes together; the machine data sits out of the way at the bottom.

**Comment delimiting.** The comment is closed by a `[/]:#` sentinel — a link reference definition that every Markdown renderer emits as *nothing*, so it is invisible when read yet an explicit, machine-unambiguous end marker. The `anno` block also carries `comment: true` exactly when prose follows (a derived presence hint). As a safeguard against a missing/garbled sentinel, a **fenced code block or a blockquote line** (the next unit) also ends the comment — so a comment can never run away. Cost accepted by design: a comment supports lists and inline syntax but **not** blockquotes or code blocks (those terminate it); a `---` thematic rule, by contrast, is ordinary comment content. No `---` separator is written between units.

**Locality relaxed.** The original design kept all three pieces adjacent ("locality rule") so a hand-edit couldn't orphan half a record; collecting `anno` blocks at the end deliberately trades that for readability. The id-binding plus the §10 #11 resilience (fault isolation; a quote with no record is reported, a record with no quote is silently dropped) is what makes the relaxation safe.

### 5.2 Worked example

> The example below is wrapped in a 4-backtick fence so the inner 3-backtick `anno` block displays. In a real file the outer fence does not exist.

````markdown
---
schema: webclip-annotations/1
annotates: "Clips/The Article.md"
source_url: "https://example.com/the-article"
clipped: 2026-06-19
source_hash: "sha1:ab12cd34ef…"
---

> the sentence I care about   ^anno-A1B2C3

My note about why this matters — ordinary prose, [[wikilinks]], #tags,
multiple paragraphs, whatever.

[/]:#

> ## A quoted heading
> followed by text with **strong** emphasis   ^anno-D4E5F6

This reference spans a heading and the paragraph under it — see §6.4.

[/]:#

```anno
id: A1B2C3
pin: "^h1"
heading: "Intro › Background"
before: "…the words just before "
after: " the words right after…"
qhash: "3f9a"
status: anchored
color: yellow
created: 2026-06-19T10:32:00Z
comment: true
```

```anno
id: D4E5F6
pin: "^h4"
heading: "Methods"
before: "…preceding sentence. "
after: " The following sentence…"
qhash: "b1c2"
status: orphaned
color: green
created: 2026-06-19T11:05:00Z
comment: true
```
````

### 5.3 Frontmatter fields

| Field | Meaning |
|---|---|
| `schema` | Versioned format tag; gate parsing/migrations on it. |
| `annotates` | Vault path of the source note. |
| `source_url` | Origin URL of the clip (provenance). |
| `clipped` | Date the source was clipped. |
| `source_hash` | Hash of the source file's content; fast "did anything change?" check. |

### 5.4 `anno` block fields

| Field | Role | Fragility |
|---|---|---|
| `id` | Annotation identity; **binds the block to its quote** by matching the quote's `^anno-<id>` ref (§4.7), so the block can live anywhere (it is collected at the file end). | — |
| `pin` | Enclosing source block ID. Shrinks the search scope. | Low |
| `heading` | Heading path of the enclosing section (fallback scope). | Low |
| `before` / `after` | ~30 chars / ~5 words of context each side. Disambiguates duplicate quotes; tolerates edits elsewhere. | Medium |
| `qhash` | Hash of the whitespace-normalized quote; matches across reformatting. | — |
| `status` | `anchored` \| `orphaned`. | — |
| `comment` | `true` iff comment prose follows the block. Derived presence hint; the prose is the source of truth, so the parser strips it. | — |
| `color`, `created`, … | Presentation / metadata. | — |

The **exact quote** itself is not duplicated here — it *is* the blockquote (§4.3). Nor is the comment: it follows the *quote* as prose, closed by the `[/]:#` terminator (§5.1). The block carries only the machine record and binds back to its quote by `id` (§4.7).

### 5.5 Inner format choice

**YAML inside the fence.** Rationale: consistent with the frontmatter, human-legible, escaping fully defined, trivially parseable everywhere. JSON-on-one-line is a viable alternative (more compact, stricter) but loses legibility; not chosen.

---

## 6. Anchoring and re-resolution

### 6.1 Selector cascade (decreasing fragility)

This is the W3C Web Annotation / Hypothes.is model. Redundancy is the point.

1. **Exact quote** (the blockquote) — primary.
2. **Prefix + suffix context** — disambiguation + edit tolerance.
3. **Structural pin** — `pin` block ID, then `heading` path. Survives reflow within a section; crucially *shrinks the search space*.
4. **Document fingerprint** (`source_hash`) — has the source changed at all?
5. **Normalized-quote hash** (`qhash`) — match across reformatting.

### 6.2 Resolution order (at load / before any jump)

```
resolve(anno, sourceText):
  1. if hash(sourceText) == frontmatter.source_hash:
        # source untouched — locate quote within the pinned block. trivial. DONE.
  2. else scope := pinnedBlockRegion(anno.pin)
                   ?? headingSection(anno.heading)
                   ?? wholeDocument
  3. hits := findExact(anno.quote, scope)        # on normalized projection
        if hits == 1: return mapBack(hit)
        if hits  > 1: return disambiguateBy(before, after)
  4. fuzzy := fuzzyMatch(anno.quote, scope, threshold)   # diff-match-patch
        if fuzzy: return mapBack(fuzzy)
  5. anno.status := "orphaned"; surfaceForReview(); return NONE   # never guess
```

Resolution runs on a **whitespace-normalized projection** of the source, with an index map back to true offsets (§4.8). The same function feeds both highlight rendering and navigation — there is exactly one resolver.

### 6.3 Live re-resolution, not stored positions

Navigation and rendering both call `resolve()` against the *current* source bytes every time. Nothing trusts a saved coordinate. This is precisely why an edited or re-clipped source cannot send a jump to the wrong place — at worst it orphans.

### 6.4 Multi-block / heading-spanning references

A heading and the paragraph beneath it are **two separate blocks**, so a single `pin` block ID cannot cover a quote that includes a heading.

- The quote selector legitimately contains Markdown markers (`##`, `**`); match the **raw source form** and keep markers in the normalized projection — do not stem them away.
- For heading-inclusive references, pin to the heading and **widen the search window** to run from the pinned heading *through the following block(s)*, rather than assuming the whole quote lives in one block.
- Single-paragraph highlights remain clean single-block anchors. Branch on this in the resolver. **This is the one place the design quietly corrupts if implemented wrong — give it dedicated test cases.**

---

## 7. Rendering

> Confirmed straightforward in this project; specified here for completeness.

### 7.1 Editor (source / Live Preview — CodeMirror 6)

- A **ViewPlugin** (or StateField) holds resolved annotation ranges and emits `Decoration.mark` for highlights.
- Updates flow through a `StateEffect`; the decoration `RangeSet` is `.map()`-ed through document changes so highlights stay attached as the user types above them.
- The `anno` blocks are hidden with a `Decoration.replace` (collapse to nothing or a tiny widget), revealing raw text when the cursor enters the block — like native `**bold**` markup reveal.

### 7.2 Reading mode

- `registerMarkdownPostProcessor` renders highlights.
- `registerMarkdownCodeBlockProcessor("anno", …)` receives each block's raw text, ingests it into the store, and renders **nothing** (optionally a small clickable marker), making the block vanish.

### 7.3 The "aside" panel

- A custom `ItemView` registered via `registerView`, placed in the right sidebar; tracks the active file via `workspace.on('file-open')`.
- Renders one card per annotation: quote, editable comment, color, jump button.
- **Marginalia alignment (stretch):** use `EditorView.coordsAtPos(pos)` to read each highlight's screen Y and absolutely-position cards to line up with their highlights. Recompute on scroll + `ViewUpdate`; compute only for viewport-near annotations and debounce. No existing plugin does this well — it's the differentiator, and the fiddliest part (card collision/stacking, overlapping highlights).

---

## 8. Navigation

The jump is **plugin-owned**, because the target is a content selector Obsidian cannot interpret. It is a two-stage move: **find** (re-resolve, §6.3) then **go**.

### 8.1 Forward — annotation card → source

```
jumpTo(anno):
  range := resolve(anno, read(sourceFile))     # live; never a stored offset
  if !range: flagOrphan(anno); return          # refuse to guess (§4.6)
  open sourceFile
  setSelection(range); scrollIntoView(range, center)
  dispatch transient flash decoration
```

Block-pin fallback uses native `workspace.openLinkText("Source#^h1", path)`.

### 8.2 Reverse — highlight → annotation card

In the editor extension's `update()`, when the cursor/selection lands inside a painted highlight range, scroll the matching card into view and pulse it.

### 8.3 One resolver, three handlers

Forward jump, reverse pulse, and orphan-aware refusal are three small handlers over the single `resolve()` function. Both directions read the same in-memory store keyed by `^anno-id`.

---

## 9. Implementation surface (Obsidian / CM6)

- `registerEditorExtension([viewPlugin, stateField])` — loads the CM6 extension across all current/future editors; handles unload. **Mark all `@codemirror/*` packages `external` in the bundler** — Obsidian provides them; bundling your own copy breaks things.
- `@codemirror/view`: `ViewPlugin`, `Decoration.mark/.widget/.replace`, `DecorationSet`, `EditorView.coordsAtPos`, `EditorView.scrollIntoView`, `WidgetType`.
- `@codemirror/state`: `StateField`, `StateEffect`, `RangeSet` (`.map(tr.changes)`).
- `registerMarkdownPostProcessor` — reading-mode render path.
- `registerMarkdownCodeBlockProcessor("anno", …)` — ingest + hide the machine block.
- `registerView` + `ItemView`, `workspace.getRightLeaf`, `getLeavesOfType` — the aside.
- `app.metadataCache.getFileCache(file)` — `blocks`, `sections`, `headings`, `listItems` with positions; map `pin`/`heading` → offsets without re-parsing. Subscribe to `metadataCache.on('changed', …)`.
- `app.vault.cachedRead(file)` — read source for resolution.
- `app.vault.process(file, fn)` — atomic read-modify-write when updating a sidecar (e.g. flipping `status`, refreshing `before`/`after`).
- `app.fileManager.generateMarkdownLink` — link generation respecting user settings.

---

## 10. Edge cases and failure modes

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Anchor drift on live edits** | `RangeSet.map()` through CM transactions within a session. |
| 2 | **Edits made while plugin wasn't watching / by other apps** | Quote + context selector re-resolution at load (§6.2). |
| 3 | **Re-clip rewrites the whole source** | Only quote-selector re-anchoring survives; `source_hash` detects it; orphan + surface rather than mis-point. |
| 4 | **Three render modes** | Source/Live Preview via CM6; reading via post-processor — one store, two renderers. |
| 5 | **Heading-spanning quote crosses block boundary** | Widen search window past the pinned block (§6.4); dedicated tests. |
| 6 | **`coordsAtPos` cost on long notes** | Viewport-near only; debounce on scroll. |
| 7 | **Overlapping / nested highlights** | Mark decorations may overlap; define color/stacking + card collision rules. |
| 8 | **Quoted heading polluting the sidecar's own outline** | Verified acceptable in this project for the literal form; if it bites, store heading downgraded and re-style on render. |
| 9 | **Duplicate quote text in source** | `before`/`after` disambiguation; fall to fuzzy + orphan. |
| 10 | **Closing-fence collision in `anno`/quote content** | Use a longer outer fence / tildes when serializing. |
| 11 | **One corrupt / hand-edited unit** | Read path isolates per-unit (skip + report, keep the rest); write path stays strict (refuses rather than clobbering). Binding is id-aware (`^anno-<id>` recovery) so prose inserted between a quote and its fence doesn't break the link. |

---

## 11. Portability analysis

What a **non-Obsidian** consumer sees, by component:

- **Frontmatter** — standard YAML; treated as opaque/structured by virtually every tool.
- **Blockquote** — renders as a normal quote (with preserved headings/bold/etc.); *this is the human reading-note*.
- **`anno` block** — renders as an inert, contained code block; never stripped, never corrupted. Machine-parseable by a trivial script in any language via the documented schema.
- **Comment prose** — ordinary Markdown.

Net: the file is a faithful reading-note when rendered anywhere, and a complete anchor record when parsed anywhere. The only thing that does not travel is *clickable* navigation — which was never portable in Obsidian's native form either, and here is recoverable because the target is content, not an opaque ID.

---

## 12. Open questions and future work

- **Note-per-annotation mode** for cross-document thematic coding; Bases/Dataview aggregation over annotations as first-class entities.
- **Color/tag taxonomy** and filtering in the aside.
- **Orphan recovery UX** — a review queue with "re-attach here" affordance, à la Hypothes.is orphan handling.
- **Multiple sources per sidecar?** (Currently 1:1. Probably keep 1:1.)
- **Export** — to W3C Web Annotation JSON, or to inline-committed `==highlight==` + footnote form for a fully self-contained source.
- **Settings** — context length, fuzzy threshold, fence style, sidecar naming/location convention.
- **Performance budget** at N annotations / large vault.

---

## 13. Suggested implementation phases

1. **Core model + sidecar I/O** — parse/serialize frontmatter + annotation units; round-trip safety; schema gate.
2. **Resolver** — selector cascade, normalization + index map, multi-block window, orphan path. *Build this against fixtures first; it's the spine.*
3. **Editor rendering** — `Decoration.mark` highlights + `anno`-block hiding; `RangeSet` mapping.
4. **Reading-mode rendering** — post-processor + code-block processor.
5. **Aside panel** — `ItemView` card list; comment editing write-back.
6. **Navigation** — forward jump, reverse pulse, orphan refusal.
7. **Marginalia alignment** (stretch) — `coordsAtPos` positioning.
8. **Hardening** — re-clip/orphan flows, performance, overlaps.

---

## 14. Highlight management surface (added 2026-06-20)

Sections 1–13 describe the original design. This section is **append-only** and
records what was added and learned after the toolbar landed — it does not revise
the decisions above.

### 14.1 The selection toolbar is one surface with two intents

The floating toolbar (`src/ui/selection-toolbar.ts`) is the primary way to *manage*
highlights, not just create them. It is a single DOM-level controller (§7, §8.2)
watching `document` `selectionchange` **and** `mousedown`, with two intents modelled
as a discriminated `ToolbarState`:

- **create** — a fresh selection over un-highlighted text → palette swatches → highlight.
- **edit** — clicking a painted `.mrg-highlight` (read by `data-anno-id`), or selecting
  over one, → the same swatches with the current color marked **plus a comment button and
  a delete button**.

Why one surface, not a separate edit popup: the same control must serve source/Live
Preview **and** reading mode, and reading mode has no CodeMirror (§7.2). The DOM
`.mrg-highlight` element — painted identically by the CM6 extension and the reading-mode
post-processor — is the *only* signal common to both modes, so it is the anchor for
edit. A click opens a **sticky** edit (survives the selection collapsing; dismissed by
an outside click / Escape); a selection-over-highlight edit is non-sticky and clears
with the selection, exactly like create. The plugin resolves the clicked id / overlapping
range into an edit target via the store (`getById` / `annotationAt`) and applies recolor
/ comment / delete through the existing write-back path (§9) — no new persistence surface.

### 14.2 One passage, one highlight (no stacking)

Stacked, overlapping highlights have no coherent color or delete semantics, so a passage
is highlightable **at most once**. This is enforced in two places, defence-in-depth:

- **UI routing** — a selection overlapping an existing highlight opens *edit*, never a
  second *create*.
- **Store invariant** — `createHighlight` refuses a range overlapping any anchored
  highlight (`annotationAt` guard), so the rule also holds for the keyboard command and
  any future caller, not just the toolbar.

Overlap is computed against **live resolved ranges** (§6.3), never stored offsets — the
guard inherits the resolver's honesty (an orphaned highlight occupies no range, so it
never blocks a new one).

### 14.3 Repaint on Reading ↔ Editing mode switch (lesson learned)

**Symptom observed this session:** after toggling a pane between Reading and Editing,
highlights vanished until the next store change (a new highlight or a delete) repainted
them — which also made the edit toolbar look broken, since it needs a *painted* highlight
to click.

**Root cause:** repaint was driven only by `store.onChange` and by `file-open` /
`active-leaf-change`. **None of those fire on a same-leaf mode toggle.** So the freshly
shown CM editor came up with an empty `DecorationSet`, and the reading view re-rendered
from a cache that predated the highlights.

**Fix:** subscribe to the workspace `layout-change` event and repaint a view when its
render mode actually flips, tracked per-view in a `WeakMap<MarkdownView, mode>`. The guard
is load-bearing: `layout-change` also fires on pane resizes and other churn, and forcing a
reading-mode `previewMode.rerender(true)` on every one would flicker (and could loop on
notes whose quote legitimately can't be located in reading mode, §7.2). Repainting *only*
on a real Reading↔Editing transition makes it fire **exactly once** per switch.

**General principle:** treat *render mode* as a first-class input to repaint, alongside
*which file is active* and *what the annotations are*. A correct highlight set is necessary
but not sufficient — it must be re-pushed whenever the surface that displays it is rebuilt.

### 14.4 Comment in one click from the highlight (inline editor)

**Motivation:** with recolor/delete reachable in one click from a clicked highlight but
*commenting* only via the aside card, adding a comment meant click-highlight (reveal the
card) → find the card → click its comment field. The toolbar's comment button collapses
that to one click: it swaps the swatch row for an inline `<textarea>` positioned at the
highlight, pre-filled with the current comment.

Two non-obvious decisions:

- **Commit on blur, not per keystroke.** The aside's comment editor live-writes
  (debounced) because it can guard re-renders with `isEditing()`. The toolbar has no such
  guard, and every `store.updateComment` re-resolves and emits `onChange` → `repaint`.
  A live write would therefore risk repainting the very `.mrg-highlight` whose rect the
  toolbar is anchored to (and in reading mode, re-rendering the section), tearing the
  editor down mid-type. So the inline editor only writes the *changed* text once, on
  commit (blur / Escape / Cmd-Enter). (Comment edits don't change the highlight *set*, so
  the eventual commit's repaint is a no-op for reading mode and an identical-set re-push
  for CM — §14.3's signature guard.)
- **A dismiss-by-hide still saves.** The commit closure is also parked on the controller
  (`commitComment`); `hide()` and the next `build()` flush it, so closing the toolbar by
  an outside click / Escape / a jump to another highlight — paths where the textarea's own
  `blur` may not fire before the element is removed — never drops an in-progress comment.

### 14.5 A background re-render must not destroy a foreground popup (lesson learned)

**Symptom observed this session:** with the editor focused, clicking a card's color
button in the aside opened the swatch popup, which then *immediately closed itself*. It
only reproduced when the **editor** held focus first.

**Root cause:** clicking from the editor into the panel changes Obsidian's active leaf →
`active-leaf-change` → `syncActiveFile()` → `aside.setSourceFile(samePath)` +
`store.load()`. `store.load` emits `onChange` **unconditionally**, and *both*
`setSourceFile` and the `onChange → refresh()` it triggers call the aside's `render()` —
which begins by tearing down transient UI (`closeColorPopup()`, `root.empty()`). So a
re-render provoked by merely *focusing* the panel destroyed the popup the instant it
opened. The "editor focused first" condition is the tell: only then does clicking the
panel flip the active leaf and fire the redundant re-sync.

**Fix:** the panel already shielded an in-progress *comment edit* from store-driven
re-renders (the `isEditing()` guard in `refresh()`, §14.3 / the aside's "don't yank the
textarea" rule). Generalize it: `isBusy()` = `isEditing() || colorPopup != null`; guard
`refresh()` on `isBusy()`; and have `setSourceFile` skip the render on a **redundant
same-file** sync while busy (`if (!sameFile || !isBusy()) render()`). A real file switch
still renders. Transient foreground UI now survives a redundant background re-render and
is reconciled when the interaction ends — picking a swatch calls `closeColorPopup()` first,
then its `updateColor` write re-renders the card fresh.

**General principle:** a full list re-render is *destructive* to any transient, user-owned
UI mounted over it (an open popup, a focused inline editor). Treat "is the user
mid-interaction?" as a first-class input to **whether to re-render at all**, and make
redundant syncs (same file, no data change) no-ops rather than rebuilds. A complementary
upstream guard is possible — `syncActiveFile()` could skip the reload entirely when the
source path is unchanged, sparing the re-resolve on every `active-leaf-change` — but the
panel-side `isBusy()` guard is the load-bearing fix, since `onChange` can also fire from a
genuine background edit while a popup is open.

