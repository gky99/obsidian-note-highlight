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
- `src/obsidian/` — `metadata.ts` (metadataCache → resolver `SourceStructure`) and `sidecar-path.ts` (folder-aware: optional `sidecarFolder` stores sidecars **directly** in that exact folder, named by the source's basename — the source's directory is *not* mirrored beneath it; the name-based inverse is therefore lossy for the folder case, so `resolveSourcePath` prefers the sidecar's `annotates` frontmatter). These use **`import type` only** from `obsidian`, so they stay testable.

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
  is `vault.create`d with `schema`/`annotates`/`source_hash` frontmatter. With a custom
  `sidecarFolder`, the store `ensureParentFolder`s the (exact) folder before create.
- **Flat-folder name collisions (`sidecarFolder` set).** Two same-named notes in
  different folders map to the same canonical sidecar name. The store's lookup
  (`sidecarFileFor`) is ownership-aware: own canonical (`annotates` matches) → own
  *numbered* sidecar (`Note-1.annotations.md`, found by `probeSuffixed` — probe
  slots `-1, -2, …`, match `annotates`, stop at the first gap; safe because emptied
  sidecars are never auto-deleted, so a cluster has no gaps) → shared canonical
  fallback. On a colliding source's **first** write, `writeSidecar` calls the
  injected `onCollision` resolver (wired in `main.ts` to `SidecarCollisionModal`):
  **suffix** ("Keep separate" — claim the first free numbered slot, recommended),
  **continue** ("Continue (share file)" — share the existing sidecar; both notes
  read it best-effort, the off-note's may orphan), or **cancel** (`createHighlight`
  returns `null`). The numbered slot is positional (first-free), *not* derived from
  the source — re-location is always by probing `annotates`, never a stored number.
  A session-sticky `resolvedSidecar` map binds the chosen path so repeat writes skip
  the prompt and bridge the post-`create` metadataCache lag; it is *not* set from a
  shared-fallback read, so a first write still prompts (a shared note may re-prompt
  after a reload — acceptable; a "Keep separate" note is found by probe and never
  re-prompts). Collisions only arise in folder mode; alongside, the canonical name
  embeds the full source path and is always unique.

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
    outline, since the sidecar stores only quotes+comments); **all clips** = stat cards +
    per-clip entry list (icon, title, count chips). Confirm is the focused default.
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
  reserved keys `schema`/`annotates`/`source_hash` can't be overridden.
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

## Status / next step

Core is done and tested. The runtime layers build and typecheck; the selection toolbar,
custom palette, custom save location, and aside card controls are in. Recent work, newest
first:

- **Web Highlights import** (`src/import/`, see its section): export → sidecar annotations,
  preview-first, non-destructive, idempotent; matching/offset core verified 17/17 against the
  real sample (its in-vault runtime path is not auto-tested, per convention). Plus the
  settings/UI ported from the exporter (see "Settings & shared UI") — folder autocomplete,
  the palette swatch table (drag-reorder + export-color autocomplete), annotation-file
  frontmatter fields, and a confirm-before-delete toggle.
- **`sidecarFolder` = exact folder + collision handling** (Design.md §4.1): a custom folder is
  now the *exact* destination (sidecars sit directly in it, named by the source basename), so
  the store's lookup is ownership-aware (own canonical / own numbered `Note-1` via
  `probeSuffixed` / shared fallback) and a colliding source's first write prompts
  `src/ui/collision-modal.ts` (via `store.onCollision`) — Keep separate / Continue (share) /
  Cancel. `resolveSourcePath` prefers the sidecar's `annotates` over the now-lossy name-based
  inverse; a session-sticky `resolvedSidecar` binding skips re-prompts. **`writeSidecar` now
  returns a boolean** (false = collision cancel); `createHighlight`/`createHighlights` honor it.
- Two cross-block reading-mode fixes: a quote spanning multiple block elements now **paints**
  in reading mode (per-block projection of the per-element slice, `reading.ts`, §7.2), and
  clicking its card **jumps** in reading mode (mode-aware `view.currentMode.applyScroll(line)`,
  `navigation.ts`, §8.1). These were render/jump-layer bugs; the resolver anchored them fine.
- Document-ordered aside cards + one-way scroll sync (`src/ui/scroll-sync.ts`, §7.3).
- Sidecar format rework (`[/]:#` terminator, fault-isolated parsing, end-of-file id-bound
  `anno` blocks, short base36 ids).

Open items: the strict-write tradeoff (above); a continue/share collision choice may re-prompt
across sessions (not persisted); in-vault verification of the import and the collision flow;
the card-alignment stretch goal via `coordsAtPos` (§7.3).
