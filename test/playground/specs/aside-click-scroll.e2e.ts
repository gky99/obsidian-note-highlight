/**
 * Regression test for two side-panel bugs (both rooted in redundant full re-renders):
 *
 *  1. The first click into the panel does nothing. Clicking into the panel fires
 *     `active-leaf-change` → a same-file sync that rebuilt the card DOM between
 *     mousedown and mouseup, destroying the button being clicked.
 *  2. Clicking a button / jumping scrolled the panel to the top, because the rebuild
 *     creates a fresh `.mrg-aside` whose scrollTop is 0.
 *
 * The fix: `render()` skips the rebuild when the cards are unchanged (so a redundant
 * sync is a no-op — the clicked node survives and scroll is untouched), and preserves
 * scroll across a *real* same-file rebuild (e.g. a recolor).
 *
 * This drives the exact same-file re-sync `active-leaf-change` causes and checks the
 * card node identity + scroll offset, plus a recolor. Teeth: revert render() to always
 * rebuild and tests 1+2 fail; drop the scroll restore and the recolor test fails.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "AsideClickScroll.md";
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
const BODY = `# Notes\n\n${WORDS.join(" ")}.\n`;

async function runScenario() {
    return browser.executeObsidian(
        async ({ app }, file, body, words) => {
            const obs = app as any;
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 250));

            const plugin = obs.plugins.plugins["marginalia"];
            // Many highlights so the panel overflows and can scroll.
            for (const w of words) {
                const from = body.indexOf(w);
                await plugin.store.createHighlight(tfile, from, from + w.length);
            }

            await plugin.activateAside(true);
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            await aside.setSourceFile(file);
            await new Promise((r) => setTimeout(r, 600)); // let card markdown settle

            // The redundant same-file sync that clicking into the panel triggers.
            const resync = async () => {
                await aside.setSourceFile(file);
                await plugin.store.load(tfile);
                await new Promise((r) => setTimeout(r, 200));
            };

            // --- Bug 1: the card DOM node must survive a redundant sync ---
            const cardBefore = document.querySelector(".mrg-aside .mrg-card");
            await resync();
            const cardAfter = document.querySelector(".mrg-aside .mrg-card");
            const cardSurvives = cardBefore != null && cardBefore === cardAfter;

            // --- Bug 2a: scroll is preserved across a redundant sync ---
            const panel = document.querySelector(".mrg-aside") as HTMLElement;
            panel.scrollTop = 120;
            const scrolledTo = panel.scrollTop; // 0 if not actually scrollable
            await resync();
            const scrollAfterResync = (document.querySelector(".mrg-aside") as HTMLElement).scrollTop;

            // --- Bug 2b: scroll is preserved across a real rebuild (recolor) ---
            const livePanel = document.querySelector(".mrg-aside") as HTMLElement;
            livePanel.scrollTop = 120;
            const beforeRecolor = livePanel.scrollTop;
            const firstId = (document.querySelector(".mrg-aside .mrg-card") as HTMLElement).dataset.annoId;
            await plugin.store.updateColor(file, firstId, "#123456");
            await new Promise((r) => setTimeout(r, 500)); // re-render + async scroll restore
            const scrollAfterRecolor = (document.querySelector(".mrg-aside") as HTMLElement).scrollTop;

            // cleanup
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            return { cardSurvives, scrolledTo, scrollAfterResync, beforeRecolor, scrollAfterRecolor };
        },
        FILE,
        BODY,
        WORDS,
    );
}

const FILE2 = "AsideButtonAction.md";
const BODY2 = "# Notes\n\nalpha bravo charlie delta.\n";

/**
 * Bug 1 (the literal report): pressing a card button does nothing on the first
 * click. Reproduced deterministically — capture the button under the cursor, run
 * the redundant same-file sync that `active-leaf-change` fires between mousedown
 * and mouseup, then dispatch the click on that captured node. If the panel was
 * rebuilt, the node is detached and its action mounts off-document; with the fix
 * the node survives and the comment editor opens in the live panel.
 */
async function buttonActionScenario() {
    return browser.executeObsidian(
        async ({ app }, file, body) => {
            const obs = app as any;
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 250));

            const plugin = obs.plugins.plugins["marginalia"];
            const from = body.indexOf("alpha");
            await plugin.store.createHighlight(tfile, from, from + "alpha".length);
            await plugin.activateAside(true);
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            await aside.setSourceFile(file);
            await new Promise((r) => setTimeout(r, 400));

            // The button the user presses (no comment yet → "Add comment").
            const card = document.querySelector(".mrg-aside .mrg-card");
            const commentBtn = card?.querySelector('button[aria-label="Add comment"]') as HTMLElement | null;
            const hadButton = commentBtn != null;

            // Redundant same-file sync (what clicking into the panel triggers).
            await aside.setSourceFile(file);
            await plugin.store.load(tfile);
            await new Promise((r) => setTimeout(r, 150));

            // Press the *captured* button and check the editor opened in the LIVE panel.
            commentBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise((r) => setTimeout(r, 120));
            const editorOpenedLive = document.querySelector(".mrg-aside .mrg-card-comment-input") != null;

            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            return { hadButton, editorOpenedLive };
        },
        FILE2,
        BODY2,
    );
}

describe("aside panel click + scroll", function () {
    it("triggers a card button's action even when a redundant sync fires mid-click", async function () {
        const r = await buttonActionScenario();
        expect(r.hadButton).toBe(true);
        // The pressed button still opens the comment editor in the live panel.
        expect(r.editorOpenedLive).toBe(true);
    });

    it("does not rebuild (or scroll-reset) the panel on a redundant same-file sync, and keeps scroll on recolor", async function () {
        const r = await runScenario();

        // Precondition: the panel is actually scrollable in this layout.
        expect(r.scrolledTo).toBeGreaterThan(0);

        // Bug 1: the clicked card node survives a redundant sync (not rebuilt).
        expect(r.cardSurvives).toBe(true);
        // Bug 2a: a redundant sync leaves the scroll position untouched.
        expect(r.scrollAfterResync).toBe(r.scrolledTo);
        // Bug 2b: a real rebuild (recolor) restores the scroll position.
        expect(r.scrollAfterRecolor).toBeGreaterThanOrEqual(r.beforeRecolor - 5);
    });
});
