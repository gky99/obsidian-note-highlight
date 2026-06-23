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

## Releasing

`.github/workflows/release.yml` auto-publishes a GitHub Release **on a version bump**.
To cut a release: bump `version` in `manifest.json` (add the matching `"<version>":
"<minAppVersion>"` line to `versions.json`; `package.json` `version` is kept in sync for
hygiene), commit, and push to `master`. The workflow then `pnpm build`s and publishes a
release **tagged with the exact version, no `v` prefix** (Obsidian/BRAT match the tag to
`manifest.json` verbatim), attaching the three assets Obsidian needs: `main.js`,
`manifest.json`, `styles.css` (`main.js` is gitignored, so it's built fresh in CI).

- **The tag-existence check is the real guard, not the path filter.** It triggers on a push
  touching `manifest.json` *or* the workflow file, then skips unless the manifest version has
  no tag yet — so it's idempotent (re-runs/workflow edits no-op) and `workflow_dispatch` can
  re-fire it. `pnpm test` + `pnpm build` gate the publish (a red test or typecheck blocks it).
- **CI Node must be ≥ 22.13** — `pnpm/action-setup@v4` installs pnpm 11, which refuses older
  Node (`node:sqlite` crash in setup-node's pnpm cache step). Pinned to `node-version: 22`.
- Needs repo **Settings → Actions → General → Workflow permissions = read/write** for the
  default `GITHUB_TOKEN` to create the tag + release (the workflow also requests
  `permissions: contents: write`).

## Architecture: pure core vs. Obsidian runtime

The single most important rule. Two zones:

**Pure core — Obsidian-free, fully unit-tested. Keep it that way.**
- `src/model/` — shared data types (the contract every layer builds on).
- `src/text/` — `normalize` (whitespace projection + index map back to true offsets), `hash` (qhash, sha-1), `locate` (reading-mode selection text → source offsets, best-effort; mirrors `reading/project`).
- `src/color.ts` — color resolution shared by every renderer: a stored color is a built-in token (`yellow`…`orange`, theme-aware CSS class) OR an arbitrary `#hex` (inline style). `renderColor()` returns `{ className?, background?, solid }`. Stored values are literal, never palette indices, so a highlight's look survives palette edits.
- `src/sidecar/` — parse/serialize the sidecar `.md` format; round-trip-safe.
- `src/resolver/` — the §6 selector cascade: exact → context → fuzzy → orphan.
- `src/obsidian/` — `metadata.ts` (metadataCache → resolver `SourceStructure`) and `sidecar-path.ts` (folder-aware: optional `sidecarFolder` is where a **new** sidecar is created, directly in that exact folder, named by the source's basename — the source's directory is *not* mirrored beneath it). An annotation file's identity is its `annotates` frontmatter (a wikilink), **not** its name/location, so a sidecar can be freely moved; lookup scans by `annotates` (`store.sidecarsFor`) and `resolveSourcePath` resolves it via `resolveAnnotates`/`annotatesLink`. These use **`import type` only** from `obsidian`, so they stay testable.
- `src/store/merge.ts` — pure helpers for combining a clip's annotation files: `pickPrimary` (the file that wins overlaps + receives new highlights) and `mergeResolved` (union across files, primary wins any id/range duplicate). Unit-tested (`merge.test.ts`).

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
- **Testing a worktree build in the live vault ("compile to root").** Obsidian loads the
  plugin from the repo root (the *master* worktree dir), but a feature worktree builds
  `main.js` into *its own* root. To run a branch in-vault, copy `main.js` + `main.js.map`
  (gitignored) **and** `styles.css` (tracked!) up to the plugin root. Because `styles.css` is
  tracked and loaded in place, deploying it there shows the master worktree as `M styles.css`
  — expected (it's the running build of the branch); it reconciles when the branch merges.

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
- **The `^anno-<id>` ref is the binding key (load-bearing, not cosmetic).** The quote's
  `^anno-<id>` and the record's `id:` bind quote↔record *by id, not by position*. Ids are
  short base36 (per-file unique via `store.freshId`), no longer ULIDs.
- **Never store raw character offsets.** The durable target is quote + before/after
  context + structural pin; resolution is always live against current source bytes.
- **Orphan, never mis-point.** If the resolver can't find a passage confidently it
  returns `orphaned`; the plugin refuses to jump rather than scroll to a wrong spot.
  The resolver also orphans on *ambiguous duplicate* matches instead of fuzzy-guessing.
- **Self-healing: the stored selector is kept equal to the live bytes (§6.5).** `status`
  is the persisted confidence `unique | exact | orphan` (NOT the old `anchored|orphaned`;
  legacy migrates on read, `store.suppressRepair`-style holds aside). `unique` gates a
  cheap re-anchor; fuzzy is a *repair trigger* (rewrite the quote to the matched bytes),
  not a resting state. The resolver searches the **whole body** normalized projection — pin/
  heading are a *confirmation signal*, not a search-space restriction — so don't reintroduce
  block-scoping as a correctness mechanism (it's only a perf option).
- **Frontmatter is excluded from every content matcher (§6.5).** A leading YAML block is
  metadata, never an annotation target, but its `title`/`description` duplicate body text
  (a clip's H1 *is* the page title) — so a whole-file search anchored a body highlight *into*
  the frontmatter, where Live Preview can't paint it (Properties widget) though reading mode's
  best-effort painter found the body copy: a highlight that shows in reading mode but not Live
  Preview. The resolver, creation (`unique` vs `exact` birth count), reading-mode locate
  (`text/locate`), and import locate (`import/locate`) all start at `text/frontmatter#bodyStart`
  (pure). A record mis-stamped `exact` by the old whole-file count whose quote also sits in the
  frontmatter is healed by a recovery branch: sole body match → anchor + promote to `unique`.
- **Normalize whitespace everywhere.** Matching runs on a whitespace-collapsed
  projection with an index map back to true offsets — the #1 survival mechanism for
  re-clips. Markdown markers (`##`, `**`) are preserved, never stemmed.
- **Sidecar YAML uses js-yaml `CORE_SCHEMA`,** not the default — the default parses
  unquoted ISO timestamps into `Date` objects, which corrupts the record on re-serialize.
- When serializing the `anno` block, the fence length adapts to any backticks in the
  content (`max(3, longestRun+1)`); content is verbatim, never escaped.
- **Layout: quotes + comments first, `anno` blocks collected at the END of the file.**
  A unit on disk is `> quote ^anno-<id>` then its comment; the machine `anno` blocks all
  trail at the bottom and bind back by id (above). The parser's spine is the **quote**
  (a blockquote ending in `^anno-<id>`), not the fence — it indexes every `anno` block by
  id, then scans quotes and looks records up. A quote with no record is reported+skipped;
  a record with no quote is silently dropped (dead data). The serializer emits all `anno`
  blocks after the units.
- **Comments are closed by an invisible `[/]:#` terminator** (a link-reference definition
  that renders to nothing), and the `anno` block notes `comment: true` when prose follows
  (a *derived* hint — set on serialize, stripped on parse; the prose is the source of
  truth). The comment follows the **quote** directly (the `anno` block is no longer
  adjacent to mark its end — hence the terminator matters). A fenced code block or
  blockquote line is a safeguard boundary; comments support lists + inline but **not**
  blockquotes/code-blocks (a bare `---` rule *is* allowed). No `---` separator between units.
- **Parsing is fault-isolated on read, strict on write.** `parseSidecar(text, onIssue)`
  (read path, `store.load`) skips a malformed unit and reports a `ParseIssue` rather
  than throwing — one corrupt unit never blanks the whole file's rendering.
  `parseSidecar(text)` with no callback (write path, `writeSidecar`) stays strict and
  throws, so a read-modify-write refuses rather than silently clobbering an
  unparseable unit. Frontmatter/schema errors are always fatal (throw, both modes).

## Obsidian integration notes

- Reach the CM6 `EditorView` from a Markdown editor via the undocumented `editor.cm`
  (cast through `unknown`). Used by `repaint()` in `main.ts` and the flash in navigation.
- Highlights are pushed into each open editor for a file via a `StateEffect`
  (`setHighlights(view, specs)`); the ViewPlugin maps them through doc changes.
- Sidecar writes go through `vault.process` (atomic read-modify-write); a new sidecar
  is `vault.create`d with `annotation_schema`/`annotates`/`source_hash` frontmatter. With a
  custom `sidecarFolder`, the store `ensureParentFolder`s the (exact) folder before create.
- **`annotation_schema` is a number** (the schema gate; was the string `schema`), and
  **`annotates` is a wikilink** `[[path]]` (`.md` dropped), not a bare path — so Obsidian
  rewrites it when the source note is moved/renamed. Writers call `annotatesLink(sourcePath)`;
  readers (`store.annotatesOf`, `main.resolveSourcePath`) call `resolveAnnotates`, which
  resolves the link through `metadataCache.getFirstLinkpathDest` (so a link Obsidian rewrote
  to shortest form on a move still points home), falling back to `linkpath + .md`. The pure
  layer still treats `annotates` as an opaque string (back-compat accepts a bare path too).
- **Identity = `annotates`; sidecars are freely movable.** `store.sidecarsFor(source)`
  scans `vault.getMarkdownFiles()` and keeps every file whose `annotates` resolves to the
  source (`annotatesOf` short-circuits files with no `annotates`), plus the session-sticky
  bound file (to bridge the post-`create` metadataCache lag). So a sidecar can be moved or
  renamed anywhere and is still found. `load` parses+resolves each file independently
  (one bad file → skip+Notice, others still load), picks a **primary** (`pickPrimary`:
  bound → canonical-path → newest `mtime` → lexicographic) and merges (`mergeResolved`:
  union, primary wins any id/overlapping-range duplicate). New highlights and `mutateById`
  (color/comment/delete, routed by each `ResolvedAnnotation.sidecarPath`) target the file
  that actually holds the mark; new highlights go to the primary.
- **Flat-folder name collisions only happen on *create* (`sidecarFolder` set).** When a clip
  has **no** annotation file yet and the canonical *name* is taken by a different clip,
  `writeSidecar` calls the injected `onCollision` resolver (wired in `main.ts` to
  `SidecarCollisionModal`): **suffix** ("Keep separate" — claim the first free numbered slot
  `Note-1.annotations.md` via `firstFreePath`, recommended), **continue** ("Continue (use
  these annotations here)" — **override the link**: rewrite the existing file's
  `annotates`/`source_hash` to *this* clip, detaching the previous one, keep its annotations,
  append the new), or **cancel** (`createHighlight` returns `null`). "Continue" persists (it
  rewrites `annotates`), so it never re-prompts in a later session. Collisions only arise in
  folder mode; alongside, the canonical name embeds the full source path and is always unique.

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
    selecting over one, → the same swatches (current color marked) **plus a comment
    button and a delete button** → `onRecolor`/`onComment`/`onDelete`
    (`store.updateColor`/`updateComment`/`deleteAnnotation`). The comment button swaps the
    swatch row for an inline textarea right at the highlight (pre-filled; commits the
    *changed* text on blur / Escape / Cmd-Enter — no live per-keystroke write, so a store
    re-resolve never repaints the anchored highlight DOM out from under the editor mid-edit;
    a dismiss-by-`hide()` still flushes the pending commit). A
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
  - **Cards are ordered by document position**, not sidecar/file order (the sidecar binds
    records by id, which need not track the document). The aside's `render()` sorts each
    pass by the live anchored `range.from`; orphans (no range) sink to the end keeping
    relative order (`Array#sort` is stable). Display-only — `store.getResolved` and the
    renderers are untouched.
  - **Scroll sync** (`src/ui/scroll-sync.ts`, Design.md §7.3): one-way *document → panel* —
    scrolling the source brings the card for the topmost on-screen highlight into view
    (`scrollIntoView({block:'nearest'})`) and marks it `.mrg-current`. A DOM controller
    (capture-phase `scroll` to catch the non-bubbling inner scroller; reads `data-anno-id`
    off the painted `.mrg-highlight`s, so it works in **both** modes with no offset model),
    same rationale as the selection toolbar. rAF-coalesced; only reacts to the markdown
    view showing the panel's source; **skipped while the panel `isBusy()`**. The pure
    topmost-pick (`pickTopmostVisible`) is unit-tested. Depends on the document-order sort
    above. Scrolling the panel does nothing back (no feedback loop). **A card click must
    not move the panel:** the jump scrolls the document programmatically, which would
    re-trigger sync (and, since the jump *centers* the target, often onto a different,
    earlier highlight). `jumpToAnnotation` fires `onBeforeScroll` right before its
    `scrollIntoView`; the plugin wires that to `scrollSync.suppress()`, which ignores
    document scrolls for a short window (`JUMP_SUPPRESS_MS`) so the panel stays put while
    a genuine user scroll just after is still honored.
  - **A re-render must not destroy transient foreground UI** (Design.md §14.5). The
    panel rebuilds on `render()`, which tears down the open color popup / focused comment
    editor. `refresh()` and `setSourceFile` therefore skip re-rendering while `isBusy()`
    (`isEditing() || colorPopup != null`), and `setSourceFile` skips a *same-file* render
    entirely. Without this, the `active-leaf-change` that fires when you click from the
    editor into the panel (→ `syncActiveFile` → `setSourceFile`+`store.load`, both of which
    `render()`) closed the color popup the instant it opened. A real file switch still
    renders.

## Web Highlights import (`src/import/`, added 2026-06-20)

Imports highlights made with the **Web Highlights** browser extension (a JSON
export) as Marginalia sidecar annotations. Migrated from the standalone
"Highlight Exporter" plugin — **only the import** came over: there is no reading-note
generation and the clip is never modified (the sidecar replaces both). A *clip* is
any note whose frontmatter carries the page's source URL (`source`/`url`/…).

- **Pure core** (Obsidian-free, unit-tested):
  - `web-highlights.ts` — the export format: `parseExport`, `marksForUrl`/`urlsWithMarks`
    (URL match, hash/trailing-slash-insensitive), `urlFromMeta` (bare or `[t](url)`),
    `markColor` (the mark's hex, stored **literally** — Marginalia renders arbitrary
    `#hex`, so WH colors survive verbatim), `markComment`/`htmlToMarkdown` (the HTML
    note → Markdown; deliberately never emits blockquotes/code blocks a sidecar comment
    can't hold, §5.1).
  - `locate.ts` — `locateMark(source, text)`: the import's own locator. A mark's text is
    plain rendered text; the clip is reflowed/re-marked-up Markdown, so it matches on an
    **aggressive** projection (links→text, markers stripped, smart-punct folded to ASCII,
    lowercased, **all whitespace removed**) while keeping a 1:1 char→offset map back to the
    source, so a hit yields an exact `[from, to)`. This mirrors Highlight Exporter's
    normalization (verified: 17/17 on its real sample, vs 14/17 for the toolbar's
    conservative `@/text/locate#findSourceRange`, which stays unchanged for reading mode).
    Both are best-effort + first-occurrence; a miss is reported, never guessed (§4.6).
  - `plan.ts` — `planImport(sourceText, marks, existingRanges, opts)`: locate → de-overlap
    against existing annotations *and* intra-batch (upholding one-passage-one-highlight,
    which makes **re-runs idempotent**) → `{ planned, unmatched, skipped }`, sorted by
    source position.
- **Runtime**:
  - `store.createHighlights(file, items[])` — batches the whole import into **one** sidecar
    write + a single reload (vs N for `createHighlight`); shares the record-capture
    (`buildRecord`) with the single-create path; backstops the overlap guard.
  - `importer.ts` (`WebHighlightsImporter`) — finds the newest `.json` in
    `settings.webHighlightsFolder` (newest **by name** — exports are timestamped) and
    resolves each clip's URL from the metadata cache. **Preview-first**: it `planClip`s
    every candidate *without writing*, opens `preview-modal.ts` (`ImportPreviewModal`), and
    only **on confirm** calls `store.createHighlights` (no write-immediately command). The
    modal has two layouts: **single clip** = meta bar + the clip's frontmatter as a Properties
    table + one card per highlight (colored quote + rendered comment — flat, *no* heading
    outline, since the sidecar stores only quotes+comments) + a **"Not located"** section for
    marks that couldn't be re-anchored; **all clips** = stat cards (incl. *not-located*) +
    per-clip entry list (icon, title, count chips) that lists each clip's un-located quotes
    inline (clips with *only* misses are still shown). **Un-located marks are displayed but
    never written** — the warning flag sits *beside* the quote, not inside it, so it can't
    corrupt the shown text (Design.md §15.4). **Import is the focused default** via an `open()`
    override that focuses the button *after* `super.open()` — Obsidian's `Modal.open()`
    autofocuses the first focusable element (Cancel) *after* `onOpen()` returns, so focusing in
    `onOpen` is clobbered; do **not** add an Enter keybinding (Enter already confirms the
    focused button). Guarded by `test/playground/specs/import-focus.e2e.ts` (Design.md §15.4).
  - Settings: `webHighlightsFolder` + `clipsFolder`; commands **Import Web Highlights into
    current note** / **into all clips** (`main.ts`) — both open the preview.
- **Not automatically verified in-vault** (runtime layers aren't unit-tested here, per
  convention) — the matching/offset core is, against the real export sample.

## Settings & shared UI (ported from Highlight Exporter, 2026-06-20)

UI design pulled across from the standalone plugin, adapted to Marginalia's `mrg-`
vocabulary (all on Obsidian CSS variables, theme-aware). Reading-note-specific surfaces
(reading-note frontmatter, color-marks, output folder, note-render preview) were **not**
ported — they don't apply. What landed:

- **`src/ui/suggest.ts`** — `FolderSuggest` / `ColorSuggest` (Obsidian `AbstractInputSuggest`).
  Folder autocomplete now backs **all three** folder fields (`sidecarFolder`,
  `webHighlightsFolder`, `clipsFolder`); color autocomplete offers the built-in tokens.
- **Palette as a swatch table** (`settings-tab.ts#renderPalette`) — replaced the
  per-color `Setting` rows with a flex table: each row a drag handle + live swatch
  (`.mrg-color-swatch.is-empty` = hatched "unset/unrecognized", via `isUsableColor`) +
  token/`#hex` text input + delete, plus "Add". (Palette data model is unchanged — still
  `settings.palette: string[]`; the *order* is the toolbar/card-popup order.)
  - **Reorderable** via HTML5 drag-and-drop on the grip handle (`makeReorderable`); the drop
    moves the entry to land just before the drop row (the `from < to ? to-1 : to` adjustment
    keeps it consistent in both directions). Reordering rewrites `settings.palette`, so the
    toolbar/popup order updates on save.
  - **Autocomplete** offers the built-in tokens **plus the colors in the newest export**
    (`ColorSuggest` over `colorsInExport` → `importer.exportColors()` → `SettingsHost.exportColors()`),
    each with a swatch — so you build the palette from the colors you actually highlight with.
    Loaded async on `display()` into `exportColorOptions` (the suggester reads it lazily).
- **Annotation-file frontmatter** — `settings.sidecarFrontmatter: {key,value}[]`, edited via
  a Key/Value grid table (`renderFrontmatterSection`), written into **every new sidecar's**
  frontmatter by `store.newFrontmatter` (so both manual highlighting *and* import get them);
  reserved keys `annotation_schema`/`annotates`/`source_hash` can't be overridden.
- **Delete confirmation** — `settings.confirmDelete` (default **on**) gates *both* delete
  paths (aside trash, toolbar) through `src/ui/confirm.ts` (`confirm()` → `Promise<boolean>`,
  Esc/click-outside = no). Shared copy in `DELETE_PROMPT`; `confirmThenDelete` lives in both
  `aside-view.ts` and `main.ts`.
- **Import preview** — the rich two-layout modal (single: meta + Properties table + per-quote
  cards; all: stat cards + entry list) — see the import section above and Design.md §15.4.

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

**Cross-block painting — fixed (2026-06-20).** A quote spanning **block** boundaries
(separate paragraphs / list items, which render as separate section elements) now paints:
the post-processor runs per block, so for each element it projects only the *intersection*
of that element's source span (`sectionSpan`) with the highlight's resolved range and paints
that slice (`info.text.slice(from,to)` → `projectQuoteToText`). Each contributing block paints
its own portion → visually one highlight across blocks (separators like a bare `*` paragraph
project to empty and stay unpainted — acceptable). Single-block highlights are unchanged (the
slice is the whole quote). The `getSectionInfo`-null path still falls back to whole-quote
search. Offset-accurate reading-mode highlighting remains a **non-goal** (Design.md §7.2);
CM6 is the authoritative path. Covered by `reading.test.ts` ("spans two block elements").

### Sidecar comment format + parse coupling — RESOLVED (2026-06-20)
Reworked this session (see Design.md §5.1, §5.4, §10 #11, and the invariant bullets above).
Two distinct problems were conflated under "rendering breaks when the file structure
changes," and only the second was a real bug:
- **Comment delimiting was positional.** Now a comment is closed by an explicit, invisible
  `[/]:#` terminator (a link-reference definition that renders to nothing — chosen over
  `---`/HTML/`%%` for being small, plain-Markdown, and portable), the `anno` block notes
  `comment: true`, and a code-fence/blockquote line is a safeguard so a comment can't run
  away into the next unit. Comments support lists + inline but not blockquotes/code-blocks;
  a bare `---` is now ordinary content. The cosmetic `---` unit separator was dropped (a
  comment-less unit's forward scan would absorb it).
- **Parse was all-or-nothing and bound by raw adjacency.** Now `parseSidecar(text, onIssue?)`
  is fault-isolated on read / strict on write. One corrupt unit no longer blanks the file.
- **`anno` blocks decoupled from their quotes (later in the session).** Binding is now
  purely by id (`^anno-<id>` ↔ `id:`), the parser's spine is the **quote** (not the fence),
  and the serializer collects all `anno` blocks at the **end of the file** — quotes +
  comments read together, machine data trails. The `^anno-<id>` ref is now load-bearing.
  Ids shortened from ULID to short base36 (`store.freshId`); the `ulid` dep was removed.

**Open follow-up — strict-write refuses on a corrupt unit.** Because `writeSidecar` parses
strict, a single unparseable unit blocks *all* writes to that sidecar (refuse, never
clobber). Safer than the old behavior but a real UX wart. Option if it bites: have the
write path preserve unparseable units verbatim (round-trip their raw text) instead of
refusing.

### Self-healing references — DONE (Design.md §6.5, 2026-06-21)
The stored selector is now actively kept equal to the live source bytes instead of resting
in fuzzy/orphan. Built in 5 slices (all committed on this branch; 261 unit tests):
- **Status enum** `unique | exact | orphan` (`model/types.ts`); `sidecar/parse.ts` migrates
  legacy `anchored→exact`/`orphaned→orphan` on read and normalizes in place.
- **Resolver** (`resolver/resolve.ts`, rewritten): whole-document search; cheap path
  (globally-unique + prior `unique`); context tiers `{before, after, structural}` — exact
  full-window, all-three→≥2, **first-wins** on tie; fuzzy gated by the same signals →
  reports `confidence` + drives a repair. Pure, 35 tests.
- **Store load path** (`store.ts`): `resolveAll` folds confidence→status, fuzzy→repairs the
  quote, and refreshes context/heading on context/fuzzy anchors; `persistRepairs` writes the
  changed records once, **strict** (refuses on a malformed neighbor, never clobbers).
  Fresh highlights are born `unique` when their quote is sole.
- **In-session delete-by-word guard** (`editor/self-heal.ts`, pure + 15 tests): a CM6 view
  plugin classifies each transaction per highlight and runs a 15 s deletion-run state
  machine; while a run is active it `store.suppressRepair`s the id so the load path holds the
  **original** quote, releasing (settle/edit→commit survivor, collapse→orphan-with-original)
  on run end. Recapture + fully-contains are handled by the load path, not the editor.

Key behavior: in-session edits self-heal via autosave→reload→`resolveAll`; the editor guard
only exists to stop a *paused* delete-by-word from repairing to a fragment. Opening an
externally-edited note can rewrite its sidecar (accepted cost). The run's source file is
resolved from the **suppression map** (where the run started), *not* the active file — a
blur/timer settle can fire after the user switched notes. Open follow-ups: (1) the strict
write means a malformed unit blocks repair persistence for the whole sidecar (above); (2) an
**undo *after* the 15 s settle already committed the survivor** is *not* re-expanded — once
settled, the shrink is a finished edit, so undoing the text won't re-grow the stored quote
(would need tracking recently-committed runs past their settle; user did not request it).

### Frontmatter anchoring — RESOLVED (2026-06-22)
The "whole-document" search (above) literally meant the whole file, **including the YAML
frontmatter**. A web clip's `title`/`description` duplicate body text (the clip's H1 *is*
the page title), so a body highlight could anchor *into* the frontmatter — invisible in
Live Preview (the Properties widget has no text a CM6 decoration lands on) yet painted by
reading mode's best-effort painter on the body copy: the same highlight showing in reading
mode but not Live Preview. **Learning: "whole document" must mean the whole *body*** — a
content matcher must never treat frontmatter as annotatable text. Fixed by bounding every
matcher (resolver, creation birth-count, both locators) at `src/text/frontmatter.ts#bodyStart`
(pure), plus a §6.5 recovery branch that heals records the old count already mis-stamped
`exact` (sole body match whose quote also sits in the frontmatter → anchor + promote to
`unique`). The §6.5-A conservative orphan is preserved (gated on the frontmatter twin).
Verified by `src/text/frontmatter.test.ts`, 4 cases in `resolver/resolve.test.ts`, and the
`frontmatter-anchor.e2e.ts` e2e on real Obsidian (neutralize→fail→restore→pass).

## Status / next step

Core is done and tested. The runtime layers build and typecheck; the selection toolbar,
custom palette, custom save location, and aside card controls are in. Recent work, newest
first:

- **Frontmatter format change** (Design.md §5.2/§5.3): `schema: webclip-annotations/1` (string)
  → `annotation_schema: 1` (**number**), and `annotates` is now a **wikilink** `[[path]]`
  (`.md` dropped) so Obsidian keeps it pointing at the source across a move/rename. New pure
  helpers in `sidecar-path.ts` (`annotatesLink` / `annotatesLinkpath` / `resolveAnnotates`,
  unit-tested); runtime reads resolve via `metadataCache.getFirstLinkpathDest`. **Breaking on
  read** — the schema gate rejects old sidecars; existing files need `annotation_schema: <n>`
  (the one sample sidecar in this vault was migrated in place). js-yaml emits the link single-
  quoted (`'[[…]]'`), which Obsidian parses to a string and recognizes as a `frontmatterLinks`
  entry (verified in obsidian.asar — the link must be a quoted string, not bare `[[…]]`/a flow
  seq). **Verified in-vault** by `test/playground/specs/sidecar-format.e2e.ts` (real Obsidian
  1.12.7): highlighting a note writes `annotation_schema: 1` + `annotates: '[[Clips/…]]'`, and
  the written link resolves back to the source via `getFirstLinkpathDest` (teeth-checked —
  fails when `annotatesLink` is neutralized to a bare path).
- **Frontmatter excluded from anchoring** (Design.md §6.5). A web clip's YAML `title`
  duplicates its H1, so the whole-file search anchored that H1 highlight *into* the
  frontmatter — invisible in Live Preview (Properties widget), yet reading mode's painter
  found the body copy (the reported mode-split). New pure `src/text/frontmatter.ts#bodyStart`
  now bounds the resolver, the creation `unique`/`exact` birth count, and both locators
  (`text/locate`, `import/locate`). A resolver recovery branch heals records already
  mis-stamped `exact`: a sole body match whose quote also sits in the frontmatter anchors and
  promotes to `unique`. Tests: `src/text/frontmatter.test.ts` + 4 in `resolver/resolve.test.ts`
  (neutralize→fail→restore verified).
- **Import preview: show un-located marks + fix default focus** (Design.md §15.4). The preview
  now displays marks it couldn't re-anchor (a "Not located" section / per-clip inline list,
  flag beside the quote) instead of only counting them — shown, never written. And **Import is
  the focused default**: the focus must be set in an `open()` override *after* `super.open()`,
  because Obsidian's `Modal.open()` autofocuses the first focusable element (Cancel) *after*
  `onOpen()`. First e2e for a runtime layer here: `test/playground/specs/import-focus.e2e.ts`
  (passes with the fix, fails without — verified on real Obsidian 1.12.7).
- **Web Highlights import** (`src/import/`, see its section): export → sidecar annotations,
  preview-first, non-destructive, idempotent; matching/offset core verified 17/17 against the
  real sample (its in-vault runtime path is not auto-tested, per convention). Plus the
  settings/UI ported from the exporter (see "Settings & shared UI") — folder autocomplete,
  the palette swatch table (drag-reorder + export-color autocomplete), annotation-file
  frontmatter fields, and a confirm-before-delete toggle.
- **Annotation files identified by `annotates`; freely movable** (Design.md §4.1): a sidecar
  belongs to whatever clip its `annotates` link resolves to, *not* its name/location. `load`
  finds a clip's file(s) via `store.sidecarsFor` (scan by `annotates`), resolves each
  independently, picks a primary (`merge.ts#pickPrimary`) and renders the union with
  primary-wins overlap (`merge.ts#mergeResolved`). Multiple files for one clip are supported
  (copy/sync/split). New highlights + edits route by `ResolvedAnnotation.sidecarPath`. The
  collision modal now resolves a *filename* clash only; **Continue = override the link** (take
  over the file for this clip, detaching the previous — `writeSidecar` rewrites
  `annotates`/`source_hash`). Replaced `sidecarFileFor`/`probeSuffixed` with
  `sidecarsFor`/`firstFreePath`; `resolveSourcePath`/`maybeReload` (in `main.ts`) now map *any*
  `annotates`-bearing file home, not just `*.annotations.md`-named ones. Pure merge logic
  unit-tested (`merge.test.ts`); end-to-end in `test/playground/specs/movable-sidecar.e2e.ts`.
- **`sidecarFolder` = exact folder** (Design.md §4.1): a custom folder is the *exact*
  destination for a **newly created** sidecar (named by the source basename); a colliding
  source's first write prompts `src/ui/collision-modal.ts` (via `store.onCollision`) — Keep
  separate / Continue (override the link) / Cancel. **`writeSidecar` returns a boolean**
  (false = collision cancel); `createHighlight`/`createHighlights` honor it.
- Two cross-block reading-mode fixes: a quote spanning multiple block elements now **paints**
  in reading mode (per-block projection of the per-element slice, `reading.ts`, §7.2), and
  clicking its card **jumps** in reading mode (mode-aware `view.currentMode.applyScroll(line)`,
  `navigation.ts`, §8.1). These were render/jump-layer bugs; the resolver anchored them fine.
- Document-ordered aside cards + one-way scroll sync (`src/ui/scroll-sync.ts`, §7.3).
- Sidecar format rework (`[/]:#` terminator, fault-isolated parsing, end-of-file id-bound
  `anno` blocks, short base36 ids).

Open items: the strict-write tradeoff (above); the undo-after-settle edge (above); a
continue/share collision choice may re-prompt across sessions (not persisted); in-vault
verification of the import and the collision flow; the card-alignment stretch goal via
`coordsAtPos` (§7.3). **Merge:** this branch (`self-healing-refs`) and `frontmatter-wikilink-
annotates` both rewrite the sidecar format (`sidecar/parse.ts` + the YAML/frontmatter helpers
and the `status`/`schema` fields) — whichever lands second will need a manual conflict
resolution there; reconcile the status-enum migration with the `annotation_schema`/wikilink
`annotates` change rather than taking one side wholesale.
