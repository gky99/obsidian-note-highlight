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
import { TFile, Notice, normalizePath, type App } from 'obsidian';

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

interface SourceEntry {
  sidecarPath: string;
  sidecar: Sidecar;
  resolved: ResolvedAnnotation[];
}

type ChangeListener = (sourcePath: string) => void;

export class AnnotationStore {
  private entries = new Map<string, SourceEntry>();
  private listeners = new Set<ChangeListener>();

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

  /** Vault path of the sidecar that would annotate `sourcePath`. */
  sidecarPathFor(sourcePath: string): string {
    return normalizePath(
      sidecarPathForSource(sourcePath, this.settings.sidecarSuffix, this.settings.sidecarFolder),
    );
  }

  private sidecarFileFor(sourcePath: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(this.sidecarPathFor(sourcePath));
    return f instanceof TFile ? f : null;
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
    const n = this.settings.contextChars;
    const pinId = findEnclosingBlockId(cache, from);
    const headingPath = findEnclosingHeadingPath(cache, from);

    const record: AnnoRecord = {
      id: this.freshId(sourceFile.path),
      ...(pinId ? { pin: `^${pinId}` } : {}),
      ...(headingPath ? { heading: headingPath } : {}),
      before: contextBefore(sourceText, from, n),
      after: contextAfter(sourceText, to, n),
      qhash: quoteHash(quote),
      status: 'anchored',
      color: color ?? this.settings.defaultColor,
      created: new Date().toISOString(),
    };
    const annotation: Annotation = { id: record.id, quote, record, comment: '' };

    await this.writeSidecar(sourceFile, sourceText, (s) => {
      s.annotations.push(annotation);
    });
    await this.load(sourceFile);
    return annotation;
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
    return {
      schema: SCHEMA_VERSION,
      annotates: sourcePath,
      source_hash: contentHash(sourceText),
    };
  }

  /** Atomic read-modify-write of a sidecar, creating it if absent (§9). */
  private async writeSidecar(
    sourceFile: TFile,
    sourceText: string,
    mutate: (s: Sidecar) => void,
  ): Promise<void> {
    const existing = this.sidecarFileFor(sourceFile.path);
    try {
      if (existing) {
        await this.app.vault.process(existing, (text) => {
          const sidecar = parseSidecar(text);
          mutate(sidecar);
          return serializeSidecar(sidecar);
        });
      } else {
        const sidecar: Sidecar = {
          frontmatter: this.newFrontmatter(sourceFile.path, sourceText),
          annotations: [],
        };
        mutate(sidecar);
        const sidecarPath = this.sidecarPathFor(sourceFile.path);
        await this.ensureParentFolder(sidecarPath);
        await this.app.vault.create(sidecarPath, serializeSidecar(sidecar));
      }
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
