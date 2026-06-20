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
}

/** One clip's row in the dry-run report. */
export interface DryRunEntry {
  name: string;
  create: number;
  skipped: number;
  unmatched: number;
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

  constructor(
    app: App,
    private readonly opts: ImportPreviewOptions,
  ) {
    super(app);
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
      return;
    }
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

  // --- all-clips dry-run layout ------------------------------------------

  private renderAll(body: HTMLElement, a: AllPreview): void {
    const total = this.opts.totalCreate;
    const stats = body.createDiv({ cls: 'mrg-import-stats' });
    stat(stats, total, total === 1 ? 'highlight' : 'highlights', 'is-create');
    stat(stats, a.noteCount, a.noteCount === 1 ? 'note' : 'notes');
    const nothing = a.entries.filter((e) => e.create === 0).length;
    if (nothing) stat(stats, nothing, 'nothing new');

    const withNew = a.entries.filter((e) => e.create > 0);
    if (withNew.length === 0) {
      body.createDiv({ cls: 'mrg-import-empty', text: 'Nothing new to import.' });
      return;
    }
    const list = body.createDiv({ cls: 'mrg-import-entries' });
    for (const e of withNew) {
      const row = list.createDiv({ cls: 'mrg-entry' });
      setIcon(row.createDiv({ cls: 'mrg-entry-icon' }), 'file-plus');
      row.createDiv({ cls: 'mrg-entry-name', text: e.name });
      const chips = row.createDiv({ cls: 'mrg-entry-chips' });
      chip(chips, `${e.create} highlight${e.create === 1 ? '' : 's'}`);
      if (e.unmatched) chip(chips, `${e.unmatched} not located`, 'is-warn');
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
    let importButton: ButtonComponent | undefined;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => {
        importButton = b;
        b.setButtonText(total > 0 ? `Import ${total} highlight${total === 1 ? '' : 's'}` : 'Import')
          .setCta()
          .setDisabled(total === 0)
          .onClick(async () => {
            this.close();
            await this.opts.onConfirm();
          });
        return b;
      });
    // Make Import the popup default: focus it so Enter confirms (not cancel).
    if (total > 0) importButton?.buttonEl.focus();
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
