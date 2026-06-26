# Structure-Preserving Sidecar Writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline). Steps use checkbox (`- [ ]`) syntax. This is one cohesive pure-core module — keep it in one context, not fanned out.

**Goal:** Stop rewriting the whole annotation sidecar on every edit. Preserve all existing structure (custom headings, prose, between-unit notes, bottom summaries, interleaved `anno`-block grouping, custom frontmatter) by patching the original text in place instead of regenerating it from the parsed model.

**Architecture:** Replace the lossy `parseSidecar → mutate → serializeSidecar` round-trip (used by every in-place write) with a new pure `patchSidecar(originalText, mutate)`. It parses the original *with layout* (per-id line spans for each unit and each `anno` block, plus insertion points), deep-clones the model, runs the same `mutate` callback, diffs by id, and splices only the changed/new/removed regions into the original lines. Fresh-file creation keeps `serializeSidecar` (nothing to preserve). No store call sites change — only the serialize step inside `rmw`/`mutateById`.

**Tech Stack:** TypeScript, pure core (Obsidian-free), vitest. wdio + wdio-obsidian-service for the live-vault e2e.

## Global Constraints

- Pure-core modules **never import `obsidian` values** — `import type` only (CLAUDE.md). `patch.ts`, layout code, and their tests must stay Obsidian-free.
- `pnpm typecheck` is the correctness gate for runtime-bound code; `pnpm test` (vitest) for pure core. Both must stay green.
- Write path stays **strict**: a malformed unit must make the write **refuse** (throw), never clobber. `patchSidecar` parses strict (no `onIssue`), matching today's `rmw`.
- Anno-block ids are stored **bare** (`id: RTW6A2`); the quote ref is `^anno-RTW6A2`. Bind by bare id.
- **Insertion rules (from the user):** a new **unit** is inserted immediately **before the first fence of the last contiguous `anno`-block group**; a new **anno block** is appended **after the last existing `anno` block** (= end of file in the normal case). Never reorder existing `anno` blocks.
- Commit after each task. Branch: `worktree-structure-preserving-sidecar-writes` (already in the worktree).

---

### Task 1: Layout-aware parse (`parseLayout`) in `src/sidecar/parse.ts`

Add a strict parse variant that returns, alongside the `Sidecar`, the line spans needed to patch in place. Reuse the existing private helpers (`splitFrontmatter`, `findAnnoFences`, `refIdOfLine`, `parseBlockquote`) so scanning logic isn't duplicated.

**Files:**
- Modify: `src/sidecar/parse.ts` (add `commentRegionEnd`, refactor `extractComment` to use it, add `parseLayout`, export new types)
- Test: `src/sidecar/parse.test.ts` or new `src/sidecar/layout.test.ts`

**Interfaces produced:**
```ts
export interface UnitLayout {
  id: string;
  /** body-line span of the unit: blockquote + comment + `[/]:#` terminator (half-open). */
  unitStart: number; unitEnd: number;
  /** body-line span of this id's `anno` fence block (half-open: open..close+1). */
  annoStart: number; annoEnd: number;
}
export interface SidecarLayout {
  sidecar: Sidecar;
  /** raw frontmatter block text incl. both `---` delimiters, no trailing newline. */
  frontmatterRaw: string;
  bodyLines: string[];
  /** in document order of the unit's blockquote position. */
  units: UnitLayout[];
  /** body-line index to insert a NEW unit (start of last anno-block group; = bodyLines.length if no anno blocks). */
  newUnitAt: number;
  /** body-line index to append a NEW anno block (after last anno block; = bodyLines.length if none). */
  newAnnoAt: number;
}
export function parseLayout(text: string): SidecarLayout;
```

**`commentRegionEnd(bodyLines, from)`** — exclusive end line of a unit's comment region starting at `from` (just after the blockquote run):
- scan forward; if `[/]:#` terminator found before any boundary → return `terminatorLine + 1` (terminator consumed);
- else stop at a code fence / blockquote / EOF, then trim trailing blank lines → return that index.
- For a comment-less unit this returns `from` (blanks trimmed), so `unitEnd === blockquoteEnd`.

Refactor `extractComment` to call `commentRegionEnd` for its upper bound (DRY; no behavior change — verify existing sidecar tests still pass).

**`parseLayout`** mirrors `parseSidecar`'s strict path but records spans:
- `frontmatterRaw` = `lines[0..end]` joined (the `---`…`---` block).
- For each unit: `unitStart = i`, blockquote run `[i, end)`, `unitEnd = commentRegionEnd(bodyLines, end)`.
- For each unit's record id: `annoStart/annoEnd` from the matching fence (`open`, `close+1`).
- `newAnnoAt = max(close)+1` over fences, else `bodyLines.length`.
- `newUnitAt`: let `lastUnitEnd = max(unitEnd)` (or `0` if no units); among fences with `open >= lastUnitEnd`, the min `open`; if none, `lastUnitEnd`; if no fences at all, `bodyLines.length`.

- [ ] **Step 1:** Write failing tests in `layout.test.ts`: (a) canonical 2-unit-with-comments file → correct `unitStart/unitEnd/annoStart/annoEnd` and `newUnitAt` = first anno fence, `newAnnoAt` = end; (b) interleaved groups (units, anno, anno, units, anno, anno) → `newUnitAt` = start of the **last** anno group, `newAnnoAt` = end; (c) comment-less unit immediately followed by another unit → `unitEnd` = blockquote end, the blank line excluded; (d) custom content (top heading, between-unit prose with a `[/]:#`, bottom summary after anno blocks) → spans exclude the custom lines.
- [ ] **Step 2:** Run `pnpm test layout` → FAIL (`parseLayout` not exported).
- [ ] **Step 3:** Implement `commentRegionEnd`, refactor `extractComment`, implement `parseLayout`.
- [ ] **Step 4:** Run `pnpm test layout` and `pnpm test sidecar` → PASS (both). `pnpm typecheck` → clean.
- [ ] **Step 5:** Commit `feat(sidecar): layout-aware parse exposing per-id line spans`.

---

### Task 2: Export per-unit serializers from `src/sidecar/serialize.ts`

`patchSidecar` re-serializes only changed/new units and anno blocks; reuse the exact emitters `serializeSidecar` already uses.

**Files:** Modify `src/sidecar/serialize.ts`; update `src/sidecar/index.ts`.

- [ ] **Step 1:** Change `serializeBlockquote`, `serializeAnnoBlock`, `serializeUnit` from private to `export` (keep `serializeSidecar` calling them — no behavior change). Export `COMMENT_END` too.
- [ ] **Step 2:** Run `pnpm test sidecar` → PASS (round-trip unchanged), `pnpm typecheck` → clean.
- [ ] **Step 3:** Commit `refactor(sidecar): export per-unit serializers for reuse`.

---

### Task 3: `patchSidecar` in `src/sidecar/patch.ts` (the core)

**Files:** Create `src/sidecar/patch.ts`; Test `src/sidecar/patch.test.ts`.

**Interface produced:**
```ts
/** Structure-preserving in-place edit: returns originalText patched by `mutate`,
 *  keeping all non-annotation content byte-for-byte. Strict parse (throws on a
 *  malformed unit). Invariant: parseSidecar(patchSidecar(t, m)) deep-equals m(parseSidecar(t)). */
export function patchSidecar(originalText: string, mutate: (s: Sidecar) => void): string;
```

**Algorithm:**
1. `layout = parseLayout(originalText)`; `before = layout.sidecar`.
2. `after = structuredClone(before)`; `mutate(after)`.
3. Frontmatter: if `!deepEqual(before.frontmatter, after.frontmatter)` → `fm = '---\n' + dumpFrontmatter(after.frontmatter).replace(/\n$/,'') + '\n---'`; else `fm = layout.frontmatterRaw`.
4. Index `beforeById`, `afterById`, `layoutById` by id. Classify: `removed` (before∖after), `added` (after∖before), `kept` (∩).
5. Per kept id compute:
   - `unitChanged = b.quote !== a.quote || b.comment !== a.comment`
   - `annoChanged = !recordEqual(b.record, a.record) || (b.comment.length > 0) !== (a.comment.length > 0)`
   - (`recordEqual` = `JSON.stringify` of the record; key order is stable across clone.)
6. Build the new **body** by walking `bodyLines` with a `while` cursor `j`:
   - Emit added **units** when `j === newUnitAt` (before processing that line), then added **anno blocks** when `j === newAnnoAt`. (If both equal the same index, units first.)
   - If `j` starts a unit span: removed → skip to `unitEnd`; changed-unit → emit `serializeUnit(after)` lines, skip to `unitEnd`; unchanged → copy `[unitStart,unitEnd)` verbatim.
   - If `j` starts an anno span: removed → skip to `annoEnd`; changed-anno → emit `serializeAnnoBlock(after)`, skip to `annoEnd`; unchanged → copy verbatim.
   - Else copy `bodyLines[j]` verbatim.
   - After the loop, if `newUnitAt`/`newAnnoAt === bodyLines.length`, emit remaining added units then added anno blocks at end.
   - Use an `insertBlock` helper that guarantees exactly one blank line between an inserted block and its neighbors (prepend a blank if the previous emitted line is non-blank; append a blank if the next original line is non-blank).
7. Return `fm + '\n' + body.join('\n')` normalized to the canonical shape `---\n…\n---\n\n<body>\n` only where bytes were actually inserted; **unchanged regions stay byte-identical**, so `patchSidecar(t, noop) === t` for canonically-serialized `t`.

**Tests (write first, assert exact output strings):**
- [ ] noop identity: `patchSidecar(canonical, () => {}) === canonical`.
- [ ] add one highlight → new unit lands immediately before the (single, trailing) anno group; new anno block appended at end; everything else byte-identical.
- [ ] add with interleaved groups → new unit before the **last** group; new anno at end.
- [ ] custom content preserved: a top `# Heading`, a between-units paragraph after a `[/]:#`, and a bottom `## Summary` after the anno blocks all survive an add unchanged.
- [ ] update comment (`a.comment = 'x'`) → only that unit's region changes (+ anno gains `comment: true` if it was empty); other units & custom content byte-identical.
- [ ] update color (`a.record.color = '#fff'`) → only that **anno block** changes; the unit text is byte-identical.
- [ ] delete → that unit span and that anno span removed; neighbors intact; no leftover `[/]:#` or doubled blank lines.
- [ ] repair (quote rewrite + qhash/before/after change, mimicking `persistRepairs`) → unit and anno both updated in place; position unchanged.
- [ ] frontmatter change (`s.frontmatter.source_hash = '…'`) → frontmatter block re-emitted, body untouched.
- [ ] empty body (frontmatter only) + add → unit then anno appended.
- [ ] invariant property: for each case, `parseSidecar(patchSidecar(t, m))` deep-equals a separately `mutate`-applied `parseSidecar(t)`.
- [ ] strict: a malformed unit in `t` makes `patchSidecar` **throw**.

- [ ] **Step 1:** Write the tests above. **Step 2:** Run `pnpm test patch` → FAIL. **Step 3:** Implement `patch.ts`. **Step 4:** Run `pnpm test patch` + `pnpm test sidecar` → PASS; `pnpm typecheck` clean. **Step 5:** Commit `feat(sidecar): structure-preserving patchSidecar`.

---

### Task 4: Wire `patchSidecar` into the store write path

**Files:** Modify `src/store/store.ts` (`rmw`, `mutateById`); export `patchSidecar` from `src/sidecar/index.ts`.

- `rmw`: `vault.process(file, (text) => patchSidecar(text, mutate))` (was `parse → mutate → serialize`).
- `mutateById`: `vault.process(sidecarFile, (text) => patchSidecar(text, (s) => { const a = s.annotations.find(x => x.id === id); if (a) fn(a, s); }))`.
- `createAt` keeps `serializeSidecar` (fresh file). The collision "continue" path already goes through `rmw`, so it inherits patching (and frontmatter re-emit on the `annotates`/`source_hash` change is handled by Task 3 step 3).

- [ ] **Step 1:** Make the edits. **Step 2:** `pnpm typecheck` → clean; `pnpm test` (full) → 307+ PASS, including `pipeline.test.ts`. **Step 3:** Commit `feat(store): patch sidecars in place instead of full rewrite`.

---

### Task 5: Live-vault e2e — custom content survives an edit cycle

Per the project's verify-by-running practice (runtime layers aren't unit-tested). Prove a user-added section is preserved across add/edit/delete, and that the test has teeth (neutralize → fail → restore → pass).

**Files:** Create `test/playground/specs/structure-preserving-write.e2e.ts` (model on `sidecar-format.e2e.ts`).

- Seed a note + a sidecar that contains a custom `## My notes` section between units (or a top heading). Highlight a new passage via the toolbar/command. Read the sidecar back: assert the custom section text is **still present** and the new unit sits before the trailing anno group.
- [ ] **Step 1:** Write the spec. **Step 2:** Build to root (`pnpm build`, copy `main.js`/`.map`/`styles.css` up). **Step 3:** `pnpm test:e2e --spec structure-preserving-write` → PASS. **Step 4:** Neutralize (temporarily revert `rmw` to `serializeSidecar`) → run → FAIL (custom section gone) → restore → PASS. **Step 5:** Commit `test(e2e): structure-preserving sidecar write on real Obsidian`.

---

### Task 6: Docs + closing ritual

**Files:** Modify `CLAUDE.md` (write-path bullet under the sidecar invariants), `docs/Design.md` (new subsection: in-place patch vs. full rewrite, the insertion rules, the migrate-on-touch consequence).

- [ ] Document: writes now patch in place via `patchSidecar`; `serializeSidecar` is create-only; legacy `status`/spacing migrate to disk only for **touched** units (in-memory always correct via read-time migration); interleaved anno-block grouping and custom content are preserved.
- [ ] Capture learnings to memory if any surface during implementation.
- [ ] Commit `docs: structure-preserving sidecar writes`.

---

## Self-Review

- **Spec coverage:** preserve top/between/bottom custom content (Tasks 1,3,5), interleaved groups (Tasks 1,3), update-existing-only (Task 3 color/comment cases), append-new-before-last-anno-group (Tasks 1,3), strict-write safety (Task 3), no call-site churn (Task 4). ✓
- **Type consistency:** `parseLayout`/`SidecarLayout`/`UnitLayout` defined in Task 1 and consumed in Task 3; `serializeUnit`/`serializeAnnoBlock` exported in Task 2, consumed in Task 3; `patchSidecar` defined in Task 3, consumed in Task 4. ✓
- **Risk:** blank-line bookkeeping on insert/delete — mitigated by exact-output tests; the load-bearing invariant (`noop === t`, semantic re-parse equality) is independent of cosmetic blank counts.
