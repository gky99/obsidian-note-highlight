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
import { PluginSettingTab, Setting, Notice, type App, type Plugin } from 'obsidian';

import { colorLabel, renderColor, isBuiltinColor, parseHex } from '@/color';

/** Minimal contract the settings tab needs from the owning plugin. */
export interface SettingsHost {
  settings: import('@/settings').MarginaliaSettings;
  saveSettings(): Promise<void>;
}

/** A reasonable starting color for a freshly added custom palette entry. */
const NEW_CUSTOM_COLOR = '#ff5577';

export class MarginaliaSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, plugin: Plugin & SettingsHost) {
    super(app, plugin);
    this.host = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;

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
      .addText((text) =>
        text
          .setPlaceholder('e.g. _annotations')
          .setValue(s.sidecarFolder)
          .onChange(async (value) => {
            s.sidecarFolder = value.trim();
            await this.host.saveSettings();
          }),
      );

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
  }

  /** The color-palette manager: one row per color, plus an add button. */
  private renderPalette(containerEl: HTMLElement): void {
    const s = this.host.settings;

    new Setting(containerEl)
      .setName('Color palette')
      .setDesc('Colors offered in the selection toolbar and the card dropdown.')
      .setHeading();

    s.palette.forEach((color, i) => {
      const row = new Setting(containerEl).setName(colorLabel(color));
      const swatch = row.nameEl.createSpan({ cls: 'mrg-settings-swatch' });
      swatch.style.backgroundColor = renderColor(color).solid;

      // Built-ins are theme tokens (no hex to tune); only custom colors get a picker.
      if (!isBuiltinColor(color)) {
        row.addColorPicker((picker) =>
          picker.setValue(parseHex(color) ?? NEW_CUSTOM_COLOR).onChange(async (value) => {
            if (s.defaultColor === s.palette[i]) s.defaultColor = value;
            s.palette[i] = value;
            swatch.style.backgroundColor = value;
            row.setName(colorLabel(value));
            row.nameEl.appendChild(swatch); // setName clears nameEl; re-attach the swatch
            await this.host.saveSettings();
          }),
        );
      }

      row.addExtraButton((btn) =>
        btn
          .setIcon('trash')
          .setTooltip('Remove color')
          .onClick(async () => {
            if (s.palette.length <= 1) {
              new Notice('Marginalia: keep at least one palette color.');
              return;
            }
            const [removed] = s.palette.splice(i, 1);
            if (s.defaultColor === removed) s.defaultColor = s.palette[0];
            await this.host.saveSettings();
            this.display();
          }),
      );
    });

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('Add custom color')
        .setCta()
        .onClick(async () => {
          s.palette.push(NEW_CUSTOM_COLOR);
          await this.host.saveSettings();
          this.display();
        }),
    );
  }
}
