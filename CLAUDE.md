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
  (watches `document` `selectionchange`, positions from the selection's client rect), NOT
  a CM6 ViewPlugin — because **reading mode has no CodeMirror**, and a single surface must
  serve both modes. Source range by mode: source/Live Preview → exact editor offsets;
  reading mode → only the selected text, re-located in source via `@/text/locate`
  (`findSourceRange`), best-effort, with a Notice on failure. Wired in `main.ts`
  (`highlightRequest`). The old `src/editor/selection-toolbar.ts` (CM6) was removed.
- **Palette** is `settings.palette: string[]` (tokens or `#hex`). It drives the toolbar
  swatches, the aside card color picker, and the default-color dropdown. `loadSettings`
  clones it (so edits don't alias `DEFAULT_SETTINGS`) and refuses an empty list.
- **Aside card UI**: clicking a card jumps (no Jump button); the color control is one
  swatch button that opens a popup of palette swatches; each card has a trash/delete
  button (`store.deleteAnnotation`). Comment textarea is full-width.

## Known issues / unresolved

### Reading-mode highlights don't render in the live vault (UNRESOLVED)
Highlights paint in Live Preview/source (CM6) but **do not appear in reading mode** in
the user's vault, despite the fixes below. Treat this as the open thread.

What has been done:
- `repaint()` (`main.ts`) re-renders preview-mode views via `previewMode.rerender(true)`,
  gated on a per-source highlight signature (so comment edits don't flash the preview).
  Reading mode has no live decoration channel — the post-processor must re-run to repaint.
- The painter (`src/reading/reading.ts`) no longer hard-bails when `ctx.getSectionInfo(el)`
  is null; it falls back to a verbatim text search over the element.
- The painter is **proven correct in isolation** by `src/reading/reading.test.ts`
  (happy-dom): it wraps a plain-text quote with and without section info. So the bug is
  integration/timing, not the wrap logic.

Still broken after reload. Next step is **live debugging** — drop a temporary
`new Notice(...)`/`console.log` into `makeReadingHighlighter` and check, in order:
1. Is the post-processor even invoked for the note? Is `store.getResolved(ctx.sourcePath)`
   non-empty at paint time (sourcePath vs store key, store-loaded-yet)?
2. Does `previewMode.rerender(true)` actually re-run markdown post-processors in this
   Obsidian build, and does it fire after the store has loaded?
3. Was the test highlight over **inline-formatted** text? The painter wraps within a
   SINGLE text node by design, so a selection crossing `**bold**`/links never paints in
   reading mode (Live Preview is fine). Re-test with plain prose to rule this out.

Offset-accurate reading-mode highlighting is a **non-goal** (Design.md §7.2); CM6 is the
authoritative path and reading mode is the convenience layer. Don't over-invest here
unless the plain-prose case is confirmed broken after the checks above.

## Status / next step

Core is done and tested. The runtime layers build and typecheck; the selection toolbar,
custom palette, custom save location, and aside card controls were added this round.
**Verified working in-vault:** highlighting via the toolbar in Live Preview, the aside
panel. **Known broken:** reading-mode highlight rendering (see above). Stretch goal still
open: marginalia card alignment via `coordsAtPos` (Design.md §7.3).
