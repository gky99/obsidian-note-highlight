/**
 * The Marginalia settings tab (Design.md §12). Exposes the tunables that the
 * store and resolver read: sidecar naming and save location, the highlight
 * color palette (built-in tokens + custom hex) and default color, the fuzzy
 * re-anchor threshold and captured context length, plus two UI toggles.
 *
 * Each control mutates `plugin.settings` in place and persists via
 * `plugin.saveSettings()`. The host (the plugin) owns persistence; this tab only
 * renders and wires the controls.
 */
import { PluginSettingTab, Setting, Notice, setIcon, type App, type Plugin } from 'obsidian';

import { colorLabel, renderColor, isBuiltinColor, parseHex } from '@/color';
import { BUILTIN_COLORS } from '@/settings';
import { ColorSuggest, FolderSuggest } from './suggest';

/** Minimal contract the settings tab needs from the owning plugin. */
export interface SettingsHost {
  settings: import('@/settings').MarginaliaSettings;
  saveSettings(): Promise<void>;
  /** Distinct colors found in the newest Web Highlights export, most-used first. */
  exportColors(): Promise<string[]>;
}

/** A reasonable starting color for a freshly added custom palette entry. */
const NEW_CUSTOM_COLOR = '#ff5577';

export class MarginaliaSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  /** Colors in the newest export, loaded async for palette autocomplete. */
  private exportColorOptions: string[] = [];
  /** Source row index while a palette row is being drag-reordered. */
  private dragFrom: number | null = null;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;
    void this.loadExportColors(); // populates palette autocomplete once it resolves

    new Setting(containerEl)
      .setName('Sidecar suffix')
      .setDesc('Inserted before ".md" to name a note\'s sidecar, e.g. ".annotations".')
      .addText((text) =>
        text
          .setPlaceholder('.annotations')
          .setValue(s.sidecarSuffix)
          .onChange(async (value) => {
            s.sidecarSuffix = value;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sidecar folder')
      .setDesc(
        'Exact vault folder to store annotation sidecars in (named by each note\'s ' +
          'file name, not its path). Leave empty to keep a sidecar next to its source note.',
      )
      .addText((text) => {
        text
          .setPlaceholder('e.g. _annotations')
          .setValue(s.sidecarFolder)
          .onChange(async (value) => {
            s.sidecarFolder = value.trim();
            await this.host.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl);
      });

    this.renderFrontmatterSection(containerEl);

    new Setting(containerEl)
      .setName('Default color')
      .setDesc('Color applied to a freshly created highlight.')
      .addDropdown((drop) => {
        for (const color of s.palette) drop.addOption(color, colorLabel(color));
        const value = s.palette.includes(s.defaultColor) ? s.defaultColor : s.palette[0] ?? 'yellow';
        drop.setValue(value).onChange(async (next) => {
          s.defaultColor = next;
          await this.host.saveSettings();
        });
      });

    this.renderPalette(containerEl);

    new Setting(containerEl)
      .setName('Fuzzy threshold')
      .setDesc('Minimum similarity (0–1) to accept a fuzzy re-anchor before orphaning.')
      .addSlider((slider) =>
        slider
          .setLimits(0.3, 0.95, 0.05)
          .setValue(s.fuzzyThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.fuzzyThreshold = value;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Context characters')
      .setDesc('Characters of before/after context captured when creating a highlight.')
      .addSlider((slider) =>
        slider
          .setLimits(10, 80, 1)
          .setValue(s.contextChars)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.contextChars = value;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Reveal annotation block on cursor')
      .setDesc('Reveal the raw "anno" block when the cursor enters it in Live Preview.')
      .addToggle((toggle) =>
        toggle.setValue(s.revealAnnoOnCursor).onChange(async (value) => {
          s.revealAnnoOnCursor = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-open aside panel')
      .setDesc('Open the aside panel automatically when a note with annotations is opened.')
      .addToggle((toggle) =>
        toggle.setValue(s.autoOpenAside).onChange(async (value) => {
          s.autoOpenAside = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Confirm before deleting')
      .setDesc('Ask for confirmation before deleting an annotation (aside panel and toolbar).')
      .addToggle((toggle) =>
        toggle.setValue(s.confirmDelete).onChange(async (value) => {
          s.confirmDelete = value;
          await this.host.saveSettings();
        }),
      );

    this.renderImportSection(containerEl);
  }

  /** Web Highlights import: where exports live and which notes count as clips. */
  private renderImportSection(containerEl: HTMLElement): void {
    const s = this.host.settings;

    new Setting(containerEl).setName('Web Highlights import').setHeading();

    new Setting(containerEl)
      .setName('Web Highlights folder')
      .setDesc('Vault folder holding the Web Highlights JSON export(s). The newest by name is imported.')
      .addText((text) => {
        text
          .setPlaceholder('e.g. _highlights')
          .setValue(s.webHighlightsFolder)
          .onChange(async (value) => {
            s.webHighlightsFolder = value.trim();
            await this.host.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl);
      });

    new Setting(containerEl)
      .setName('Clips folder')
      .setDesc('Folder scanned by "Import into all clips". Leave empty to scan the whole vault.')
      .addText((text) => {
        text
          .setPlaceholder('e.g. Clips')
          .setValue(s.clipsFolder)
          .onChange(async (value) => {
            s.clipsFolder = value.trim();
            await this.host.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl);
      });
  }

  /**
   * Editable Key/Value table whose pairs are written into the frontmatter of every
   * newly created annotation file (manual highlight or import). The header only
   * appears once there is a row, so an empty list stays uncluttered.
   */
  private renderFrontmatterSection(containerEl: HTMLElement): void {
    const fields = this.host.settings.sidecarFrontmatter;

    new Setting(containerEl).setName('Annotation file frontmatter').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Key/value pairs added to every new annotation file’s frontmatter (when you first ' +
        'highlight a note or import its highlights). annotation_schema, annotates, and source_hash are always set.',
    });

    const grid = containerEl.createDiv({ cls: 'mrg-kv-table' });
    if (fields.length > 0) {
      grid.createDiv({ cls: 'mrg-kv-label', text: 'Key' });
      grid.createDiv({ cls: 'mrg-kv-label', text: 'Value' });
      grid.createDiv(); // spacer above the delete column
    }

    fields.forEach((field, i) => {
      const key = grid.createEl('input', {
        type: 'text',
        cls: 'mrg-kv-key',
        value: field.key,
        attr: { placeholder: 'key', spellcheck: 'false' },
      });
      key.addEventListener('input', async () => {
        field.key = key.value.trim();
        await this.host.saveSettings();
      });

      const value = grid.createEl('input', {
        type: 'text',
        cls: 'mrg-kv-value',
        value: field.value,
        attr: { placeholder: 'value' },
      });
      value.addEventListener('input', async () => {
        field.value = value.value;
        await this.host.saveSettings();
      });

      const del = grid.createEl('button', {
        cls: 'clickable-icon mrg-row-delete',
        attr: { 'aria-label': 'Delete field' },
      });
      setIcon(del, 'trash-2');
      del.addEventListener('click', async () => {
        fields.splice(i, 1);
        await this.host.saveSettings();
        this.display();
      });
    });

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('Add field')
        .setCta()
        .onClick(async () => {
          fields.push({ key: '', value: '' });
          await this.host.saveSettings();
          this.display();
        }),
    );
  }

  /**
   * The color-palette manager as a swatch table: one draggable row per color,
   * each a token/`#hex` text input with a live swatch (hatched = unset/unrecognized)
   * and a delete control, plus an "Add" button. Reordering rows reorders the
   * palette — i.e. the order colors appear in the toolbar and card popup.
   * Autocomplete offers the built-in tokens plus the colors in the newest export.
   */
  private renderPalette(containerEl: HTMLElement): void {
    const s = this.host.settings;

    new Setting(containerEl)
      .setName('Color palette')
      .setDesc(
        'Colors offered in the selection toolbar and card popup, in this order — a built-in ' +
          'token (yellow…orange) or a #hex. Drag the handle to reorder.',
      )
      .setHeading();

    const table = containerEl.createDiv({ cls: 'mrg-color-table' });
    s.palette.forEach((color, i) => this.renderPaletteRow(table, i, color));

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('Add color')
        .setCta()
        .onClick(async () => {
          s.palette.push(NEW_CUSTOM_COLOR);
          await this.host.saveSettings();
          this.display();
        }),
    );
  }

  /** One palette row: drag handle · live swatch · token/hex input · delete. */
  private renderPaletteRow(table: HTMLElement, i: number, color: string): void {
    const s = this.host.settings;
    const row = table.createDiv({ cls: 'mrg-color-row' });
    this.makeReorderable(row, i);

    const handle = row.createDiv({ cls: 'mrg-drag-handle', attr: { 'aria-label': 'Drag to reorder' } });
    setIcon(handle, 'grip-vertical');
    handle.draggable = true;
    handle.addEventListener('dragstart', (e) => {
      this.dragFrom = i;
      e.dataTransfer?.setData('text/plain', String(i)); // some browsers require data to be set
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.addClass('mrg-dragging');
    });
    handle.addEventListener('dragend', () => {
      this.dragFrom = null;
      row.removeClass('mrg-dragging');
      table.findAll('.mrg-drop-target').forEach((el) => el.removeClass('mrg-drop-target'));
    });

    const swatch = row.createSpan({ cls: 'mrg-color-swatch' });
    const paint = (v: string): void => {
      const usable = isUsableColor(v);
      swatch.toggleClass('is-empty', !usable);
      swatch.style.backgroundColor = usable ? renderColor(v).solid : '';
    };
    paint(color);

    const input = row.createEl('input', {
      type: 'text',
      cls: 'mrg-color-input',
      value: color,
      attr: { placeholder: 'yellow or #rrggbb', spellcheck: 'false' },
    });
    input.addEventListener('input', async () => {
      const v = input.value.trim();
      if (s.defaultColor === s.palette[i]) s.defaultColor = v;
      s.palette[i] = v;
      paint(v);
      await this.host.saveSettings();
    });
    // Built-in tokens first, then the colors found in the newest export.
    new ColorSuggest(this.app, input, () => [...BUILTIN_COLORS, ...this.exportColorOptions]);

    const del = row.createEl('button', {
      cls: 'clickable-icon mrg-row-delete',
      attr: { 'aria-label': 'Remove color' },
    });
    setIcon(del, 'trash-2');
    del.addEventListener('click', async () => {
      if (s.palette.length <= 1) {
        new Notice('Marginalia: keep at least one palette color.');
        return;
      }
      const [removed] = s.palette.splice(i, 1);
      if (s.defaultColor === removed) s.defaultColor = s.palette[0];
      await this.host.saveSettings();
      this.display();
    });
  }

  /** Wire `row` as a drop target that moves the dragged palette entry before it. */
  private makeReorderable(row: HTMLElement, to: number): void {
    const s = this.host.settings;
    row.addEventListener('dragover', (e) => {
      if (this.dragFrom === null || this.dragFrom === to) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      row.addClass('mrg-drop-target');
    });
    row.addEventListener('dragleave', () => row.removeClass('mrg-drop-target'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.removeClass('mrg-drop-target');
      const from = this.dragFrom;
      this.dragFrom = null;
      if (from === null || from === to) return;
      const [moved] = s.palette.splice(from, 1);
      // Adjust for the removal so the entry lands just before the drop row,
      // consistently in both drag directions.
      s.palette.splice(from < to ? to - 1 : to, 0, moved);
      await this.host.saveSettings();
      this.display();
    });
  }

  private async loadExportColors(): Promise<void> {
    this.exportColorOptions = await this.host.exportColors();
  }
}

/** A palette value is usable when it's a built-in token or a parseable hex. */
function isUsableColor(value: string): boolean {
  return isBuiltinColor(value) || parseHex(value) != null;
}
