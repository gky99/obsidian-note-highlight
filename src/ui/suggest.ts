/**
 * Native input autocompletes for the settings tab (Obsidian runtime).
 *
 * Both extend Obsidian's own {@link AbstractInputSuggest} so the dropdown looks
 * and behaves exactly like the app's built-in suggesters:
 *  - {@link FolderSuggest} — substring-matches vault folders so a path field is
 *    picked, not hand-typed (the vault root is labeled clearly).
 *  - {@link ColorSuggest} — suggests known colors (built-in tokens) for a palette
 *    field, each shown with its own swatch, so you pick a color instead of
 *    recalling a hex code.
 */
import { AbstractInputSuggest, TFolder, type App } from 'obsidian';

import { colorLabel, renderColor } from '@/color';

/** Folder autocomplete for a text input — the same component Obsidian uses internally. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(lower));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path === '/' ? '/ (vault root)' : folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path === '/' ? '' : folder.path;
    this.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
}

/** Color autocomplete: suggests `options()` (e.g. built-in tokens), each with a swatch. */
export class ColorSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private readonly inputEl: HTMLInputElement,
    private readonly options: () => string[],
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return this.options().filter((c) => c.toLowerCase().includes(q));
  }

  renderSuggestion(color: string, el: HTMLElement): void {
    el.addClass('mrg-color-suggestion');
    el.createSpan({ cls: 'mrg-color-swatch' }).style.backgroundColor = renderColor(color).solid;
    el.createSpan({ text: colorLabel(color) });
  }

  selectSuggestion(color: string): void {
    this.inputEl.value = color;
    this.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
}
