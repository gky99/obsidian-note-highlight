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
import { parseSidecar, serializeSidecar, SidecarSchemaError, type ParseIssue } from '@/sidecar';
import { resolve, type ResolveResult } from '@/resolver';
import {
  buildStructure,
  findEnclosingBlockId,
  findEnclosingHeadingPath,
} from '@/obsidian/metadata';
import { sidecarPathForSource } from '@/obsidian/sidecar-path';
import { normalize, normalizeQuote, quoteHash } from '@/text/normalize';
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
}

/** A highlight to create in a batch (Web Highlights import): a range + presentation. */
export interface NewHighlight {
  from: number;
  to: number;
  color?: string;
  comment?: string;
}

interface SourceEntry {
  sidecarPath: string;
  sidecar: Sidecar;
  resolved: ResolvedAnnotation[];
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
   * Probe numbered sidecar slots `-1, -2, …` for this source. Returns the slot we
   * *own* (its `annotates` matches), if any, plus the first *free* slot to claim.
   * Stops at the first empty slot — safe because the plugin never auto-deletes a
   * sidecar file (emptied ones persist), so a numbered cluster has no gaps.
   */
  private probeSuffixed(sourcePath: string): { owned: TFile | null; firstFree: string } {
    const MAX = 1000; // runaway guard; real clusters are tiny
    for (let n = 1; n <= MAX; n++) {
      const path = this.suffixedPath(sourcePath, n);
      const file = this.fileAt(path);
      if (!file) return { owned: null, firstFree: path };
      if (this.annotatesOf(file) === sourcePath) return { owned: file, firstFree: path };
    }
    return { owned: null, firstFree: this.suffixedPath(sourcePath, MAX) };
  }

  /** True when a custom sidecar folder is configured (the only place collisions arise). */
  private folderMode(): boolean {
    return this.settings.sidecarFolder.replace(/^\/+|\/+$/g, '') !== '';
  }

  private fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** The source a sidecar declares it annotates (from cached frontmatter), if any. */
  private annotatesOf(file: TFile): string | null {
    const a = this.app.metadataCache.getFileCache(file)?.frontmatter?.annotates;
    return typeof a === 'string' && a ? a : null;
  }

  private bind(sourcePath: string, file: TFile): TFile {
    this.resolvedSidecar.set(sourcePath, file.path);
    return file;
  }

  /**
   * Locate the sidecar file holding `sourcePath`'s annotations. In a flat sidecar
   * folder two same-named notes can collide on the canonical name, so the lookup
   * is ownership-aware: prefer our own canonical sidecar, then our own numbered
   * one (found by probing slots and matching `annotates`), and only then fall back
   * to a *shared* canonical (the "Continue" outcome / a same-named note that never
   * opted out). The shared fallback is intentionally not bound, so a first write
   * to it still prompts.
   */
  private sidecarFileFor(sourcePath: string): TFile | null {
    const bound = this.resolvedSidecar.get(sourcePath);
    if (bound) {
      const f = this.fileAt(bound);
      if (f) return f;
      this.resolvedSidecar.delete(sourcePath);
    }

    const canonical = this.fileAt(this.sidecarPathFor(sourcePath));
    if (!this.folderMode()) return canonical ? this.bind(sourcePath, canonical) : null;

    if (canonical && this.annotatesOf(canonical) === sourcePath) return this.bind(sourcePath, canonical);
    const { owned } = this.probeSuffixed(sourcePath);
    if (owned) return this.bind(sourcePath, owned); // our own numbered sidecar
    return canonical; // shared fallback (unbound) or null
  }

  /** Does a sidecar file exist for this source (by naming convention)? */
  hasSidecar(sourcePath: string): boolean {
    return this.sidecarFileFor(sourcePath) !== null;
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
    if (this.entries.delete(sourcePath)) this.emit(sourcePath);
  }

  /**
   * Read and re-resolve a source's sidecar. Safe to call repeatedly (on
   * file-open, on source/sidecar change). Returns the resolved annotations and
   * notifies subscribers.
   */
  async load(sourceFile: TFile): Promise<ResolvedAnnotation[]> {
    const sidecarFile = this.sidecarFileFor(sourceFile.path);
    if (!sidecarFile) {
      this.forget(sourceFile.path);
      return [];
    }

    let sidecar: Sidecar;
    const issues: ParseIssue[] = [];
    try {
      // Read path: tolerant — a malformed unit is skipped and collected, never
      // blanking the rest of the file's rendering. Only fatal frontmatter/schema
      // problems throw and land below.
      sidecar = parseSidecar(await this.app.vault.cachedRead(sidecarFile), (i) => issues.push(i));
    } catch (e) {
      const why =
        e instanceof SidecarSchemaError
          ? `unsupported schema (${e.found ?? 'none'})`
          : 'could not be parsed';
      new Notice(`Marginalia: sidecar ${sidecarFile.path} ${why}.`);
      this.forget(sourceFile.path);
      return [];
    }
    if (issues.length > 0) {
      const n = issues.length;
      new Notice(
        `Marginalia: skipped ${n} malformed annotation${n > 1 ? 's' : ''} in ${sidecarFile.path}.`,
      );
    }

    const sourceText = await this.app.vault.cachedRead(sourceFile);
    const resolved = this.resolveAll(sourceFile, sourceText, sidecar);
    this.entries.set(sourceFile.path, { sidecarPath: sidecarFile.path, sidecar, resolved });
    this.emit(sourceFile.path);
    return resolved;
  }

  private resolveAll(sourceFile: TFile, sourceText: string, sidecar: Sidecar): ResolvedAnnotation[] {
    const cache = this.app.metadataCache.getFileCache(sourceFile) ?? {};
    const structure = buildStructure(cache, sourceText.length);
    const options = {
      fuzzyThreshold: this.settings.fuzzyThreshold,
      contextChars: this.settings.contextChars,
    };
    return sidecar.annotations.map((annotation) => {
      const result = resolve(annotation, sourceText, structure, options);
      // Reflect the live verdict onto the in-memory record for display (§6.2 #5).
      annotation.record.status = result.status === 'anchored' ? 'anchored' : 'orphaned';
      return { annotation, result };
    });
  }

  /** A short id not already used by this source's loaded annotations. */
  private freshId(sourcePath: string): string {
    const taken = new Set(
      this.entries.get(sourcePath)?.sidecar.annotations.map((a) => a.id) ?? [],
    );
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

    const taken = new Set(
      this.entries.get(sourceFile.path)?.sidecar.annotations.map((a) => a.id) ?? [],
    );
    const accepted: { from: number; to: number }[] = [];
    const created: Annotation[] = [];
    for (const item of items) {
      const from = Math.min(item.from, item.to);
      const to = Math.max(item.from, item.to);
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
      status: 'anchored',
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
      schema: SCHEMA_VERSION,
      annotates: sourcePath,
      source_hash: contentHash(sourceText),
    };
    // User-configured fields, added to every annotation file as it's created
    // (both manual highlighting and import). Reserved keys can't be overridden.
    const reserved = new Set(['schema', 'annotates', 'source_hash']);
    for (const { key, value } of this.settings.sidecarFrontmatter ?? []) {
      const k = key.trim();
      if (k && !reserved.has(k)) fm[k] = value;
    }
    return fm;
  }

  /** Atomic read-modify-write of an existing sidecar (§9). */
  private async rmw(file: TFile, mutate: (s: Sidecar) => void): Promise<void> {
    await this.app.vault.process(file, (text) => {
      const sidecar = parseSidecar(text);
      mutate(sidecar);
      return serializeSidecar(sidecar);
    });
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
   * Write a source's sidecar, creating it if absent (§9). Resolves a flat-folder
   * basename collision via {@link onCollision}: when this source has no sidecar
   * yet and the canonical name is already owned by a *different* note, the user
   * chooses to share that file (`continue`), save to a disambiguated name
   * (`suffix`), or abort (`cancel`). Returns `false` only on cancel.
   */
  private async writeSidecar(
    sourceFile: TFile,
    sourceText: string,
    mutate: (s: Sidecar) => void,
  ): Promise<boolean> {
    const source = sourceFile.path;
    try {
      // A committed binding (own sidecar / prior choice) → write straight through.
      const bound = this.resolvedSidecar.get(source);
      const boundFile = bound ? this.fileAt(bound) : null;
      if (boundFile) {
        await this.rmw(boundFile, mutate);
        return true;
      }

      const canonical = this.sidecarPathFor(source);
      const canonicalFile = this.fileAt(canonical);

      // Alongside mode: the canonical name embeds the full source path → unique,
      // so it is always ours; never a collision.
      if (!this.folderMode()) {
        if (canonicalFile) await this.rmw(canonicalFile, mutate);
        else await this.createAt(canonical, source, sourceText, mutate);
        this.resolvedSidecar.set(source, canonical);
        return true;
      }

      // Folder mode. Our own canonical sidecar?
      if (canonicalFile && this.annotatesOf(canonicalFile) === source) {
        await this.rmw(canonicalFile, mutate);
        this.bind(source, canonicalFile);
        return true;
      }
      // Our own numbered sidecar from a past collision (found by probing annotates)?
      const { owned, firstFree } = this.probeSuffixed(source);
      if (owned) {
        await this.rmw(owned, mutate);
        this.bind(source, owned);
        return true;
      }
      // Canonical name taken by a different note → ask how to resolve the clash.
      if (canonicalFile) {
        const choice: CollisionChoice = this.onCollision
          ? await this.onCollision({
              sourcePath: source,
              existingSidecarPath: canonical,
              existingAnnotates: this.annotatesOf(canonicalFile),
            })
          : 'suffix';
        if (choice === 'cancel') return false;
        if (choice === 'suffix') {
          await this.createAt(firstFree, source, sourceText, mutate);
          this.resolvedSidecar.set(source, firstFree);
          return true;
        }
        // 'continue' → share the existing sidecar.
        await this.rmw(canonicalFile, mutate);
        this.bind(source, canonicalFile);
        return true;
      }

      // Canonical name is free → become its owner.
      await this.createAt(canonical, source, sourceText, mutate);
      this.resolvedSidecar.set(source, canonical);
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
    const sidecarFile = this.sidecarFileFor(sourcePath);
    if (!(sourceFile instanceof TFile) || !sidecarFile) return;
    try {
      await this.app.vault.process(sidecarFile, (text) => {
        const sidecar = parseSidecar(text);
        const a = sidecar.annotations.find((x) => x.id === id);
        if (a) fn(a, sidecar);
        return serializeSidecar(sidecar);
      });
    } catch (e) {
      new Notice(`Marginalia: failed to update sidecar — ${String(e)}`);
      throw e;
    }
    await this.load(sourceFile);
  }
}

// --- quote / context capture helpers ------------------------------------

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
