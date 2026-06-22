/**
 * The sidecar-collision prompt (Design.md §4.1). With a flat sidecar folder, two
 * same-named notes in different folders map to the same canonical sidecar name.
 * When that happens on a note's *first* highlight, the store asks the user — via
 * this modal — how to proceed:
 *  - **Keep separate** (default/CTA): a separate, numbered sidecar
 *    (`Note-1.annotations.md`) — keeps the two clips independent.
 *  - **Continue (use these annotations here)**: take over the existing file for *this*
 *    clip — its `annotates` is repointed here (detaching the previous clip) and its
 *    current annotations are kept, re-resolving against this clip (they anchor if it is
 *    a copy, else orphan). The "I copied the clip, the annotations should follow" case.
 *  - **Cancel**: abort the highlight.
 *
 * Resolves on close, so dismissing with Esc / the ✕ counts as Cancel.
 */
import { App, Modal, Setting } from 'obsidian';
import type { CollisionChoice, SidecarCollision } from '@/store/store';

export class SidecarCollisionModal extends Modal {
  private choice: CollisionChoice = 'cancel';
  private resolveChoice: ((c: CollisionChoice) => void) | null = null;

  constructor(
    app: App,
    private readonly collision: SidecarCollision,
  ) {
    super(app);
  }

  /** Open the modal; resolves with the user's choice (Cancel if dismissed). */
  choose(): Promise<CollisionChoice> {
    return new Promise((resolve) => {
      this.resolveChoice = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, collision } = this;
    this.titleEl.setText('Sidecar name already in use');

    const other = collision.existingAnnotates ?? 'another note';
    contentEl.createEl('p', {
      text:
        `A sidecar already exists at "${collision.existingSidecarPath}" for ${other}, ` +
        `which shares this note’s file name.`,
    });
    contentEl.createEl('p', {
      text:
        'Keep separate saves this note’s annotations in a new numbered file. ' +
        'Continue takes over the existing file for this note: its link is repointed here ' +
        '(detaching the other note) and its current annotations are kept.',
    });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Keep separate')
          .setCta()
          .onClick(() => this.pick('suffix')),
      )
      .addButton((b) =>
        b.setButtonText('Continue (use these annotations here)').onClick(() => this.pick('continue')),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.pick('cancel')));
  }

  private pick(choice: CollisionChoice): void {
    this.choice = choice;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveChoice?.(this.choice);
    this.resolveChoice = null;
  }
}
