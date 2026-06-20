/**
 * Regression test for the import preview modal's default focus.
 *
 * Reported: when the Web Highlights import preview opens, the *Cancel* button is
 * focused, not Import — so Enter cancels. Root cause: Obsidian's `Modal.open()`
 * autofocuses the first focusable element in the modal (the Cancel button, which
 * is added before Import) via a `tg(modalEl)` call that runs *after* `onOpen()`
 * returns — clobbering any focus set during `onOpen`. The fix overrides `open()`
 * to focus Import *after* `super.open()` (i.e. after that autofocus has run).
 *
 * This drives the real importer: a clip note with a source URL + a matching
 * Web Highlights export, then `importer.importCurrent()` to open the modal, and
 * asserts the focused element is the Import (CTA) button.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const URL = "https://example.com/marginalia-import-focus";
const CLIP = "ImportFocusClip.md";
const SIDE = "ImportFocusClip.annotations.md";
const FOLDER = "WHExportFocus";
const EXPORT = `${FOLDER}/export-2026-06-20.json`;
const TEXT = "the quick brown fox";
const BODY = `---\nsource: ${URL}\n---\n\n# Clip\n\nThe quick brown fox jumps over the lazy dog.\n`;

/** Seed a clip + export, point the plugin at them, and open the import preview. */
async function openImportPreview(): Promise<boolean> {
    return browser.executeObsidian(
        async ({ app }, a) => {
            const obs = app as any;
            for (const p of [a.clip, a.side, a.exportPath]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }

            // A Web Highlights export (one mark on the clip's URL) in its folder.
            if (!obs.vault.getAbstractFileByPath(a.folder)) {
                try {
                    await obs.vault.createFolder(a.folder);
                } catch {
                    /* already exists */
                }
            }
            const exportJson = { marks: [{ url: a.url, text: a.text, color: "#fdffb4" }] };
            await obs.vault.create(a.exportPath, JSON.stringify(exportJson));

            // A clip note whose frontmatter carries the source URL and whose body
            // contains the mark's text (so the import locates one highlight).
            const tfile = await obs.vault.create(a.clip, a.body);
            await new Promise((r) => setTimeout(r, 500)); // let metadataCache parse frontmatter

            const plugin = obs.plugins.plugins["marginalia"];
            plugin.settings.webHighlightsFolder = a.folder;
            plugin.settings.clipsFolder = "";

            const leaf = obs.workspace.getLeaf(false);
            await leaf.openFile(tfile);
            await new Promise((r) => setTimeout(r, 200));

            // Plans (no write) then opens the modal; focus is set in the open() override.
            await plugin.importer.importCurrent();
            return !!document.querySelector(".mrg-import-modal");
        },
        {
            clip: CLIP,
            side: SIDE,
            folder: FOLDER,
            exportPath: EXPORT,
            url: URL,
            text: TEXT,
            body: BODY,
        },
    );
}

describe("import preview focus", function () {
    it("focuses the Import button (not Cancel) when the preview opens", async function () {
        const opened = await openImportPreview();
        expect(opened).toBe(true);

        const modal = await browser.$(".mrg-import-modal");
        await modal.waitForExist({ timeout: 10_000 });

        const cta = await browser.$(".mrg-import-modal .setting-item button.mod-cta");
        await cta.waitForExist({ timeout: 2_000 });
        // The CTA is the Import button; Cancel is the plain button beside it.
        expect(await cta.getText()).toContain("Import");

        // The fix's whole point: Import — not Cancel — holds focus after open().
        expect(await cta.isFocused()).toBe(true);
    });
});
