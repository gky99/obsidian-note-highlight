/**
 * Regression test for the aside color popup closing itself.
 *
 * Repro (reported): with the editor focused, clicking a card's color button in
 * the side panel opens the swatch popup, which then *immediately closes*. Cause:
 * clicking from the editor into the panel changes Obsidian's active leaf, which
 * fires `active-leaf-change` → the plugin's `syncActiveFile()` →
 * `aside.setSourceFile(samePath)` + `store.load()`. Both emit a full aside
 * `render()`, and `render()` calls `closeColorPopup()` — so the popup is torn
 * down the instant it opens.
 *
 * This test reproduces the *mechanism* deterministically: open the popup, then
 * drive the exact same-file re-sync that `active-leaf-change` triggers, and
 * assert the popup survives. It must NOT close on a redundant same-file sync.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "ColorPopup.md";
const BODY = "# Color popup\n\nThe quick brown fox jumps over the lazy dog.\n";

/** Create the note + a highlight, open the aside, and point it at the note. */
async function setup(): Promise<string | null> {
    return browser.executeObsidian(
        async ({ app }, file, body) => {
            const obs = app as any;
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 250));

            // Open the note in a center leaf and focus its editor (the repro
            // precondition: the editor — not the panel — holds focus).
            const leaf = obs.workspace.getLeaf(false);
            await leaf.openFile(tfile);

            const plugin = obs.plugins.plugins["marginalia"];
            const from = body.indexOf("brown fox");
            const anno = await plugin.store.createHighlight(
                tfile,
                from,
                from + "brown fox".length,
            );

            // Open the side panel and point it at the note so a card renders.
            await plugin.activateAside(true);
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            await aside?.setSourceFile(file);
            await new Promise((r) => setTimeout(r, 250));
            return anno?.id ?? null;
        },
        FILE,
        BODY,
    );
}

/** The re-sync `active-leaf-change` causes when you click into the panel. */
async function resyncSameFile(): Promise<void> {
    await browser.executeObsidian(async ({ app }, file) => {
        const obs = app as any;
        const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
        await aside?.setSourceFile(file); // == syncActiveFile() with the same note
    }, FILE);
}

describe("aside color popup", function () {
    it("stays open when a redundant same-file sync re-renders the panel", async function () {
        const annoId = await setup();
        expect(annoId).not.toBeNull();

        const button = await browser.$(".mrg-color-button");
        await button.waitForExist({ timeout: 10_000 });
        await button.click();

        // The popup opens synchronously in the click handler.
        const popup = await browser.$(".mrg-color-popup");
        await popup.waitForExist({ timeout: 2_000 });
        expect(await popup.isExisting()).toBe(true);

        // Now drive the active-leaf-change re-sync. The popup must survive.
        await resyncSameFile();
        await browser.pause(250);

        expect(await browser.$(".mrg-color-popup").isExisting()).toBe(true);
    });
});
