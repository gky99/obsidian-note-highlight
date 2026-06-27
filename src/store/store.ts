/**
 * The in-memory annotation store — the runtime hub that ties sidecar I/O and the
 * resolver to the Obsidian vault (Design.md §9).
 *
 * Responsibilities:
 *  - Load a source note's sidecar, parse it, and re-resolve every annotation
 *    against the *current* source bytes (§6.3) into {@link ResolvedAnnotation}s.
 *  - Look annotations up by source path and `^anno-id` for the renderers / aside.
 *  - Create a highlight from an editor selection (capture quote + context + pin +
 *    heading), and write comment / color / deletion changes back atomically.
 *  - Notify subscribers (editor extension, aside panel) when a file's
 *    annotations change.
 *
 * All re-resolution is live; nothing trusts a stored coordinate.
 */
import { TFile, Notice, normalizePath, type App, type CachedMetadata } from 'obsidian';

import type { Sidecar, Annotation, AnnoRecord, SidecarFrontmatter } from '@/model/types';
import { SCHEMA_VERSION } from '@/model/types';
import {
  parseSidecar,
  patchSidecar,
  serializeSidecar,
  sortHighlights,
  SidecarSchemaError,
  type ParseIssue,
} from '@/sidecar';
import { resolve, type ResolveResult } from '@/resolver';
import {
  buildStructure,
  findEnclosingBlockId,
  findEnclosingHeadingPath,
} from '@/obsidian/metadata';
import { annotatesLink, resolveAnnotates, sidecarPathForSource } from '@/obsidian/sidecar-path';
import { mergeResolved, pickPrimary } from './merge';
import { normalize, normalizeQuote, quoteHash } from '@/text/normalize';
import { bodyStart } from '@/text/frontmatter';
import { balanceEmphasisRange } from '@/text/emphasis';
import { contentHash } from '@/text/hash';
import type { MarginaliaSettings } from '@/settings';

/** A short base36 (uppercase) annotation id — replaces the long ULID; per-file unique. */
function shortId(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += Math.floor(Math.random() * 36)
      .toString(36)
      .toUpperCase();
  }
  return s;
}

/** An annotation paired with its live resolution against the current source. */
export interface ResolvedAnnotation {
  annotation: Annotation;
  result: ResolveResult;
  /** The annotation file this record came from (a clip may have several — §4.1). */
  sidecarPath: string;
}

/** A highlight to create in a batch (Web Highlights import): a range + presentation. */
export interface NewHighlight {
  from: number;
  to: number;
  color?: string;
  comment?: string;
}

interface SourceEntry {
  /** Every annotation file whose `annotates` resolves to this source (§4.1). */
  sidecars: { path: string; sidecar: Sidecar }[];
  resolved: ResolvedAnnotation[];
  /** The file that wins overlaps and receives new highlights (see {@link pickPrimary}). */
  primaryPath: string;
}

type ChangeListener = (sourcePath: string) => void;

/** The user's resolution when a new sidecar would collide with another note's. */
export type CollisionChoice = 'continue' | 'suffix' | 'cancel';

/** Context handed to {@link AnnotationStore.onCollision} so it can prompt the user. */
export interface SidecarCollision {
  /** The source note that wants to store annotations. */
  sourcePath: string;
  /** The canonical sidecar path that is already taken. */
  existingSidecarPath: string;
  /** The other note that owns the existing sidecar (its `annotates`), if known. */
  existingAnnotates: string | null;
}

/** Asks the user how to resolve a sidecar name collision; wired to a modal in `main.ts`. */
export type CollisionResolver = (collision: SidecarCollision) => Promise<CollisionChoice>;

export class AnnotationStore {
  private entries = new Map<string, SourceEntry>();
  private listeners = new Set<ChangeListener>();
  /**
   * Session-sticky binding of a source to the exact sidecar path we resolved or
   * created for it. Bridges the metadataCache lag right after a `vault.create`,
   * and — once set — lets repeat writes skip the collision prompt. Only set when
   * ownership is certain (own canonical / own disambiguated / a committed choice),
   * never from a shared-fallback read, so a *first* write to a colliding source
   * still prompts. Rebuilt from disk after a reload; cleared on {@link forget}.
   */
  private resolvedSidecar = new Map<string, string>();
  /**
   * Highlights under an active in-session deletion run, by `sourcePath → ids`
   * (§6.5). While suppressed, {@link resolveAll} holds the record untouched — it
   * never repairs the quote to a fragment nor flips status — so a delete-by-word
   * ends in an orphan that still carries the *original* quote. Driven by the
   * editor's run tracker via {@link suppressRepair}/{@link releaseRepair}.
   */
  private suppressed = new Map<string, Set<string>>();

  /**
   * Optional collision prompt. Invoked only when a source's *first* sidecar would
   * land on a canonical name already owned by a different note (basename clash in
   * a flat sidecar folder). Unset → default to {@link CollisionChoice} `suffix`
   * (data-preserving, no prompt).
   */
  onCollision?: CollisionResolver;

  constructor(
    private readonly app: App,
    public settings: MarginaliaSettings,
  ) {}

  /** Subscribe to per-file change notifications; returns an unsubscribe fn. */
  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(sourcePath: string): void {
    for (const fn of this.listeners) fn(sourcePath);
  }

  /** Canonical vault path of the sidecar that would annotate `sourcePath`. */
  sidecarPathFor(sourcePath: string): string {
    return normalizePath(
      sidecarPathForSource(sourcePath, this.settings.sidecarSuffix, this.settings.sidecarFolder),
    );
  }

  /** The Nth numbered sidecar slot for a source in folder mode (§4.1). */
  private suffixedPath(sourcePath: string, n: number): string {
    return normalizePath(
      sidecarPathForSource(sourcePath, this.settings.sidecarSuffix, this.settings.sidecarFolder, n),
    );
  }

  /**
   * The first *free* numbered sidecar slot `-1, -2, …` for this source (folder mode).
   * Stops at the first path with no file — safe because the plugin never auto-deletes a
   * sidecar (emptied ones persist), so a numbered cluster has no gaps.
   */
  private firstFreePath(sourcePath: string): string {
    const MAX = 1000; // runaway guard; real clusters are tiny
    for (let n = 1; n <= MAX; n++) {
      const path = this.suffixedPath(sourcePath, n);
      if (!this.fileAt(path)) return path;
    }
    return this.suffixedPath(sourcePath, MAX);
  }

  /** True when a custom sidecar folder is configured (the only place collisions arise). */
  private folderMode(): boolean {
    return this.settings.sidecarFolder.replace(/^\/+|\/+$/g, '') !== '';
  }

  private fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /**
   * The source a sidecar declares it annotates, as a concrete vault path. The stored
   * `annotates` is a wikilink, so resolve it through the metadata cache (relative to the
   * sidecar) — this is what keeps ownership matching correct after Obsidian rewrites the
   * link on a source move/rename.
   */
  private annotatesOf(file: TFile): string | null {
    const a = this.app.metadataCache.getFileCache(file)?.frontmatter?.annotates;
    return typeof a === 'string' && a ? resolveAnnotates(this.app.metadataCache, file.path, a) : null;
  }

  private bind(sourcePath: string, file: TFile): TFile {
    this.resolvedSidecar.set(sourcePath, file.path);
    return file;
  }

  /**
   * Every annotation file that belongs to `sourcePath`, identified **by `annotates`**
   * (§4.1) — location- and name-independent, so a moved/renamed file is still found.
   *
   * Two passes: (1) the authoritative set — every markdown file whose `annotates`
   * resolves to the source, wherever it lives; (2) a metadataCache-lag fast path — the
   * name-convention locations (canonical + numbered slots) and the sticky binding,
   * which is where the plugin *creates* sidecars. A just-created file's `annotates` is
   * not indexed for a moment, so pass (1) misses it; pass (2) accepts such a file when
   * its `annotates` is not yet resolvable (`null`). A file whose `annotates` clearly
   * resolves *elsewhere* (a collision sibling, or a "Continue" override that repointed
   * it) is left out — identity-by-link wins once the cache is warm.
   */
  private sidecarsFor(sourcePath: string): TFile[] {
    const out = new Map<string, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.annotatesOf(f) === sourcePath) out.set(f.path, f);
    }

    const accept = (f: TFile | null): void => {
      if (f && !out.has(f.path) && this.annotatesOf(f) === null) out.set(f.path, f);
    };
    accept(this.fileAt(this.sidecarPathFor(sourcePath)));
    if (this.folderMode()) {
      const MAX = 1000; // runaway guard; real clusters are tiny
      for (let n = 1; n <= MAX; n++) {
        const f = this.fileAt(this.suffixedPath(sourcePath, n));
        if (!f) break;
        accept(f);
      }
    }
    const bound = this.resolvedSidecar.get(sourcePath);
    if (bound) {
      const f = this.fileAt(bound);
      if (f) accept(f);
      else this.resolvedSidecar.delete(sourcePath);
    }

    return [...out.values()];
  }

  /** Does at least one annotation file exist for this source? */
  hasSidecar(sourcePath: string): boolean {
    return this.sidecarsFor(sourcePath).length > 0;
  }

  /** Currently-loaded resolved annotations for a source (empty if not loaded). */
  getResolved(sourcePath: string): ResolvedAnnotation[] {
    return this.entries.get(sourcePath)?.resolved ?? [];
  }

  getById(sourcePath: string, id: string): ResolvedAnnotation | undefined {
    return this.entries.get(sourcePath)?.resolved.find((r) => r.annotation.id === id);
  }

  /**
   * The first *anchored* annotation whose live range overlaps `[from, to)`, or
   * `undefined` if none. Backs the "one passage, one highlight" rule: the toolbar
   * routes a selection over an existing highlight to edit mode, and
   * {@link createHighlight} refuses to stack a new highlight on top of one.
   */
  annotationAt(sourcePath: string, from: number, to: number): ResolvedAnnotation | undefined {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return this.getResolved(sourcePath).find(
      (r) =>
        r.result.status === 'anchored' &&
        Math.max(lo, r.result.range.from) < Math.min(hi, r.result.range.to),
    );
  }

  /** Drop any cached state for a source (e.g. on file delete). */
  forget(sourcePath: string): void {
    this.resolvedSidecar.delete(sourcePath);
    this.suppressed.delete(sourcePath);
    if (this.entries.delete(sourcePath)) this.emit(sourcePath);
  }

  /**
   * Mark a highlight as being actively deleted in the editor (§6.5): its record
   * is held untouched on subsequent loads until {@link releaseRepair}. Driven by
   * the editor's deletion-run tracker.
   */
  suppressRepair(sourcePath: string, id: string): void {
    let ids = this.suppressed.get(sourcePath);
    if (!ids) this.suppressed.set(sourcePath, (ids = new Set()));
    ids.add(id);
  }

  private dropSuppress(sourcePath: string, id: string): void {
    const ids = this.suppressed.get(sourcePath);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.suppressed.delete(sourcePath);
  }

  /**
   * Which source is currently holding `id` for a deletion run. Resolving the
   * source from the suppression map (rather than the active editor) keeps a run
   * that ends after the user switched notes — e.g. on focus-loss — pointed at the
   * file it actually started in.
   */
  private sourceFileOfRun(id: string): TFile | null {
    for (const [path, ids] of this.suppressed) {
      if (!ids.has(id)) continue;
      const f = this.app.vault.getAbstractFileByPath(path);
      return f instanceof TFile ? f : null;
    }
    return null;
  }

  /**
   * A deletion run ended with the highlight **gone** (collapse): stop holding it
   * and re-resolve. The original quote was held throughout, so the load path now
   * orphans carrying that original passage. Best-effort.
   */
  releaseRepair(id: string): void {
    const sourceFile = this.sourceFileOfRun(id);
    if (!sourceFile) return;
    this.dropSuppress(sourceFile.path, id);
    void this.load(sourceFile);
  }

  /**
   * A deletion run ended with the highlight **surviving** (settle / edit): commit
   * the survivor from the editor's *exact* live range `[from, to)` over `docText`.
   * This bypasses fuzzy resolution, which overshoots a shortened passage (it
   * scores trailing substitutions above the deletion). Writes the new quote +
   * context straight to the sidecar, then re-resolves (the survivor now matches
   * exact). Best-effort — never throws into the editor callback.
   */
  async commitSurvivor(id: string, docText: string, from: number, to: number): Promise<void> {
    const sourceFile = this.sourceFileOfRun(id);
    if (!sourceFile) return;
    this.dropSuppress(sourceFile.path, id);
    const quote = tidyQuote(docText.slice(Math.min(from, to), Math.max(from, to)));
    if (normalizeQuote(quote).length === 0) {
      // Nothing meaningful survived → fall back to the orphan-with-original path.
      void this.load(sourceFile);
      return;
    }
    const n = this.settings.contextChars;
    const before = contextBefore(docText, from, n);
    const after = contextAfter(docText, to, n);
    const qhash = quoteHash(quote);
    // Commit into whichever of the clip's annotation files holds this id (§4.1).
    const sidecarPath = this.getById(sourceFile.path, id)?.sidecarPath;
    const file = sidecarPath ? this.fileAt(sidecarPath) : null;
    if (file) {
      try {
        await this.rmw(file, (disk) => {
          const a = disk.annotations.find((x) => x.id === id);
          if (!a) return;
          a.quote = quote;
          a.record.before = before;
          a.record.after = after;
          a.record.qhash = qhash;
        });
      } catch {
        // Strict-write refusal (malformed neighbor) / write error — the reload
        // below still re-resolves the held original; never clobber.
      }
    }
    await this.load(sourceFile);
  }

  /**
   * An undo/redo hit an active deletion run: the held quote was never changed, so
   * re-anchor it against the **live editor text** (the file may still lag the undo,
   * and the live decoration is stale because an exclusive mark doesn't re-grow on a
   * re-inserted edge). The quote is *held* (not repaired) — an undo restores content
   * toward the original — and we update only the live result + status for an
   * immediate repaint; the next autosave reload persists durably (§6.5).
   */
  recheckRun(id: string, liveText: string): void {
    const sourceFile = this.sourceFileOfRun(id);
    if (!sourceFile) return;
    this.dropSuppress(sourceFile.path, id);
    const entry = this.entries.get(sourceFile.path);
    const r = entry?.resolved.find((x) => x.annotation.id === id);
    if (!r) {
      void this.load(sourceFile);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(sourceFile) ?? {};
    const structure = buildStructure(cache, liveText.length);
    const result = resolve(r.annotation, liveText, structure, {
      fuzzyThreshold: this.settings.fuzzyThreshold,
      contextChars: this.settings.contextChars,
    });
    r.result = result;
    r.annotation.record.status = result.status === 'anchored' ? result.confidence : 'orphan';
    this.emit(sourceFile.path);
  }

  /**
   * Read and re-resolve a source's sidecar. Safe to call repeatedly (on
   * file-open, on source/sidecar change). Returns the resolved annotations and
   * notifies subscribers.
   */
  async load(sourceFile: TFile): Promise<ResolvedAnnotation[]> {
    const files = this.sidecarsFor(sourceFile.path);
    if (files.length === 0) {
      this.forget(sourceFile.path);
      return [];
    }

    const sourceText = await this.app.vault.cachedRead(sourceFile);
    // Parse + resolve every annotation file independently and tolerantly: a malformed
    // unit is skipped (collected), and a whole unparseable/schema-bad file is dropped
    // with a Notice — neither blanks the rest of the clip's other files (§4.1).
    const sidecars: { path: string; sidecar: Sidecar }[] = [];
    const perFile: { sidecarPath: string; resolved: ResolvedAnnotation[] }[] = [];
    const repairs: { file: TFile; changed: Set<string> }[] = [];
    for (const file of files) {
      const issues: ParseIssue[] = [];
      let sidecar: Sidecar;
      try {
        sidecar = parseSidecar(await this.app.vault.cachedRead(file), (i) => issues.push(i));
      } catch (e) {
        const why =
          e instanceof SidecarSchemaError
            ? `unsupported annotation_schema (${e.found ?? 'none'})`
            : 'could not be parsed';
        new Notice(`Marginalia: sidecar ${file.path} ${why}.`);
        continue;
      }
      if (issues.length > 0) {
        const n = issues.length;
        new Notice(
          `Marginalia: skipped ${n} malformed annotation${n > 1 ? 's' : ''} in ${file.path}.`,
        );
      }
      const { resolved, changed } = this.resolveAll(sourceFile, sourceText, sidecar, file.path);
      sidecars.push({ path: file.path, sidecar });
      perFile.push({ sidecarPath: file.path, resolved });
      if (changed.size > 0) repairs.push({ file, changed });
    }

    if (sidecars.length === 0) {
      this.forget(sourceFile.path);
      return [];
    }

    const primaryPath = pickPrimary(
      sidecars.map((s) => ({ path: s.path, mtime: this.fileAt(s.path)?.stat.mtime ?? 0 })),
      this.sidecarPathFor(sourceFile.path),
      this.resolvedSidecar.get(sourceFile.path),
    );
    const resolved = mergeResolved(perFile, primaryPath);
    this.entries.set(sourceFile.path, { sidecars, resolved, primaryPath });
    this.resolvedSidecar.set(sourceFile.path, primaryPath);
    // Don't repaint while a deletion run is active: the held resolution is a fuzzy
    // (over-extended) match, and repainting from it would corrupt the live CM
    // decoration the editor reads to commit the survivor. The CM mapping keeps the
    // decoration clean on its own meanwhile (§6.5).
    if (!this.suppressed.has(sourceFile.path)) this.emit(sourceFile.path);
    // Self-heal: persist each file's repairs / status promotions once, best-effort
    // and never clobbering (§6.5). Fire-and-forget — the in-memory state is live.
    for (const { file, changed } of repairs) void this.persistRepairs(sourceFile, file, changed);
    return resolved;
  }

  /**
   * Write back the §6.5 self-healing changes (repaired quote, refreshed context,
   * status promotion/orphan) for `changed` ids in one of the clip's sidecars,
   * batched into one atomic write. Reads the new values from that file's live
   * in-memory annotations and applies them by id to the freshly-parsed on-disk
   * sidecar. Strict by construction (via {@link rmw}): if another unit on disk is
   * malformed the write refuses rather than clobber it (§10 #11); the in-memory
   * repair still holds for the session. Best-effort — never throws into load.
   */
  private async persistRepairs(
    sourceFile: TFile,
    sidecarFile: TFile,
    changed: Set<string>,
  ): Promise<void> {
    const mem = this.entries
      .get(sourceFile.path)
      ?.sidecars.find((s) => s.path === sidecarFile.path)?.sidecar;
    if (!mem) return;
    try {
      await this.rmw(sidecarFile, (disk) => {
        for (const diskAnno of disk.annotations) {
          if (!changed.has(diskAnno.id)) continue;
          const memAnno = mem.annotations.find((a) => a.id === diskAnno.id);
          if (!memAnno) continue;
          diskAnno.quote = memAnno.quote;
          diskAnno.record.status = memAnno.record.status;
          diskAnno.record.before = memAnno.record.before;
          diskAnno.record.after = memAnno.record.after;
          diskAnno.record.qhash = memAnno.record.qhash;
          diskAnno.record.pin = memAnno.record.pin;
          diskAnno.record.heading = memAnno.record.heading;
        }
      });
    } catch {
      // Strict-write refusal (a malformed unit elsewhere) or write error: keep the
      // in-memory repair, never clobber. Self-healing retries on the next load.
    }
  }

  /**
   * Re-resolve every annotation and fold the §6.5 verdict back onto its record:
   * `status` becomes the live confidence (`unique`/`exact`/`orphan`), and a fuzzy
   * hit *repairs* the stored quote to the matched bytes + refreshes context so it
   * resolves exact next time. Returns the resolutions plus the set of ids whose
   * record actually changed, so {@link load} can persist them in one write.
   */
  private resolveAll(
    sourceFile: TFile,
    sourceText: string,
    sidecar: Sidecar,
    sidecarPath: string,
  ): { resolved: ResolvedAnnotation[]; changed: Set<string> } {
    const cache = this.app.metadataCache.getFileCache(sourceFile) ?? {};
    const structure = buildStructure(cache, sourceText.length);
    const options = {
      fuzzyThreshold: this.settings.fuzzyThreshold,
      contextChars: this.settings.contextChars,
    };
    const n = this.settings.contextChars;
    const changed = new Set<string>();
    const suppressed = this.suppressed.get(sourceFile.path);

    const resolved = sidecar.annotations.map((annotation) => {
      const result = resolve(annotation, sourceText, structure, options);
      // Held during an active in-session deletion run (§6.5): leave the record
      // entirely untouched (original quote + status) so a delete-by-word ends in
      // an orphan that still shows the original passage, not a fragment.
      if (suppressed?.has(annotation.id)) return { annotation, result, sidecarPath };
      const r = annotation.record;
      const before = JSON.stringify([r.status, annotation.quote, r.before, r.after, r.pin, r.heading]);

      if (result.status === 'anchored') {
        const { from, to } = result.range;
        if (result.method === 'fuzzy') {
          // The stored quote drifted: repair it to the matched bytes so it
          // resolves exact next time (§6.5).
          const repaired = tidyQuote(sourceText.slice(from, to));
          annotation.quote = repaired;
          r.qhash = quoteHash(repaired);
        }
        // Refresh the disambiguators when they did real work — a context-
        // disambiguated or fuzzy anchor — recovering any signal (before/after,
        // pin, heading) that has drifted, so cumulative nearby edits don't slowly
        // starve an ambiguous highlight of evidence (§6.5). A plain unique exact
        // hit never consults them, so it is left untouched (no churn). Structural
        // fields update only when re-derivable, never cleared on a cache miss.
        if (result.method === 'context' || result.method === 'fuzzy') {
          r.before = contextBefore(sourceText, from, n);
          r.after = contextAfter(sourceText, to, n);
          const pinId = findEnclosingBlockId(cache, from);
          if (pinId) r.pin = `^${pinId}`;
          const headingPath = findEnclosingHeadingPath(cache, from);
          if (headingPath) r.heading = headingPath;
        }
        r.status = result.confidence; // unique | exact
      } else {
        r.status = 'orphan';
      }

      if (JSON.stringify([r.status, annotation.quote, r.before, r.after, r.pin, r.heading]) !== before) {
        changed.add(annotation.id);
      }
      return { annotation, result, sidecarPath };
    });

    return { resolved, changed };
  }

  /** Ids used by any of this source's loaded annotation files (the union — §4.1). */
  private takenIds(sourcePath: string): Set<string> {
    return new Set(
      this.entries.get(sourcePath)?.sidecars.flatMap((s) => s.sidecar.annotations.map((a) => a.id)) ?? [],
    );
  }

  /** A short id not already used by any of this source's loaded annotations. */
  private freshId(sourcePath: string): string {
    const taken = this.takenIds(sourcePath);
    let id = shortId();
    while (taken.has(id)) id = shortId();
    return id;
  }

  /**
   * Create a highlight from a source-text range `[from, to)`. Captures the quote,
   * before/after context, the enclosing block pin (if it has an id) and heading
   * path, then appends a new annotation to the sidecar (creating it if needed).
   */
  async createHighlight(
    sourceFile: TFile,
    from: number,
    to: number,
    color?: string,
  ): Promise<Annotation | null> {
    const sourceText = await this.app.vault.cachedRead(sourceFile);

    // The YAML frontmatter is metadata, not annotatable body text — and a highlight
    // anchored there can't be re-resolved or painted (§6.5). Refuse rather than
    // create one that would immediately orphan.
    const base = bodyStart(sourceText);
    if (Math.min(from, to) < base) {
      new Notice('Marginalia: highlight body text, not the note properties.');
      return null;
    }

    // Grow the range over any wrapping emphasis delimiter so a selection that
    // starts at the bold *content* (Live Preview conceals the `**`) still stores a
    // balanced quote — same rule the importer applies (Design.md §15.2).
    ({ from, to } = balanceEmphasisRange(sourceText, from, to, base));
    const quote = tidyQuote(sourceText.slice(from, to));
    if (normalizeQuote(quote).length === 0) {
      new Notice('Marginalia: select some text to highlight.');
      return null;
    }

    // A passage is highlighted at most once: never stack a new highlight on top
    // of an existing one (the toolbar offers recolor/delete on overlap instead).
    if (this.annotationAt(sourceFile.path, from, to)) {
      new Notice('Marginalia: that text is already highlighted.');
      return null;
    }

    const cache = this.app.metadataCache.getFileCache(sourceFile) ?? {};
    const record = this.buildRecord(sourceText, cache, this.freshId(sourceFile.path), from, to, quote, color);
    const annotation: Annotation = { id: record.id, quote, record, comment: '' };

    const written = await this.writeSidecar(sourceFile, sourceText, (s) => {
      s.annotations.push(annotation);
    });
    if (!written) return null; // user cancelled at the collision prompt
    await this.load(sourceFile);
    return annotation;
  }

  /**
   * Create several highlights in one atomic sidecar write — the primitive behind
   * the Web Highlights importer. Each range is captured exactly like
   * {@link createHighlight} (quote + context + pin + heading), but the whole batch
   * is appended and re-resolved once instead of per highlight. Ranges that are
   * empty, already highlighted, or overlap one accepted earlier in the batch are
   * skipped, upholding "one passage, one highlight" (§4.4). Returns the created
   * annotations (callers should de-overlap upstream too; this is the backstop).
   */
  async createHighlights(sourceFile: TFile, items: NewHighlight[]): Promise<Annotation[]> {
    if (items.length === 0) return [];
    const sourceText = await this.app.vault.cachedRead(sourceFile);
    const cache = this.app.metadataCache.getFileCache(sourceFile) ?? {};

    const base = bodyStart(sourceText);
    const taken = this.takenIds(sourceFile.path);
    const accepted: { from: number; to: number }[] = [];
    const created: Annotation[] = [];
    for (const item of items) {
      const lo = Math.min(item.from, item.to);
      const hi = Math.max(item.from, item.to);
      if (lo < base) continue; // never anchor into the frontmatter (§6.5)
      // Same wrapping-delimiter balancing as the single-create + import paths.
      const { from, to } = balanceEmphasisRange(sourceText, lo, hi, base);
      const quote = tidyQuote(sourceText.slice(from, to));
      if (normalizeQuote(quote).length === 0) continue;
      if (this.annotationAt(sourceFile.path, from, to)) continue;
      if (accepted.some((r) => Math.max(from, r.from) < Math.min(to, r.to))) continue;

      let id = shortId();
      while (taken.has(id)) id = shortId();
      taken.add(id);
      accepted.push({ from, to });
      const record = this.buildRecord(sourceText, cache, id, from, to, quote, item.color);
      created.push({ id, quote, record, comment: item.comment ?? '' });
    }
    if (created.length === 0) return [];

    const written = await this.writeSidecar(sourceFile, sourceText, (s) => {
      s.annotations.push(...created);
    });
    if (!written) return []; // user cancelled at the collision prompt
    await this.load(sourceFile);
    return created;
  }

  /** Capture an annotation's durable record for a source range `[from, to)` (§5.4). */
  private buildRecord(
    sourceText: string,
    cache: CachedMetadata,
    id: string,
    from: number,
    to: number,
    quote: string,
    color?: string,
  ): AnnoRecord {
    const n = this.settings.contextChars;
    const pinId = findEnclosingBlockId(cache, from);
    const headingPath = findEnclosingHeadingPath(cache, from);
    return {
      id,
      ...(pinId ? { pin: `^${pinId}` } : {}),
      ...(headingPath ? { heading: headingPath } : {}),
      before: contextBefore(sourceText, from, n),
      after: contextAfter(sourceText, to, n),
      qhash: quoteHash(quote),
      // §6.5: a fresh highlight is `unique` iff its quote occurs exactly once in
      // the source **body** (so it takes the cheap re-anchor path on reload), else
      // `exact`. The count excludes the frontmatter — matching the resolver, so a
      // quote the YAML title duplicates is still born `unique` (Design.md §6.5).
      status:
        countOccurrences(
          normalize(sourceText.slice(bodyStart(sourceText))).text,
          normalizeQuote(quote),
        ) === 1
          ? 'unique'
          : 'exact',
      color: color ?? this.settings.defaultColor,
      created: new Date().toISOString(),
    };
  }

  async updateComment(sourcePath: string, id: string, comment: string): Promise<void> {
    await this.mutateById(sourcePath, id, (a) => {
      a.comment = comment;
    });
  }

  async updateColor(sourcePath: string, id: string, color: string): Promise<void> {
    await this.mutateById(sourcePath, id, (a) => {
      a.record.color = color;
    });
  }

  async deleteAnnotation(sourcePath: string, id: string): Promise<void> {
    await this.mutateById(sourcePath, id, (_a, s) => {
      s.annotations = s.annotations.filter((x) => x.id !== id);
    });
  }

  // --- writes ------------------------------------------------------------

  private newFrontmatter(sourcePath: string, sourceText: string): SidecarFrontmatter {
    const fm: SidecarFrontmatter = {
      annotation_schema: SCHEMA_VERSION,
      annotates: annotatesLink(sourcePath),
      source_hash: contentHash(sourceText),
    };
    // User-configured fields, added to every annotation file as it's created
    // (both manual highlighting and import). Reserved keys can't be overridden.
    const reserved = new Set(['annotation_schema', 'annotates', 'source_hash']);
    for (const { key, value } of this.settings.sidecarFrontmatter ?? []) {
      const k = key.trim();
      if (k && !reserved.has(k)) fm[k] = value;
    }
    return fm;
  }

  /**
   * Atomic read-modify-write of an existing sidecar (§9). Patches the file **in
   * place** ({@link patchSidecar}) so custom content (headings, prose, summaries,
   * the on-disk `anno`-block grouping) survives the edit; only the changed/new/
   * removed annotations are touched. Strict parse — a malformed unit throws here,
   * refusing the write rather than clobbering.
   */
  private async rmw(file: TFile, mutate: (s: Sidecar) => void): Promise<void> {
    await this.app.vault.process(file, (text) => patchSidecar(text, mutate));
  }

  /** Create a fresh sidecar at `path` annotating `sourcePath`. */
  private async createAt(
    path: string,
    sourcePath: string,
    sourceText: string,
    mutate: (s: Sidecar) => void,
  ): Promise<void> {
    const sidecar: Sidecar = {
      frontmatter: this.newFrontmatter(sourcePath, sourceText),
      annotations: [],
    };
    mutate(sidecar);
    await this.ensureParentFolder(path);
    await this.app.vault.create(path, serializeSidecar(sidecar));
  }

  /**
   * Write a source's annotations, creating the first file if none exists yet (§9, §4.1).
   * A clip's files are identified by `annotates`, so when one or more already exist the
   * write goes to the {@link pickPrimary} primary — wherever it lives. Only when *none*
   * exists do we create one at the configured location, and only there can a flat-folder
   * basename clash with a **different** clip arise; {@link onCollision} resolves it:
   * `suffix` (a fresh numbered file), `continue` (take over the existing file for this
   * clip — override its `annotates`/`source_hash`, keeping its annotations), or `cancel`.
   * Returns `false` only on cancel.
   */
  private async writeSidecar(
    sourceFile: TFile,
    sourceText: string,
    mutate: (s: Sidecar) => void,
  ): Promise<boolean> {
    const source = sourceFile.path;
    try {
      // Existing annotation file(s) for this clip → write to the primary.
      const existing = this.sidecarsFor(source);
      if (existing.length > 0) {
        const primary = pickPrimary(
          existing.map((f) => ({ path: f.path, mtime: f.stat.mtime })),
          this.sidecarPathFor(source),
          this.resolvedSidecar.get(source),
        );
        const file = this.fileAt(primary);
        if (file) {
          await this.rmw(file, mutate);
          this.bind(source, file);
          return true;
        }
      }

      const canonical = this.sidecarPathFor(source);
      const canonicalFile = this.fileAt(canonical);

      // Alongside mode: the canonical name embeds the full source path → unique, so it
      // is always ours; never a collision. Adopt a stray file at the name if present.
      if (!this.folderMode()) {
        if (canonicalFile) await this.rmw(canonicalFile, mutate);
        else await this.createAt(canonical, source, sourceText, mutate);
        this.resolvedSidecar.set(source, canonical);
        return true;
      }

      // Folder mode, canonical name free → become its owner.
      if (!canonicalFile) {
        await this.createAt(canonical, source, sourceText, mutate);
        this.resolvedSidecar.set(source, canonical);
        return true;
      }

      // Folder mode, canonical name taken by a *different* clip (sidecarsFor found none
      // for us) → ask how to resolve the filename clash.
      const choice: CollisionChoice = this.onCollision
        ? await this.onCollision({
            sourcePath: source,
            existingSidecarPath: canonical,
            existingAnnotates: this.annotatesOf(canonicalFile),
          })
        : 'suffix';
      if (choice === 'cancel') return false;
      if (choice === 'suffix') {
        const free = this.firstFreePath(source);
        await this.createAt(free, source, sourceText, mutate);
        this.resolvedSidecar.set(source, free);
        return true;
      }
      // 'continue' → take over the existing file for this clip: override its link
      // (detaching the previous clip) and keep its annotations, then append the new one.
      await this.rmw(canonicalFile, (s) => {
        s.frontmatter.annotates = annotatesLink(source);
        s.frontmatter.source_hash = contentHash(sourceText);
        mutate(s);
      });
      this.bind(source, canonicalFile);
      return true;
    } catch (e) {
      new Notice(`Marginalia: failed to write sidecar — ${String(e)}`);
      throw e;
    }
  }

  /** Create any missing ancestor folders for `filePath` (custom save location). */
  private async ensureParentFolder(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf('/');
    if (slash <= 0) return; // top-level file: parent is the vault root.
    const segments = filePath.slice(0, slash).split('/');
    let dir = '';
    for (const segment of segments) {
      dir = dir ? `${dir}/${segment}` : segment;
      if (this.app.vault.getAbstractFileByPath(dir)) continue;
      try {
        await this.app.vault.createFolder(dir);
      } catch {
        // Already exists (race) or created by a concurrent write — fine.
      }
    }
  }

  private async mutateById(
    sourcePath: string,
    id: string,
    fn: (a: Annotation, s: Sidecar) => void,
  ): Promise<void> {
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    // Edit the file that actually holds this annotation (may be a non-primary one).
    const resolved = this.getById(sourcePath, id);
    const sidecarFile = resolved ? this.fileAt(resolved.sidecarPath) : null;
    if (!(sourceFile instanceof TFile) || !sidecarFile) return;
    try {
      await this.app.vault.process(sidecarFile, (text) =>
        patchSidecar(text, (sidecar) => {
          const a = sidecar.annotations.find((x) => x.id === id);
          if (a) fn(a, sidecar);
        }),
      );
    } catch (e) {
      new Notice(`Marginalia: failed to update sidecar — ${String(e)}`);
      throw e;
    }
    await this.load(sourceFile);
  }

  /**
   * Reorder each of a source's sidecar files so highlights sit in **source reading
   * order, within each heading section** (Design.md §5.7). The structure-preserving
   * reshuffle is the pure {@link sortHighlights}; here we just supply each id's live
   * source offset (orphans have none → they sink to the end of their section) and
   * write each file via `vault.process`. Returns the number of files actually sorted.
   */
  async sortBySourcePosition(sourceFile: TFile): Promise<number> {
    const resolved = await this.load(sourceFile);
    const positionById = new Map<string, number>();
    for (const r of resolved) {
      if (r.result.status === 'anchored') positionById.set(r.annotation.id, r.result.range.from);
    }
    const positionOf = (id: string): number | null => positionById.get(id) ?? null;

    let sorted = 0;
    for (const file of this.sidecarsFor(sourceFile.path)) {
      try {
        await this.app.vault.process(file, (text) => sortHighlights(text, positionOf));
        sorted++;
      } catch (e) {
        // A malformed unit makes the strict parse refuse (never clobber); skip that file.
        new Notice(`Marginalia: couldn't sort ${file.name} — ${String(e)}`);
      }
    }
    if (sorted > 0) await this.load(sourceFile);
    return sorted;
  }
}

// --- quote / context capture helpers ------------------------------------

/** Count non-overlapping occurrences of `needle` in `hay` (both already normalized). */
function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) break;
    count++;
    i = at + needle.length;
  }
  return count;
}

/**
 * Tidy a raw selection into a readable, stable quote: collapse intra-line
 * whitespace, trim around newlines, drop blank-line gaps, trim the ends. Newlines
 * are preserved so heading-spanning quotes keep their structure in the blockquote
 * (§6.4); the resolver re-normalizes anyway, so matching is unaffected.
 */
function tidyQuote(raw: string): string {
  return raw
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** ~`n` whitespace-collapsed chars immediately before `from`. */
function contextBefore(sourceText: string, from: number, n: number): string {
  const slice = sourceText.slice(Math.max(0, from - n * 3), from);
  return normalize(slice).text.slice(-n);
}

/** ~`n` whitespace-collapsed chars immediately after `to`. */
function contextAfter(sourceText: string, to: number, n: number): string {
  const slice = sourceText.slice(to, to + n * 3);
  return normalize(slice).text.slice(0, n);
}
