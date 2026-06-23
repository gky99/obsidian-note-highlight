# Marginalia — Design Document

> **Working title.** "Marginalia" is a placeholder; rename freely.

| | |
|---|---|
| **Status** | Draft — design agreed, not yet implemented |
| **Schema version** | `annotation_schema: 1` |
| **Last updated** | 2026-06-22 |
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

**Identity is `annotates`, not the filename or folder.** A sidecar belongs to whatever clip its `annotates` frontmatter resolves to — full stop. The store *finds* a clip's annotation file(s) by **scanning for `annotates` that resolves to the source** (`sidecarsFor`), wherever they live and whatever they are named; the path convention below only decides where to *create* the first one. This is what makes annotation files **freely movable**: relocate or rename a sidecar and the next load still finds it (a path-based lookup would silently spawn a fresh file and orphan the moved one). `annotates` is stored as a **wikilink** (`[[path]]`, `.md` dropped), not a bare path. *Failure mode it avoids:* a stored path string silently breaks the moment the source note is moved/renamed, whereas Obsidian rewrites a wikilink to follow it (frontmatter wikilinks participate in Obsidian's link-update pass). The runtime resolves the link back to a concrete vault path via the metadata cache (`resolveAnnotates` → `getFirstLinkpathDest`), which also covers a link Obsidian rewrote to shortest form. **Gotcha:** the value must be a *quoted* YAML scalar (`annotates: '[[…]]'`) for Obsidian to treat it as a link — a bare `[[…]]` parses as a YAML flow sequence (an array) and is ignored; js-yaml quotes any `[`-leading string automatically, so emitting a plain JS string works.

- **Multiple files for one clip → render the union; the primary wins overlaps.** A clip can end up with several annotation files (a copy, a sync conflict, a deliberate split). The store loads them all, resolves each independently, and merges (`mergeResolved`): every non-overlapping mark shows, but where marks overlap — including a wholesale copy, which shares ids — **only the primary file's** version renders, upholding §4.4 "one passage, one highlight" *across* files. The **primary** (`pickPrimary`) is the session-sticky bound file → the file at the canonical location → newest `mtime` → lexicographic tiebreak; it also receives every new highlight.
- **The whole runtime routes per file, by `sidecarPath`.** Because a clip's marks can live in different files, every `ResolvedAnnotation` carries the `sidecarPath` it came from. Re-resolution (`resolveAll`) and the §6.5 self-heal repair-collection run **once per file**; edits (`mutateById` — recolor/comment/delete), the repair write-back (`persistRepairs`), and the deletion-survivor commit (`commitSurvivor`) all target *the file that actually holds that mark*, never a single "the sidecar". This is the seam where movable-by-`annotates` identity meets §6.5 self-healing: each file self-heals independently, then `mergeResolved` folds the results with the primary winning overlaps.

**Sidecar location & the `sidecarFolder` setting.** By default a sidecar is *created* alongside its source (`Clips/The Article.annotations.md`) — the canonical name embeds the full source path, so it is globally unique and never collides. An optional `sidecarFolder` instead creates sidecars **directly in that one exact folder**, named by the source's *basename* (`<folder>/The Article.annotations.md`); the source's directory is **not** mirrored beneath it. This matches how Obsidian's own attachment-folder setting behaves. (Lookup is by `annotates`, so a file created here can later be moved anywhere and still be found.)

- **Cost: basename collisions on *create*.** Two same-named notes in different folders (`A/Note.md`, `B/Note.md`) want the same canonical sidecar *name* when first annotated. This is purely a filename clash (identity is still `annotates`); we resolve it explicitly rather than silently mis-pointing (§4.6).
- **The collision modal resolves the name clash.** When a clip has **no** annotation file yet and the canonical name is already taken by a *different* clip, the user is prompted to: **keep separate** (a fresh numbered file `<folder>/Note-1.annotations.md` — the first free slot), **continue — override the link** (take over the existing file *for this clip*: its `annotates`/`source_hash` are repointed here, **detaching** the previous clip, and its current annotations are kept and re-resolved against this clip — they anchor if it is a copy, else orphan, and the user deletes any orphans), or **cancel**. The numbered slot is positional (first-free by existence probe), **not** stored or derived from the source. "Continue" now **persists** (it rewrites `annotates`), so unlike the old share behavior it never re-prompts in a later session.

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
annotation_schema: 1
annotates: "[[Clips/The Article]]"
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
| `annotation_schema` | Versioned format tag, a **number**; gate parsing/migrations on it. |
| `annotates` | **Wikilink** to the source note, e.g. `[[Clips/The Article]]` (the `.md` is dropped). Stored as a link rather than a bare path so Obsidian rewrites it when the source note is moved/renamed; the runtime resolves it back to a concrete vault path through the metadata cache (`resolveAnnotates`). |
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
| `status` | `unique` \| `exact` \| `orphan` — anchor confidence; load-bearing for the cheap re-anchor path (§6.5). Legacy `anchored`→`exact`, `orphaned`→`orphan` on read. | — |
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
  5. anno.status := "orphan"; surfaceForReview(); return NONE   # never guess (status enum is unique|exact|orphan, self-healing — §6.5)
```

Resolution runs on a **whitespace-normalized projection** of the source, with an index map back to true offsets (§4.8). The same function feeds both highlight rendering and navigation — there is exactly one resolver.

> **As implemented (§6.5):** the resolver searches the **whole** projection rather than narrowing to the pinned-block → heading → document scopes above. The pin/heading became a *confirmation signal* instead of a search-space restriction — simpler, and it matches heading-spanning quotes (§6.4) for free. The scope-narrowing in the pseudocode above is now an available *performance* optimization (search the pinned region first), not a correctness requirement.

### 6.3 Live re-resolution, not stored positions

Navigation and rendering both call `resolve()` against the *current* source bytes every time. Nothing trusts a saved coordinate. This is precisely why an edited or re-clipped source cannot send a jump to the wrong place — at worst it orphans.

### 6.4 Multi-block / heading-spanning references

A heading and the paragraph beneath it are **two separate blocks**, so a single `pin` block ID cannot cover a quote that includes a heading.

- The quote selector legitimately contains Markdown markers (`##`, `**`); match the **raw source form** and keep markers in the normalized projection — do not stem them away.
- For heading-inclusive references, pin to the heading and **widen the search window** to run from the pinned heading *through the following block(s)*, rather than assuming the whole quote lives in one block.
- Single-paragraph highlights remain clean single-block anchors. Branch on this in the resolver. **This is the one place the design quietly corrupts if implemented wrong — give it dedicated test cases.**

### 6.5 Self-healing references (added 2026-06-21)

The selector is not merely *re-resolved* every use (§6.3) — it is **actively kept equal to the live source bytes**. This sharpens §4.5: we still never store an offset, but we *do* rewrite the content selector (quote + context + pin/heading) whenever we can prove where the passage moved. So **fuzzy and orphan become transient, not resting, states**: a fuzzy hit is a *repair trigger* (re-capture the exact bytes so the next resolution is exact again), and an orphan is a *display-only* verdict surfaced in the aside that recovers on its own the moment the text reappears. The §4.6 guarantee is untouched — every rewrite is gated either by an **observed in-editor edit** or by **before/after/heading confirmation**; we never rewrite toward a guess.

**`status` carries the anchor confidence: `unique | exact | orphan`** (replacing the old `anchored | orphaned`). `unique` = exact match *and* the sole occurrence in the document; `exact` = anchored but among several / via context; `orphan` = not confidently located. The field does double duty — it is **read** to gate the cheap path (below) and **written** on every successful anchor, derived from the current candidate count. It is persisted (orphan included) because the cheap path needs the *historical* uniqueness, which a recompute-on-load cannot reconstruct. Legacy sidecars migrate on read: `anchored → exact`, `orphaned → orphan` (never `unique` without evidence); writes use the new enum.

**Re-anchor procedure** — load-time, and the in-session fallback (below). Runs on the normalized projection of the **whole body**, *not* block-by-block — searching the whole projection is what lets a heading-spanning quote match across a block boundary (§6.4), and it makes the structural pin/heading **one of three confirmation signals** — `{before, after, structural}` — rather than a search restriction. (A later optimization may probe the pinned scope first purely for speed; it would not change the signals below.) A signal counts **only on an exact, full-window agreement** (the boundary-adjacent context must reappear verbatim, normalized). Let `E` = exact matches of the stored quote in the **body**:

| case | action |
|---|---|
| `\|E\| == 1` **and** prior status `unique` | accept directly — no context check, no rewrite (quote is already exact). The one cheap path. |
| `\|E\| == 1`, prior **not** `unique`, **and the quote also occurs in the (excluded) frontmatter** | accept the sole body match and **promote to `unique`** — the frontmatter was the entire source of the historical ambiguity that stamped it `exact`, so the body match is now unambiguous; refresh the (stale, frontmatter-pointing) context. The frontmatter-recovery path. |
| `\|E\| ≥ 1` otherwise (several, *or* a single match whose prior status was **not** `unique` with no frontmatter twin) | score each hit over `{before, after, structural}` and take the highest, requiring **≥ 2** (all-three beats two); **first-wins** on a tie; if none clears two, **orphan**. Bytes are exact → refresh context/pin, no quote rewrite. |
| `\|E\| == 0` | fuzzy over the body; accept **only** when every *available* signal of `{before, after, structural}` agrees (when none are stored this is vacuous → the fuzzy threshold alone decides), else orphan. On accept, **repair**: rewrite the blockquote to the matched *source* bytes, refresh context, recompute `qhash` — so it resolves exact next time. A repair is never marked `unique`; the next load promotes it. |

After any successful exact anchor, set `status` to `unique`/`exact` by the current body-wide exact-candidate count, and persist. A stale `unique` is safe: it can only *demote* a match into the context check, never promote a wrong spot.

**Frontmatter is excluded from the search space.** A leading YAML frontmatter block is metadata, never annotatable body text — yet its `title`/`description` routinely *duplicate* body text (a web clip's H1 **is** the page title; the `description` repeats the lede). Counting it as part of the document let a body highlight anchor **into** the frontmatter, where Live Preview renders it as the Properties widget (no text a CM6 decoration can land on → it silently vanishes) while reading mode's best-effort painter found the body copy instead — a confusing mode-split where the same highlight shows in reading mode but not Live Preview. So every content matcher — the resolver, highlight **creation** (the `unique` vs `exact` birth count), the reading-mode locator, and the import locator — starts at the body offset (`src/text/frontmatter.ts#bodyStart`, pure). This also corrects the *birth* status: a quote the title duplicates is born `unique` (one body occurrence), so it takes the cheap path forever instead of being permanently dragged into the context check by a phantom frontmatter "duplicate". The recovery row above heals records already mis-stamped under the old whole-document count.

**In-session (as built).** Editing the source autosaves, which reloads the store and runs the procedure above — so most in-session edits self-heal through the **load path**: a benign in-quote edit or an *addition* fuzzy-repairs on the next autosave (the fuzzy end-refinement *extends* correctly to cover lengthened text), surrounding edits are tolerated, and a one-shot deletion / wholesale replace leaves no partial so it orphans carrying the original. The live CM6 decoration (`RangeSet.map`) keeps the highlight painted meanwhile.

The **deletion** path needs more than the load path, because fuzzy resolution *overshoots a shortened passage*: matching `the quick brown fox` against `the quick brown jumped…` scores a window ending in `…brown jum` (trailing substitutions) above the true survivor `…brown` (tail deletions), so a load-path repair would capture garbage or orphan. The fix: commit the deletion survivor from the editor's **exact** live range, never fuzzy.

**Consecutive-deletion run (delete-by-word).** A CM6 view plugin (`src/editor/self-heal.ts`) classifies each transaction's effect on every painted highlight and runs a per-highlight **deletion-run** state machine. While successive **contiguous deletions eat into one highlight**, it flags that id *suppressed* in the store: `resolveAll` leaves the record untouched (original held, nothing written) **and the store stops repainting it**, so its live CM decoration keeps the clean, exactly-mapped survivor range. The run is **per-highlight**; unrelated edits elsewhere never disturb it. On run end the plugin reads that live range and:

- **full collapse** (highlight gone from the decoration, or a fully-contains change) → orphan via the load path, carrying the **original** quote (so the aside shows what was actually highlighted);
- **a 15 s settle timer** — each deletion (re)starts it, a further deletion **resets** it; on elapse → **commit the survivor** from the editor's exact `[from, to)` (`store.commitSurvivor`: write the precise quote + context, then re-resolve — it now matches *exact*). The editor **losing focus** settles every active run at once (the user moved on);
- **an insertion / non-deletion edit into the highlight region** → ends the run **immediately** → commit the survivor likewise (a deliberate trim, e.g. dropping "fox", is a legitimate new highlight).

**Undo/redo during a run** is special-cased: a re-inserted edge does **not** re-grow an exclusive `Decoration.mark`, so after an undo the live decoration is stale (shrunk) even though the text is restored — committing from it would wrongly keep the highlight shrunk. So the plugin detects an `undo`/`redo` user-event, **abandons** the active runs (`tracker.cancelAll`, no commit), and re-anchors each by **content** against the live text (`store.recheckRun`): the held original quote re-matches a full undo *exactly* (no fuzzy), restoring the highlight; the durable persist follows on the next autosave reload.

Nothing is written during a run, so a crash mid-deletion leaves the original to be re-resolved on reload. The bug-prone parts — edit classification, the run/timer machine, and the live-range lookup — are pure and unit-tested (`src/editor/self-heal.test.ts`); only the view-plugin shell, `commitSurvivor`/`recheckRun`, and the suppression set are runtime.

**Context / heading refresh (as built).** When a highlight anchors via *context* or *fuzzy* — i.e. its disambiguating signals actually did work — `resolveAll` re-captures `before`/`after` from the resolved range and re-derives `pin`/`heading` from the metadata cache, persisting any change. This recovers a signal that has drifted from nearby edits *before* cumulative drift can starve an ambiguous highlight of evidence. A plain *unique* exact hit never consults these signals, so it is left untouched (no write churn); structural fields update only when re-derivable, never cleared on a transient cache miss; and a highlight in an active deletion run is held (above). A heading edit *inside* the quote (heading-spanning, §6.4) is content, handled by the fuzzy repair, not this path.

**In-session vs. out-of-session.** The edit log is the CM6 transaction's `ChangeSet` and exists **only while the file is open**; it supplies the precise, observed mapping that lets the in-session path skip context confirmation (except the fully-contains guard). Edits by another app / Sync / git / while closed produce no transaction and are caught on **first load** by the resolver, which *must* confirm via before/after/heading because nothing observed the move. Both paths converge on the same `status` verdict.

**Write discipline.** The in-memory record updates live; **disk writes are debounced** (no per-keystroke churn, and it sidesteps the strict-write refusal and read-modify-write races, §10 #11). Load-time repairs batch into a single write **per annotation file** (§4.1) and only when bytes actually changed — note this means *opening* an externally-edited note can rewrite its sidecar, the accepted cost of self-healing.

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
- **Cross-block highlights paint per block.** The post-processor runs once per rendered block, so for each element it projects only the *intersection* of that element's source span (`getSectionInfo` → `sectionSpan`) with the highlight's resolved range and searches the element for that slice — each contributing block paints its own portion, so a quote spanning paragraphs/list items renders as one highlight across them. (Earlier this was a documented limitation: searching each element for the *whole* quote never matched a multi-block quote.) Still best-effort and offset-*in*accurate by design — CM6 is the authoritative path.
- **Foreign DOM overlays are skipped when matching.** The painter locates a quote by searching the *concatenation* of an element's text nodes (so a quote can straddle inline markup). Another plugin that injects text into the reading-mode DOM can therefore poison that match — concretely, *Immersive Translate* appends translated text as `<font class="immersive-translate-target-wrapper">…</font>` (and `immersive-translate-target-*` variants) after each original chunk, and with its `selectors: [".markdown-reading-view *"]` config a translation lands *between* the text nodes a quote spans, breaking contiguity so the highlight silently vanishes (inline-spanning quotes are the common casualty). The matcher's tree-walker skips text inside any element whose class begins `immersive-translate-target` — exactly as it already skips already-painted `.mrg-highlight` — so it only ever matches the note's *own* rendered content. Original text nodes never carry that class (the plugin wraps them in a bare `<font>`), so nothing else changes. This is **not** the resolver's before/after context check: that runs on source bytes and a reading-mode DOM overlay can't touch it; the bug was purely in the DOM painter.
- **Creating a highlight from a reading-mode selection must project the source the same way.** Reading mode hands us only the rendered selection text (markers gone, `[Obsidian](url)` already collapsed to `Obsidian`), so `@/text/locate#findSourceRange` re-locates it by projecting the *source* to that same plain text (`projectSourceWithMap`, keeping a per-char offset map home) and searching for the projected selection. Those two projections must stay in lock-step: `projectSourceWithMap(input).text` is required to equal `projectQuoteToText(input)`. They drifted — the source projection stripped `*_\`` and whitespace but *not* links/images/wikilinks — so a selection spanning a link projected to `"…Obsidian."` while the source projection still held `"…[Obsidian](url)."`, the search missed, and creation failed with "could not locate that selection in the note source" (Live Preview was unaffected — it uses exact CM6 offsets, no locator). Fixed by having `projectSourceWithMap` apply the identical link/image/wikilink reductions, with a `locate.test.ts` invariant case (link/image/wikilink samples) guarding the equality so it can't silently drift again.

### 7.3 The "aside" panel

- A custom `ItemView` registered via `registerView`, placed in the right sidebar; tracks the active file via `workspace.on('file-open')`.
- Renders one card per annotation: quote, editable comment, color, jump button.
- **Card content & compactness.** The **quote** is Markdown-rendered (bold/italic/code/links show styled). It is rendered with an *empty* sourcePath on purpose: `MarkdownRenderer.render` runs the full markdown post-processor pipeline — including this plugin's own reading-mode highlighter — and the quote text *is* an annotation, so a real sourcePath would make the painter re-wrap it in its highlight color right here in the card (the color already reads from the card's left border + swatch, so that would be redundant noise). Quote links render styled but are inert (`pointer-events: none`) so clicking anywhere on the quote still jumps. The **comment** area is omitted entirely when there's no note (no perpetual "add a comment" placeholder), so an un-annotated card is just quote + controls; a footer comment button opens the inline editor to add one, and clicking an existing rendered comment still opens it for editing (that click must stop propagation, or `beginEdit` emptying the slot detaches the click target and the card's "is this inside the comment?" test misses, firing the source-jump instead). The editor auto-grows to fit its content rather than a fixed height. The footer groups controls as `[color · comment] │ [copy · open · delete]` with the status mark alone on the right.
- **Per-card sidecar buttons.** Besides jumping to the *source* (clicking the card), each card's footer carries two actions that target the annotation's record in its **sidecar**, by the quote's `^anno-<id>` block ref: **copy reference** copies a wikilink `[[sidecar#^anno-<id>]]` to the clipboard (pasteable anywhere as a link straight to that annotation), and **open in annotations file** opens the sidecar at that block (focusing an existing tab if open, else a new one). Because they bind by the block ref that lives *in the file* — via `ResolvedAnnotation.sidecarPath`, not a re-resolved source range — they work even when the annotation is **orphaned** in the source. The link strings come from pure builders (`obsidian/anno-link.ts`, unit-tested) fed `metadataCache.fileToLinktext` (shortest form, so the link survives a sidecar rename); the open uses `workspace.openLinkText`, which scrolls to the block natively (no plugin-owned navigation needed, unlike the source jump in §8.1 whose target Obsidian can't interpret).
- **Cards are ordered by document position**, not sidecar-file order (the sidecar collects records by id, which need not track the document). The aside sorts each render by the live anchored `range.from`; orphans (no range) sink to the end, keeping their relative file order (`Array#sort` is stable). Display-only — `store.getResolved` and the renderers are untouched.
- **Scroll sync (`src/ui/scroll-sync.ts`):** one-way *document → panel*. A capture-phase `scroll` listener (so it catches the inner `.cm-scroller` / reading-preview scroller, which don't bubble) finds the painted `.mrg-highlight` nearest the top of the document viewport and brings its card into view (`scrollIntoView({block:'nearest'})`), marking it `.mrg-current`. Geometry is read from live client rects of the painted highlights — which carry `data-anno-id` in **both** modes — so no offset model or mode-specific scroller lookup is needed (the same reason the selection toolbar is a DOM controller, §7.1). rAF-coalesced; skipped while the panel is busy (comment edit / color popup) so the cards aren't yanked out from under an edit. The pure topmost-pick is unit-tested (`pickTopmostVisible`). Scrolling the panel does nothing back (no feedback loop). Depends on document-order cards (above), or the panel would jump around. A **card click** suppresses sync for a short window (`jumpToAnnotation`'s `onBeforeScroll` → `ScrollSync.suppress()`): the jump scrolls the document — and *centers* the target, so the topmost visible highlight is often an earlier one — so without suppression the panel would chase its own jump onto the wrong card.
- **Marginalia alignment (stretch):** the above syncs *scroll position*; true side-by-side alignment would use `EditorView.coordsAtPos(pos)` to read each highlight's screen Y and absolutely-position cards to line up with their highlights. Recompute on scroll + `ViewUpdate`; compute only for viewport-near annotations and debounce. No existing plugin does this well — it's the differentiator, and the fiddliest part (card collision/stacking, overlapping highlights).

---

## 8. Navigation

The jump is **plugin-owned**, because the target is a content selector Obsidian cannot interpret. It is a two-stage move: **find** (re-resolve, §6.3) then **go**.

### 8.1 Forward — annotation card → source

```
jumpTo(anno):
  range := resolve(anno, read(sourceFile))     # live; never a stored offset
  if !range: flagOrphan(anno); return          # refuse to guess (§4.6)
  open sourceFile
  if mode == preview:                          # reading mode (§8.1 note)
    currentMode.applyScroll(lineAt(range.from))
  else:                                         # source / Live Preview
    setSelection(range); scrollIntoView(range, center)
    dispatch transient flash decoration
```

**Reading mode needs its own scroll.** In preview mode the CM editor is hidden, so `editor.scrollIntoView`/`setSelection` move an off-screen editor and the preview never budges — the jump silently does nothing. So `jumpToAnnotation` branches on `view.getMode()`: in preview it scrolls the active sub-view with `view.currentMode.applyScroll(line)` (line derived from the resolved offset; `applyScroll` is in line units, shared by both sub-views). The reading-mode highlight is painted by the post-processor, so there is no CM flash to dispatch. Edit/Live-Preview keeps the select-and-`scrollIntoView` path. (This is independent of orphaning — an anchored cross-block highlight resolves fine; the bug was purely the editor-only scroll.)

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

**Control styling.** Two shapes carry two meanings: a **round swatch** picks a color, a **square button** performs an action (comment, delete; and on the aside card, copy-reference / open-in-file). The action buttons wear Obsidian's own `.clickable-icon` — flat and transparent at rest so the glyph blends into the bar, with the standard hover surface only on hover. Hand-rolling the button defeats this: a bare `<button>` carries a default surface/shadow that reads as a control "floating" above the bar, and `.clickable-icon` is precisely what suppresses that across themes. The toolbar is a centered flex row (`align-items: center`) so the 18px swatches sit level with the slightly taller buttons, with a single hairline (`.mrg-toolbar-sep`) dividing the swatch group from the actions rather than a per-button border that doubles up. Toolbar buttons are kept tighter (20px) than the aside card's (24px) so the floating bar stays compact. Delete keeps its meaning in a red **icon** (not a red wash on hover) so it's identifiable at rest. These are the kind of choices easy to regress — the failure modes (a floating button, off-center swatches, a too-tall bar) were all observed and fixed.

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

### 14.6 Document-ordered cards + scroll sync (added 2026-06-20)

Two related changes this session made the aside track the *document*, not the sidecar file.

**Cards are ordered by document position.** The sidecar binds records by id and collects
the `anno` blocks at the end of the file (§5.1), so on-disk order need not follow the
prose. The aside's `render()` now sorts each pass by the live anchored `range.from`;
orphans (no range) sink to the end, keeping their relative file order (`Array#sort` is
stable, so the one-highlight-per-passage rule means anchored ties don't arise). This is
**display-only** — `store.getResolved` and every renderer keep file order, since the
editor/resolver don't care about it and the sidecar is the durable record.

**Scroll sync — one-way document → panel.** As the reader scrolls the source, the card for
the highlight nearest the top of the viewport is brought into view (`scrollIntoView({block:
'nearest'})`) and tinted `.mrg-current`. `src/ui/scroll-sync.ts` is a **DOM-level
controller** (`ScrollSync`), the same architectural choice as the selection toolbar (§14.1)
and for the same reason: reading mode has no CodeMirror, so one surface must serve both
modes. It listens for `scroll` in the **capture phase** (scroll doesn't bubble, but capture
still reaches the inner `.cm-scroller` / reading-preview scroller) and reads highlight
geometry straight from the painted `.mrg-highlight` elements — which carry `data-anno-id` in
*both* modes — so no offset model or mode-specific scroller lookup is needed. The work is
rAF-coalesced, scoped to the markdown view showing the panel's source, and **skipped while
the panel `isBusy()`** (§14.5). The pure topmost-pick (`pickTopmostVisible`) is unit-tested.
The sort above is a prerequisite: in file order the panel would jump around as you scroll.

**Lesson learned — a programmatic scroll is indistinguishable from a user scroll, so
suppress around your own.** Clicking a card jumps the document (`jumpToAnnotation` →
`editor.scrollIntoView`); that scroll re-fired the sync listener and the panel chased its
own jump. Worse, the jump *centers* the target, so the topmost *visible* highlight afterward
is often an **earlier** one — the panel could scroll to a different card than the one
clicked. `scroll` events fire (and are `isTrusted`) for programmatic scrolls just as for
user ones, so the controller cannot tell them apart from the event alone. Fix:
`jumpToAnnotation` fires an `onBeforeScroll` callback right before its `scrollIntoView`, and
the plugin wires it to `ScrollSync.suppress()`, which ignores scrolls for a short window
(`JUMP_SUPPRESS_MS = 400`). The window only needs to outlast that one non-animated scroll,
so a genuine user scroll just after is still honored. **General principle:** when a
component both *reacts to* and *causes* the same event, it must mark its own actions (a
suppression window, a re-entrancy flag, or an explicit "this one is mine" signal) — the
event stream alone won't distinguish them.

### 14.7 Cross-block reading-mode highlights — paint *and* jump (lesson learned)

**Symptoms reported:** highlights spanning a block boundary (e.g. a quote running across a
paragraph break, or across the `*` / `Human Movement.` / `*` blocks of a web clip) didn't
paint in reading mode, and clicking their aside card didn't navigate to them.

**First lesson — diagnose against real data before theorizing.** The two symptoms *looked*
like one root cause: if the highlight were orphaned, it would neither paint (orphans are
skipped) nor jump (`jumpToAnnotation` refuses on orphaned). Tempting, tidy, and wrong.
Resolving the actual sidecar against the actual source proved **every annotation anchors via
exact match** — the resolver was never the problem. The bugs were two independent defects in
the *render* and *navigation* layers. The five-minute scratch resolve (`parseSidecar` →
`buildStructure({}, len)` → `resolve`, logging status per id) was worth more than any amount
of reasoning about what *might* be orphaning.

**Bug 1 — a per-element post-processor must slice per element.** `registerMarkdownPostProcessor`
fires once per rendered **block**, and the painter searched each block for the *whole*
projected quote. A multi-block quote appears in *no single block*, so it never matched. Fix:
for each element, intersect its source span (`getSectionInfo` → `sectionSpan`) with the
highlight's resolved range and project/paint only that slice (`info.text.slice(from,to)`).
Each block paints its own portion → one highlight across blocks. Single-block highlights are
unchanged (the slice is the whole quote). **General principle:** when a processor only ever
sees a fragment of the whole, give it the matching fragment of the *target*, not the target
entire.

**Bug 2 — a hidden editor cannot scroll.** In reading mode the CM editor is off-screen, so
`editor.scrollIntoView`/`setSelection` move an invisible view and the preview never budges —
the jump silently no-ops. Fix: branch on `view.getMode()` and, in preview, scroll the active
sub-view with `view.currentMode.applyScroll(line)` (the line-unit scroll both sub-views
share, derived from the resolved offset). **General principle:** an API that targets "the
editor" is mode-blind; reading mode is a *separate* surface and needs its own scroll/feedback
path (the same reason the selection toolbar and scroll-sync are DOM controllers, §14.1).

Both are unit-covered (`reading.test.ts` "spans two block elements"; the resolve invariant by
the existing pipeline tests). Offset-accurate reading-mode highlighting remains a non-goal
(§7.2) — these fixes keep reading mode a faithful *best-effort* mirror of the CM6 path.

## 15. Web Highlights import + settings surfaces (added 2026-06-20)

Marginalia absorbed the *import* half of a standalone "Highlight Exporter" plugin: it reads a
**Web Highlights** browser-extension JSON export and re-creates those highlights as sidecar
annotations on the matching clip (a note whose frontmatter carries the page's source URL).
Deliberately scoped — only the import crossed over (`src/import/`).

### 15.1 The sidecar replaces both the reading note and the in-clip mark

The source plugin produced two outputs: a generated *reading note* and `==marks==` written
back into the clip. Marginalia keeps neither. A highlight's durable home is its sidecar
(§4.1), which already carries quote + comment + color — so it *is* the reading note, and the
clip stays byte-for-byte untouched (the non-destructive premise, §4.1). An import therefore
never edits source files, and re-running one never accumulates a second copy.

### 15.2 Import has its own locator — more aggressive than the reading-mode one (lesson learned)

A mark stores the *rendered* text the browser showed; the clip is reflowed, re-wrapped, and
re-marked-up Markdown. Matching mark→source is the same *shape* as the reading-mode toolbar's
"selected text → source range" problem (`@/text/locate#findSourceRange`), and the first
instinct was to reuse it. **It under-matched: 14/17 on a real export vs the source plugin's
17/17.** The reading-mode locator is deliberately conservative (collapses whitespace only,
case- and punctuation-sensitive) *because it mirrors exactly what the reading painter shows*.
Import has no such constraint — it only needs to *find the passage* — so it gets its own
locator (`src/import/locate.ts#locateMark`): links reduced to their text, emphasis/structure
markers stripped, smart punctuation folded to ASCII, lowercased, **all** whitespace removed.
The three misses were exactly those gaps — a stray space a clipper inserted around a mangled
`*italic*`, a curly apostrophe, a word turned into a `[link](url)`. Crucially the projection
keeps a per-character map back to true source offsets, so an aggressive *match* still yields an
*exact* `[from,to)` the store can highlight and the resolver re-anchor. **General principle:**
two callers that look like they share a text-matching need can have different tolerances; a
locator's strictness should follow its *consumer's* needs (what it must render) not a shared
helper's convenience. The reading-mode locator stayed untouched.

Both locators are best-effort and first-occurrence; an unlocatable mark is reported as "not
located", never guessed (§4.6).

### 15.3 Idempotency is the one-passage-one-highlight rule, reused

The plan de-overlaps located marks against the source's existing anchored ranges *and* against
each other (`src/import/plan.ts`) — the §14.2 stacking rule applied in bulk. A free
consequence: re-importing the same export finds each mark's range now overlapping the highlight
it created last time, so it's skipped. The import is **idempotent with no "already imported"
bookkeeping** — overlap *is* the dedupe key.

### 15.4 One batched sidecar write, preview-first

`store.createHighlights` appends a whole plan in one read-modify-write + a single reload (vs
`createHighlight`'s per-highlight write), sharing the quote/context/pin/heading capture
(`buildRecord`) so an imported annotation is indistinguishable from a hand-made one. The flow
is **preview-first**: a command computes the plan *without writing*, opens a preview, and
writes only on confirm (`Import N highlights`, the focused default — Enter confirms; there is
no write-immediately command). The preview (`preview-modal.ts`) has two layouts:

- **single clip** — a meta bar (target sidecar + counts), the clip's frontmatter as a
  read-only Properties table, then **one card per highlight: the colored quote and its rendered
  comment**, followed by a **"Not located" section** listing any marks whose text couldn't be
  re-anchored (muted, dashed, flagged with a warning icon *beside* — never inside — the quote).
  Deliberately *not* a note outline — the source plugin previewed a reconstructed reading note
  (headings + body), but a Marginalia sidecar stores only quotes + comments, so the preview
  mirrors exactly that (the §15.1 "the sidecar *is* the note" rule, applied to the preview surface).
- **all clips** — a dry-run report: stat cards (highlights / notes / **not-located** /
  nothing-new) and a per-clip entry list (file icon, title, count chips). A clip with *only*
  un-located marks is still listed (warning icon), and each entry expands to show its missing
  quotes inline.

**Lesson — the preview is a faithful mock of the result, so it must mirror the *output model*,
not the source tool's.** Porting the exporter's note-render preview verbatim would have shown
a heading skeleton Marginalia never produces; the preview's job is to answer "what will exist
after I confirm?", which here is a flat set of highlighted quotes + comments.

**Show what *won't* be imported, too.** A locate→write pipeline that silently drops misses
reads as "imported everything." The preview surfaces the un-located marks — especially in the
all-clips run, where a miss would otherwise vanish among many files — so the best-effort
locate (§15.2, §4.6) stays honest. They are shown, never written. The warning flag sits beside
the quote (its own element), not prepended into it, so it can't disturb the text it annotates.

**Lesson — to make Import the default focus, override `open()`; don't focus in `onOpen()`.**
Obsidian's `Modal.open()` autofocuses the *first focusable element* in the modal — here the
Cancel button, which is added to the `Setting` before Import — via an internal `tg(modalEl)`
call that runs *after* `onOpen()` returns. So any `buttonEl.focus()` set during `onOpen` is
clobbered one statement later, leaving Cancel focused (Enter cancels). The fix focuses Import
in an `open()` override, *after* `super.open()`: `Modal.open()` is fully synchronous (it does
not await `onOpen`, and the autofocus is its last focus-related call), so when `super.open()`
returns the autofocus has already run and our focus wins — deterministically, with **no timer,
no `Enter` keybinding, and no DOM/`tabindex` reordering** (each of those either races the
lifecycle or fights it). Verified both ways by `test/playground/specs/import-focus.e2e.ts`
against real Obsidian 1.12.7 — it passes with the override and fails (Cancel focused) without it.

### 15.5 Settings & shared UI, ported to Marginalia's vocabulary — but only what applies

The exporter's settings UX came across as `mrg-*` classes on Obsidian theme variables, minus
the reading-note machinery (frontmatter-for-a-note tables, color-mark rules, note-render
preview) which has no analogue here. What landed:

- **Folder autocomplete** (`AbstractInputSuggest<TFolder>`) on every folder field — including
  the pre-existing `sidecarFolder`, the same hand-typed-path hazard.
- **Palette as a swatch table** (§12): each row a token/`#hex` input with a live swatch
  (hatched = unset/unrecognized), **drag-reorderable** so the table order *is* the
  toolbar/popup order, autocompleting the built-in tokens *plus the colors found in the newest
  export* — so you build the palette from the colors you actually highlight with. The palette
  data model is unchanged (colors are literal, §5.4); only its *order* now carries meaning.
- **Annotation-file frontmatter** — configurable key/value pairs written into *every new
  sidecar's* frontmatter as it is created (manual highlight or import); `annotation_schema` /
  `annotates` / `source_hash` are reserved (§5.3).
- **Confirm-before-delete** — a default-on, opt-out gate on both delete paths (aside card +
  toolbar) via a generic confirm modal. The import preview defaults to its *confirm* button;
  the delete dialog deliberately does **not** (Enter must not destroy a highlight + comment).

Import only adds a new *producer* of annotations; it introduces no new rendering path, and
offset-accurate reading-mode rendering stays a non-goal (§7.2).

