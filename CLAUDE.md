# CLAUDE.md

Guidance for working in this repo. The full product design is in `docs/Design.md`
(read it before changing anchoring, the sidecar format, or rendering — every
non-obvious decision is justified there with the failure mode it avoids).

**Marginalia** is an Obsidian plugin: PDF-style annotation for Markdown notes.
Highlights are stored non-destructively in a per-source **sidecar** (`<note>.annotations.md`)
and re-anchored to the source **by content on every use** — never by stored offsets.

## Commands

```bash
pnpm install      # first run also builds esbuild's native binary (see gotchas)
pnpm test         # vitest, run mode  (src/**/*.test.ts)
pnpm test:watch
pnpm typecheck    # tsc --noEmit — the main correctness gate for runtime code
pnpm build        # typecheck + vite build → emits main.js at repo root
pnpm dev          # vite build --watch
```

Always run `pnpm typecheck` after touching Obsidian/CM6-bound code — it is checked
against the real `obsidian` + `@codemirror/*` types and is the only automated signal
for layers that can't be unit-tested.

## Architecture: pure core vs. Obsidian runtime

The single most important rule. Two zones:

**Pure core — Obsidian-free, fully unit-tested. Keep it that way.**
- `src/model/` — shared data types (the contract every layer builds on).
- `src/text/` — `normalize` (whitespace projection + index map back to true offsets), `hash` (qhash, sha-1), `locate` (reading-mode selection text → source offsets, best-effort; mirrors `reading/project`).
- `src/color.ts` — color resolution shared by every renderer: a stored color is a built-in token (`yellow`…`orange`, theme-aware CSS class) OR an arbitrary `#hex` (inline style). `renderColor()` returns `{ className?, background?, solid }`. Stored values are literal, never palette indices, so a highlight's look survives palette edits.
- `src/sidecar/` — parse/serialize the sidecar `.md` format; round-trip-safe.
- `src/resolver/` — the §6 selector cascade: exact → context → fuzzy → orphan.
- `src/obsidian/` — `metadata.ts` (metadataCache → resolver `SourceStructure`) and `sidecar-path.ts` (now folder-aware: optional `sidecarFolder` re-roots sidecars, mirroring the source path). These use **`import type` only** from `obsidian`, so they stay testable.

**Obsidian runtime — typechecked, NOT unit-tested (needs a live vault).**
- `src/store/` — load + live re-resolve + atomic sidecar write-back + highlight creation. The runtime hub.
- `src/editor/` — CM6 extension: `Decoration.mark` highlights (mapped through `RangeSet.map`), `anno`-block hiding, flash, reverse-nav.
- `src/reading/` — reading-mode processors (anno hider + best-effort highlighter).
- `src/ui/` — aside `ItemView`, settings tab, and `selection-toolbar.ts` (the floating highlight palette — see below).
- `src/navigation.ts`, `src/main.ts` — forward jump + plugin wiring.

When adding a module, decide its zone first. If it can be pure, make it pure.

## Tooling gotchas (learned the hard way)

- **pnpm ≥ 10 blocks build scripts.** A fresh `pnpm install` will NOT run esbuild's
  postinstall (vite needs its native binary) unless `pnpm-workspace.yaml` has
  `allowBuilds: { esbuild: true }`. Symptom: `[ERR_PNPM_IGNORED_BUILDS]` then vite
  fails to start. The setting lives in `pnpm-workspace.yaml`, **not** package.json
  (pnpm 11 stopped reading the `pnpm` field there).
- **Keep `obsidian` / `@codemirror/*` / `@lezer/*` external.** They're listed in
  `vite.config.ts` (`OBSIDIAN_PROVIDED`). Obsidian provides them at runtime;
  bundling your own copy breaks the editor. After a build, sanity-check:
  `grep -c "class Plugin" main.js` must be `0`.
- The build writes `main.js` to the repo root (`outDir: '.'`), which prints a
  harmless Vite warning. `main.js` / `main.js.map` are gitignored (build artifacts).
- Production uses an external sourcemap (`sourcemap: true`) so `main.js` stays lean
  (~210 KB). Don't switch to inline unless debugging — it 4×'s the file.

## Testing conventions

- Pure modules must **never import `obsidian` values** — only `import type` (erased
  by esbuild). vitest aliases `obsidian` → `test/obsidian-stub.ts`, which is
  intentionally minimal; a value import will fail or get an undefined symbol.
- `@codemirror/state` / `@codemirror/view` ARE real packages under vitest (installed
  devDeps), so pure CM6 logic (e.g. building a `DecorationSet` from specs) can be
  unit-tested — see `src/editor/highlights.test.ts`.
- Obsidian-runtime code (ItemView/DOM/workspace) is generally not unit-testable here.
  Extract any pure helper and test that instead (see `src/reading/project.ts`).
- **DOM-only logic can be tested with `happy-dom`** (a devDep): add `// @vitest-environment happy-dom`
  as the first line of the test file. `src/reading/reading.test.ts` does this to exercise the
  reading-mode painter against a fake store + `MarkdownPostProcessorContext` (no real vault).
- `src/pipeline.test.ts` is the end-to-end seam test (sidecar → resolve → serialize);
  keep it passing — it guards the §6.4 heading-spanning case and the orphan path.

## Design invariants — do not silently revert (see Design.md §4, §6)

- The **blockquote IS the primary selector** — the human quote and the match needle
  are the same bytes. Never duplicate the quote into the `anno` block.
- **Never store raw character offsets.** The durable target is quote + before/after
  context + structural pin; resolution is always live against current source bytes.
- **Orphan, never mis-point.** If the resolver can't find a passage confidently it
  returns `orphaned`; the plugin refuses to jump rather than scroll to a wrong spot.
  The resolver also orphans on *ambiguous duplicate* matches instead of fuzzy-guessing.
- **Normalize whitespace everywhere.** Matching runs on a whitespace-collapsed
  projection with an index map back to true offsets — the #1 survival mechanism for
  re-clips. Markdown markers (`##`, `**`) are preserved, never stemmed.
- **Sidecar YAML uses js-yaml `CORE_SCHEMA`,** not the default — the default parses
  unquoted ISO timestamps into `Date` objects, which corrupts the record on re-serialize.
- When serializing the `anno` block, the fence length adapts to any backticks in the
  content (`max(3, longestRun+1)`); content is verbatim, never escaped.

## Obsidian integration notes

- Reach the CM6 `EditorView` from a Markdown editor via the undocumented `editor.cm`
  (cast through `unknown`). Used by `repaint()` in `main.ts` and the flash in navigation.
- Highlights are pushed into each open editor for a file via a `StateEffect`
  (`setHighlights(view, specs)`); the ViewPlugin maps them through doc changes.
- Sidecar writes go through `vault.process` (atomic read-modify-write); a new sidecar
  is `vault.create`d with `schema`/`annotates`/`source_hash` frontmatter. With a custom
  `sidecarFolder`, the store `ensureParentFolder`s the mirrored path before create.

## Highlight-creation & color surfaces (added after the original design)

- **Floating selection toolbar** (`src/ui/selection-toolbar.ts`) — the primary way to
  highlight, replacing the command-only flow. Deliberately a **DOM-level** controller
  (watches `document` `selectionchange` AND `mousedown`, positions from a live client
  rect), NOT a CM6 ViewPlugin — because **reading mode has no CodeMirror**, and a single
  surface must serve both modes. It has two intents (a `ToolbarState` union):
  - **create** — a fresh selection over un-highlighted text → color swatches → highlight.
    Source range by mode: source/Live Preview → exact editor offsets; reading mode → only
    the selected text, re-located in source via `@/text/locate` (`findSourceRange`),
    best-effort, with a Notice on failure. Wired in `main.ts` (`highlightRequest`).
  - **edit** — clicking a painted `.mrg-highlight` (DOM `data-anno-id`, both modes), or
    selecting over one, → the same swatches (current color marked) **plus a delete
    button** → `onRecolor`/`onDelete` (`store.updateColor`/`deleteAnnotation`). A
    click-opened edit is *sticky* (survives the selection collapsing; dismissed by an
    outside click / Escape); a selection-over-highlight edit clears with the selection.
    The plugin resolves the edit target via `existingHighlight` → `store.getById` (click)
    / `store.annotationAt` (range).
  - **One passage, one highlight** (no stacking): a selection overlapping an existing
    highlight routes to *edit*, never create; and `store.createHighlight` itself refuses an
    overlapping range (`annotationAt` guard) so the rule holds for the command too.
  The old `src/editor/selection-toolbar.ts` (CM6) was removed.
- **Palette** is `settings.palette: string[]` (tokens or `#hex`). It drives the toolbar
  swatches, the aside card color picker, and the default-color dropdown. `loadSettings`
  clones it (so edits don't alias `DEFAULT_SETTINGS`) and refuses an empty list.
- **Aside card UI**: clicking a card jumps (no Jump button); the color control is one
  swatch button that opens a popup of palette swatches; each card has a trash/delete
  button (`store.deleteAnnotation`). Comment textarea is full-width.

## Known issues / unresolved

### Reading-mode highlights — RESOLVED (2026-06-20)
Reading-mode highlights paint correctly, verified against real Obsidian (v1.12.7) by
`test/playground/specs/reading-highlight.e2e.ts` for plain prose, quotes spanning
`**bold**`/`*italic*`/`` `code` ``, and quotes spanning links.

**Root cause was the painter, not timing.** The plumbing fixes (the `repaint()` gated
`previewMode.rerender(true)`, the `getSectionInfo`-null fallback) were already correct —
the e2e proved plain prose painted fine. The real failure was item #3 of the old debug
list: `highlightFirstMatch` matched the needle **within a single text node**, so any
quote crossing an inline element (`<strong>`, `<a>`, `<code>`) — the common case in real
notes — never matched and silently went unpainted.

The fix (two parts):
- `highlightFirstMatch` (`src/reading/reading.ts`) now matches against the
  **concatenation of all the element's text nodes** in document order, then wraps each
  contributing node's slice in its own `.mrg-highlight` span (same `data-anno-id`). One
  match can become several adjacent spans — visually one highlight, no DOM restructuring.
- `projectQuoteToText` (`src/reading/project.ts`) now reduces `[text](url)` →`text`,
  `[[a|b]]`→`b`, `[[a]]`→`a`, and drops images, so a needle over a link matches the
  rendered text (the renderer drops the URL + brackets).

Remaining limitation (acceptable, by design): a quote spanning **block** boundaries
(separate paragraphs / list items, which render as separate section elements) still won't
paint — the post-processor and the concat are per-element. Offset-accurate reading-mode
highlighting remains a **non-goal** (Design.md §7.2); CM6 is the authoritative path.

## Status / next step

Core is done and tested. The runtime layers build and typecheck; the selection toolbar,
custom palette, custom save location, and aside card controls were added this round.
**Verified working in-vault:** highlighting via the toolbar in Live Preview, the aside
panel, and reading-mode highlight rendering (incl. across inline formatting/links — see
the resolved issue above, covered by the e2e). Stretch goal still open: marginalia card
alignment via `coordsAtPos` (Design.md §7.3).
