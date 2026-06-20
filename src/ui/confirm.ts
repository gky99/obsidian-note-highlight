/**
 * A generic yes/no confirmation dialog (Obsidian runtime).
 *
 * Resolves `true` only when the user clicks the confirm button; cancelling,
 * pressing Esc, or clicking outside all resolve `false`. Used to guard a
 * destructive action — currently annotation deletion, gated behind the
 * `confirmDelete` setting.
 */
import { Modal, type App } from 'obsidian';

export interface ConfirmOptions {
  title: string;
  /** Body text (a single paragraph). */
  message: string;
  /** Label for the confirming button (default "Confirm"). */
  confirmText?: string;
  /** Style the confirm button as a warning (destructive) action. */
  warning?: boolean;
}

/** Open a confirm dialog; resolves true if confirmed, false otherwise. */
export function confirm(app: App, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}

class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly opts: ConfirmOptions,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl('p', { text: this.opts.message });

    const bar = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const confirmBtn = bar.createEl('button', {
      text: this.opts.confirmText ?? 'Confirm',
      cls: this.opts.warning ? 'mod-warning' : 'mod-cta',
    });
    confirmBtn.addEventListener('click', () => this.finish(true));
    bar.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.finish(false));
  }

  private finish(confirmed: boolean): void {
    this.decided = true;
    this.resolve(confirmed);
    this.close();
  }

  onClose(): void {
    // Closing via Esc / click-outside counts as "no".
    if (!this.decided) this.resolve(false);
    this.contentEl.empty();
  }
}
