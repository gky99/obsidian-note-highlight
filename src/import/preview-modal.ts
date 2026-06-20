/**
 * Dry-run preview for a Web Highlights import (Obsidian runtime).
 *
 * Import is preview-first: a command computes what *would* be created (no writes)
 * and opens this modal, which writes the batch only on confirm. Two layouts:
 *
 *  - **single** (one clip) — a meta bar (target sidecar + counts), the clip's
 *    frontmatter as a read-only Properties-style table, then each highlight's
 *    quote (colored) and rendered comment. No heading structure: a sidecar stores
 *    highlights + comments, not a reconstructed note outline.
 *  - **all** (every matching clip) — stat cards (highlights / notes), then a
 *    per-clip entry list with counts.
 *
 * There is no write-immediately path; the confirm button is the popup default.
 */
import {
  App,
  Component,
  MarkdownRenderer,
  Modal,
  Setting,
  setIcon,
  type ButtonComponent,
} from 'obsidian';

import { renderColor } from '@/color';

/** One highlight in the single-clip body: its quote, comment, and color. */
export interface PreviewHighlight {
  quote: string;
  comment: string;
  color: string;
}

/** Single-clip preview payload. */
export interface SinglePreview {
  /** Vault path the annotations will be written to. */
  sidecarPath: string;
  /** Source note path (resolves links while rendering comments). */
  sourcePath: string;
  /** The clip's frontmatter, rendered as a Properties table (or null). */
  frontmatter: Record<string, unknown> | null;
  skipped: number;
  unmatched: number;
  highlights: PreviewHighlight[];
  /** Highlights whose text could not be located in the note (won't be imported). */
  missing: PreviewHighlight[];
}

/** One clip's row in the dry-run report. */
export interface DryRunEntry {
  name: string;
  create: number;
  skipped: number;
  /** Highlights whose text could not be located in the clip (won't be imported). */
  missing: PreviewHighlight[];
}

/** All-clips dry-run payload. */
export interface AllPreview {
  entries: DryRunEntry[];
  /** Clips that will gain at least one highlight. */
  noteCount: number;
}

export interface ImportPreviewOptions {
  title: string;
  /** Total highlights that would be created across the preview. */
  totalCreate: number;
  /** Apply the import (called only when the user confirms). */
  onConfirm: () => void | Promise<void>;
  single?: SinglePreview;
  all?: AllPreview;
}

export class ImportPreviewModal extends Modal {
  private readonly component = new Component();
  private importButton?: ButtonComponent;

  constructor(
    app: App,
    private readonly opts: ImportPreviewOptions,
  ) {
    super(app);
  }

  /**
   * Make Import the focused (default) action. Obsidian's `Modal.open()` autofocuses
   * the first focusable element — here the Cancel button — *after* `onOpen()` returns
   * (the `tg(modalEl)` call in its source), which would clobber a focus set during
   * `onOpen`. Running `super.open()` first lets that autofocus happen, then we claim
   * focus for Import. open() is fully synchronous, so this is deterministic — no timer.
   */
  open(): void {
    super.open();
    if (this.opts.totalCreate > 0) this.importButton?.buttonEl.focus();
  }

  onOpen(): void {
    this.component.load();
    this.modalEl.addClass('mrg-import-modal');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.opts.title, cls: 'mrg-import-title' });

    const body = contentEl.createDiv({ cls: 'mrg-import-body' });
    if (this.opts.single) this.renderSingle(body, this.opts.single);
    else if (this.opts.all) this.renderAll(body, this.opts.all);

    this.renderButtons(contentEl);
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  // --- single-clip layout -------------------------------------------------

  private renderSingle(body: HTMLElement, s: SinglePreview): void {
    const meta = body.createDiv({ cls: 'mrg-import-meta' });
    meta.createDiv({ cls: 'mrg-import-meta-line is-primary', text: `Annotations → ${s.sidecarPath}` });
    meta.createDiv({
      cls: 'mrg-import-meta-line',
      text: countsLine(this.opts.totalCreate, s.skipped, s.unmatched),
    });

    if (s.frontmatter && Object.keys(s.frontmatter).length > 0) {
      renderProperties(body, s.frontmatter);
    }

    body.createEl('h4', { cls: 'mrg-import-section', text: 'Highlights' });
    if (s.highlights.length === 0) {
      body.createDiv({ cls: 'mrg-import-empty', text: 'No new highlights to import.' });
    } else {
      const list = body.createDiv({ cls: 'mrg-import-hls' });
      for (const h of s.highlights) {
        const item = list.createDiv({ cls: 'mrg-import-hl' });
        const quote = item.createDiv({ cls: 'mrg-import-quote' });
        quote.style.borderLeftColor = renderColor(h.color).solid;
        quote.setText(h.quote);
        if (h.comment.trim().length > 0) {
          const comment = item.createDiv({ cls: 'mrg-import-comment' });
          void MarkdownRenderer.render(this.app, h.comment, comment, s.sourcePath, this.component);
        }
      }
    }

    if (s.missing.length > 0) {
      body.createEl('h4', { cls: 'mrg-import-section', text: `Not located (${s.missing.length})` });
      body.createDiv({
        cls: 'mrg-import-missing-note',
        text: 'These highlights could not be found in the note and won’t be imported.',
      });
      const list = body.createDiv({ cls: 'mrg-import-hls' });
      for (const h of s.missing) this.renderMissing(list, h);
    }
  }

  // --- all-clips dry-run layout ------------------------------------------

  private renderAll(body: HTMLElement, a: AllPreview): void {
    const total = this.opts.totalCreate;
    const missingTotal = a.entries.reduce((n, e) => n + e.missing.length, 0);
    const stats = body.createDiv({ cls: 'mrg-import-stats' });
    stat(stats, total, total === 1 ? 'highlight' : 'highlights', 'is-create');
    stat(stats, a.noteCount, a.noteCount === 1 ? 'note' : 'notes');
    if (missingTotal) stat(stats, missingTotal, 'not located', 'is-warn');
    const nothing = a.entries.filter((e) => e.create === 0 && e.missing.length === 0).length;
    if (nothing) stat(stats, nothing, 'nothing new');

    // Show any clip that gains highlights OR has ones we couldn't locate — the
    // latter is why this list matters across many clips: it surfaces silent misses.
    const shown = a.entries.filter((e) => e.create > 0 || e.missing.length > 0);
    if (shown.length === 0) {
      body.createDiv({ cls: 'mrg-import-empty', text: 'Nothing new to import.' });
      return;
    }
    const list = body.createDiv({ cls: 'mrg-import-entries' });
    for (const e of shown) {
      const row = list.createDiv({ cls: 'mrg-entry' });
      if (e.create === 0) row.addClass('is-missing-only');
      const head = row.createDiv({ cls: 'mrg-entry-head' });
      setIcon(head.createDiv({ cls: 'mrg-entry-icon' }), e.create > 0 ? 'file-plus' : 'file-warning');
      head.createDiv({ cls: 'mrg-entry-name', text: e.name });
      const chips = head.createDiv({ cls: 'mrg-entry-chips' });
      if (e.create > 0) chip(chips, `${e.create} highlight${e.create === 1 ? '' : 's'}`);
      if (e.missing.length) chip(chips, `${e.missing.length} not located`, 'is-warn');
      if (e.missing.length > 0) {
        const missing = row.createDiv({ cls: 'mrg-entry-missing mrg-import-hls' });
        for (const h of e.missing) this.renderMissing(missing, h);
      }
    }
    if (nothing) {
      body.createDiv({
        cls: 'mrg-import-footnote',
        text: `${nothing} clip(s) already have these highlights or nothing new to import.`,
      });
    }
  }

  // --- buttons ------------------------------------------------------------

  private renderButtons(contentEl: HTMLElement): void {
    const total = this.opts.totalCreate;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => {
        this.importButton = b;
        b.setButtonText(total > 0 ? `Import ${total} highlight${total === 1 ? '' : 's'}` : 'Import')
          .setCta()
          .setDisabled(total === 0)
          .onClick(async () => {
            this.close();
            await this.opts.onConfirm();
          });
        return b;
      });
    // Import is focused after open() finishes — see the open() override.
  }

  /** A could-not-be-located highlight: its quote, muted, flagged out-of-line, never imported. */
  private renderMissing(list: HTMLElement, h: PreviewHighlight): void {
    const item = list.createDiv({ cls: 'mrg-import-hl is-missing' });
    setIcon(item.createDiv({ cls: 'mrg-import-missing-icon' }), 'alert-triangle');
    const quote = item.createDiv({ cls: 'mrg-import-quote' });
    quote.style.borderLeftColor = renderColor(h.color).solid;
    quote.setText(h.quote);
  }
}

// --- helpers --------------------------------------------------------------

function countsLine(create: number, skipped: number, unmatched: number): string {
  const parts = [`${create} highlight${create === 1 ? '' : 's'}`];
  if (skipped) parts.push(`${skipped} already highlighted`);
  if (unmatched) parts.push(`${unmatched} not located`);
  return parts.join(' · ');
}

/** Read-only Properties-style table of a note's frontmatter. */
function renderProperties(el: HTMLElement, fm: Record<string, unknown>): void {
  const table = el.createDiv({ cls: 'mrg-props' });
  for (const key of Object.keys(fm)) {
    const row = table.createDiv({ cls: 'mrg-prop' });
    row.createDiv({ cls: 'mrg-prop-key', text: key });
    renderPropValue(row.createDiv({ cls: 'mrg-prop-value' }), fm[key]);
  }
}

function renderPropValue(el: HTMLElement, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      el.createSpan({ cls: 'mrg-prop-empty', text: '—' });
      return;
    }
    const chips = el.createDiv({ cls: 'mrg-chips' });
    for (const item of value) chips.createSpan({ cls: 'mrg-chip', text: scalarText(item) });
    return;
  }
  el.setText(scalarText(value));
}

/** A scalar frontmatter value as display text — `[[link]]`/`[t](url)` reduced to their text. */
function scalarText(value: unknown): string {
  if (value == null || value === '') return '—';
  const s = String(value);
  const wiki = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(s);
  if (wiki) return (wiki[2] ?? wiki[1]).trim();
  const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(s);
  if (link) return link[1].trim();
  return s;
}

function stat(parent: HTMLElement, value: number, label: string, cls = ''): void {
  const box = parent.createDiv({ cls: `mrg-stat ${cls}`.trim() });
  box.createDiv({ cls: 'mrg-stat-value', text: String(value) });
  box.createDiv({ cls: 'mrg-stat-label', text: label });
}

function chip(parent: HTMLElement, text: string, cls = ''): void {
  parent.createSpan({ cls: `mrg-chip ${cls}`.trim(), text });
}
