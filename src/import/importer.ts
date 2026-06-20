/**
 * Web Highlights importer (Obsidian runtime).
 *
 * Reads the newest Web Highlights JSON export from a configured folder and turns
 * the marks made on a clip's page into Marginalia sidecar annotations. A *clip*
 * is any note whose frontmatter records the page's source URL (`source` / `url`
 * / …); the importer matches marks to it by URL and re-anchors each mark's text
 * into the note via {@link planImport}.
 *
 * Import is **preview-first**: a command plans what would be created without
 * writing, shows an {@link ImportPreviewModal}, and only on confirm writes the
 * batch through the store. There is no write-immediately path.
 *
 * Non-destructive: the clip is never modified (its highlights live in the
 * sidecar), and re-running is idempotent — already-imported marks overlap the
 * highlights they created and are skipped (§4.4).
 *
 * This is the only import module that touches `obsidian`; the parsing, matching,
 * and planning it calls are pure (see `./web-highlights`, `./plan`).
 */
import { Notice, TFile, normalizePath, type App } from 'obsidian';

import type { MarginaliaSettings } from '@/settings';
import type { AnnotationStore } from '@/store/store';
import { isSidecarPath } from '@/obsidian/sidecar-path';

import { planImport } from './plan';
import { ImportPreviewModal } from './preview-modal';
import {
  colorsInExport,
  marksForUrl,
  normalizeUrl,
  parseExport,
  urlFromMeta,
  urlsWithMarks,
  type WebHighlightsExport,
} from './web-highlights';

/** One located highlight in a plan: its source range, displayed quote, and presentation. */
interface PlannedHighlightView {
  from: number;
  to: number;
  /** The highlight's text, for the preview body. */
  quote: string;
  comment: string;
  color: string;
}

/** A clip's planned import, computed without writing — the unit the preview shows. */
interface ClipPlan {
  clip: TFile;
  /** Highlights to create (located range + quote + presentation). */
  highlights: PlannedHighlightView[];
  /** Marks dropped because their passage is already highlighted. */
  skipped: number;
  /** Marks whose text could not be located in the clip. */
  unmatched: number;
  /** Total marks the export had for this clip's URL. */
  total: number;
}

export class WebHighlightsImporter {
  constructor(
    private readonly app: App,
    private readonly store: AnnotationStore,
    private readonly settings: MarginaliaSettings,
  ) {}

  /** Preview, then (on confirm) import into the active note. */
  async importCurrent(): Promise<void> {
    const clip = this.app.workspace.getActiveFile();
    if (!clip || clip.extension !== 'md' || isSidecarPath(clip.path, this.settings.sidecarSuffix)) {
      new Notice('Marginalia: open a clip note to import its highlights.');
      return;
    }
    const data = await this.loadExport();
    if (!data) return;

    if (!urlFromMeta(this.app.metadataCache.getFileCache(clip)?.frontmatter)) {
      new Notice('Marginalia: this note has no source URL in its frontmatter.');
      return;
    }
    const plan = await this.planClip(clip, data);
    if (plan.total === 0) {
      new Notice(`Marginalia: no highlights in the export for ${clip.basename}.`);
      return;
    }
    this.openSinglePreview(plan);
  }

  /** Preview, then (on confirm) import into every matching clip in the clips folder. */
  async importAll(): Promise<void> {
    const data = await this.loadExport();
    if (!data) return;
    const withMarks = urlsWithMarks(data);

    const clips = this.app.vault.getMarkdownFiles().filter((f) => {
      if (isSidecarPath(f.path, this.settings.sidecarSuffix)) return false;
      if (!this.inFolder(f.path, this.settings.clipsFolder)) return false;
      const url = urlFromMeta(this.app.metadataCache.getFileCache(f)?.frontmatter);
      return url != null && withMarks.has(normalizeUrl(url));
    });

    if (clips.length === 0) {
      new Notice('Marginalia: no clips in the export match notes in this vault.');
      return;
    }

    const plans: ClipPlan[] = [];
    for (const clip of clips) plans.push(await this.planClip(clip, data));
    this.openAllPreview(plans);
  }

  // --- planning (no writes) ----------------------------------------------

  /** Locate a clip's marks and decide what to create — without touching disk. */
  private async planClip(clip: TFile, data: WebHighlightsExport): Promise<ClipPlan> {
    const url = urlFromMeta(this.app.metadataCache.getFileCache(clip)?.frontmatter);
    const marks = url ? marksForUrl(data, url) : [];
    if (marks.length === 0) return { clip, highlights: [], skipped: 0, unmatched: 0, total: 0 };

    const sourceText = await this.app.vault.cachedRead(clip);
    // Load so the plan can de-overlap against existing highlights (and so the apply
    // step can seed fresh ids from what's already there).
    await this.store.load(clip);
    const existing = this.store
      .getResolved(clip.path)
      .flatMap((r) => (r.result.status === 'anchored' ? [r.result.range] : []));

    const plan = planImport(sourceText, marks, existing, {
      defaultColor: this.settings.defaultColor,
    });
    return {
      clip,
      highlights: plan.planned.map((p) => ({
        from: p.range.from,
        to: p.range.to,
        quote: (p.mark.text ?? '').replace(/\s+/g, ' ').trim(),
        comment: p.comment,
        color: p.color,
      })),
      skipped: plan.skipped,
      unmatched: plan.unmatched.length,
      total: marks.length,
    };
  }

  // --- preview + apply ----------------------------------------------------

  /** Rich single-clip preview: meta + the clip's frontmatter + each quote/comment. */
  private openSinglePreview(plan: ClipPlan): void {
    new ImportPreviewModal(this.app, {
      title: `Import — ${plan.clip.basename}`,
      totalCreate: plan.highlights.length,
      onConfirm: () => this.apply([plan]),
      single: {
        sidecarPath: this.store.sidecarPathFor(plan.clip.path),
        sourcePath: plan.clip.path,
        frontmatter: this.app.metadataCache.getFileCache(plan.clip)?.frontmatter ?? null,
        skipped: plan.skipped,
        unmatched: plan.unmatched,
        highlights: plan.highlights.map((h) => ({
          quote: h.quote,
          comment: h.comment,
          color: h.color,
        })),
      },
    }).open();
  }

  /** Dry-run report across every matching clip. */
  private openAllPreview(plans: ClipPlan[]): void {
    const totalCreate = plans.reduce((n, p) => n + p.highlights.length, 0);
    new ImportPreviewModal(this.app, {
      title: 'Import Web Highlights — preview',
      totalCreate,
      onConfirm: () => this.apply(plans),
      all: {
        entries: plans.map((p) => ({
          name: p.clip.basename,
          create: p.highlights.length,
          skipped: p.skipped,
          unmatched: p.unmatched,
        })),
        noteCount: plans.filter((p) => p.highlights.length > 0).length,
      },
    }).open();
  }

  /** Write the planned highlights for each clip (one batched sidecar write each). */
  private async apply(plans: ClipPlan[]): Promise<void> {
    let created = 0;
    let notes = 0;
    for (const p of plans) {
      if (p.highlights.length === 0) continue;
      const made = await this.store.createHighlights(
        p.clip,
        p.highlights.map((h) => ({ from: h.from, to: h.to, color: h.color, comment: h.comment })),
      );
      created += made.length;
      if (made.length > 0) notes++;
    }
    new Notice(
      `Marginalia: imported ${created} highlight${created === 1 ? '' : 's'} into ${notes} note${
        notes === 1 ? '' : 's'
      }.`,
    );
  }

  /** Distinct colors in the newest export, most-used first — for palette autocomplete. */
  async exportColors(): Promise<string[]> {
    const file = this.latestExportFile();
    if (!file) return [];
    try {
      return colorsInExport(parseExport(await this.app.vault.cachedRead(file)));
    } catch {
      return [];
    }
  }

  // --- export file selection ---------------------------------------------

  /** Read + parse the newest export, surfacing failures as a Notice. */
  private async loadExport(): Promise<WebHighlightsExport | null> {
    const file = this.latestExportFile();
    if (!file) {
      new Notice(
        this.settings.webHighlightsFolder
          ? `Marginalia: no .json export found in "${this.settings.webHighlightsFolder}".`
          : 'Marginalia: set a Web Highlights folder in settings first.',
      );
      return null;
    }
    try {
      return parseExport(await this.app.vault.read(file));
    } catch (e) {
      new Notice(`Marginalia: could not read ${file.name}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Newest export in the configured folder — the name sorting last (timestamped). */
  private latestExportFile(): TFile | null {
    const folder = this.settings.webHighlightsFolder;
    if (!folder) return null;
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.extension === 'json' && this.inFolder(f.path, folder));
    if (files.length === 0) return null;
    files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.stat.mtime - a.stat.mtime));
    return files[0]!;
  }

  /** Is `path` inside `folder` (empty folder = the whole vault)? */
  private inFolder(path: string, folder: string): boolean {
    if (!folder) return true;
    const f = normalizePath(folder).replace(/\/$/, '');
    return path === f || path.startsWith(`${f}/`);
  }
}
