# Marginalia

> PDF-style annotation for web clips and Markdown notes in [Obsidian](https://obsidian.md).

Highlight arbitrary sub-block spans of a note, attach Markdown comments, and review them in a side panel that lines up with the text. Annotations are stored **non-destructively** in a per-source **sidecar** file — plain, portable Markdown — and the link from an annotation back to its place in the source is **re-resolved by content on every use**, so it never goes stale across edits or re-clips.

See [`docs/Design.md`](docs/Design.md) for the full design rationale.

## Status

Early development. The pure core (data model, whitespace-normalized text matching, sidecar I/O, and the content-based re-anchoring resolver) lands first and is fully unit-tested; the Obsidian integration (rendering, aside panel, navigation) builds on top.

## Why

Obsidian's native cross-references are block-granular, inferred-not-stored, and resolve by opaque ID. Marginalia replaces ID-based targeting with **content-based targeting** (W3C Web Annotation–style text-quote selectors with context), which buys sub-block precision, portability, and honest orphan detection: if a passage can no longer be found, the annotation is marked `orphaned` and surfaced — never silently mis-pointed.

## The sidecar format

One sidecar per source note (e.g. `Clips/The Article.annotations.md`). Each annotation is three adjacent pieces:

1. a **blockquote** carrying the exact quote and a durable `^anno-<id>` ref (this *is* the primary match selector — same bytes the human reads);
2. an inert **` ```anno `** fenced code block holding the machine anchor record (YAML);
3. free-form **comment prose**.

The file is a faithful reading-note when rendered in any Markdown tool, and a complete anchor record when parsed by any script.

## Development

Stack: **pnpm + Vite + Vitest + TypeScript**.

```bash
pnpm install      # one-time (also builds esbuild's native binary)
pnpm test         # run the unit suite (Vitest)
pnpm test:watch   # watch mode
pnpm typecheck    # tsc --noEmit
pnpm build        # typecheck + emit main.js for Obsidian
pnpm dev          # vite build --watch
```

The build emits a single CommonJS `main.js` at the repo root (alongside `manifest.json` and `styles.css`), as Obsidian expects. `obsidian` and all `@codemirror/*` / `@lezer/*` packages are marked **external** — Obsidian provides them at runtime; bundling our own copies breaks the editor.

### Layout

```
src/
  model/      shared data types (the contract every layer builds on)
  text/       whitespace normalization + index map, hashing
  sidecar/    parse / serialize the sidecar .md format
  resolver/   content-based re-anchoring (the selector cascade)
  main.ts     plugin entry point
```

### Installing into a vault (for manual testing)

After `pnpm build`, copy `main.js`, `manifest.json`, and `styles.css` into
`<your-vault>/.obsidian/plugins/marginalia/`, then enable the plugin in
Obsidian's community-plugins settings. (A symlink from the plugin folder to this
repo makes `pnpm dev` live-reload friendly.)

## License

MIT
