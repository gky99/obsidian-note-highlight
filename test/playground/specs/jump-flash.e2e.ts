/**
 * Regression test for the reading-mode jump flash (§8.1). Reading mode has no
 * CodeMirror, so jumping to a highlight flashes the *painted* `.mrg-highlight`
 * span by toggling the `mrg-flash` class. This drives a real jump in reading mode
 * and asserts the class lands on the highlight.
 *
 * Teeth: drop the `flashReadingMode(...)` call in navigation and the class never
 * appears → this fails.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "JumpFlash.md";
const BODY = "# Jump flash\n\nThe quick brown fox jumps over the lazy dog.\n";
const PICK = "quick brown fox";

/** Create note + highlight, open it in reading mode, open the aside. Returns the id. */
async function setup(): Promise<string | null> {
    return browser.executeObsidian(
        async ({ app }, file, body, pick) => {
            const obs = app as any;
            const base = file.replace(/\.md$/, "");
            for (const f of obs.vault.getMarkdownFiles()) {
                if (!f.path.includes(".annotations")) continue;
                const t = await obs.vault.read(f).catch(() => "");
                if (t.includes(`[[${base}]]`)) await obs.vault.delete(f).catch(() => {});
            }
            const stale = obs.vault.getAbstractFileByPath(file);
            if (stale) await obs.vault.delete(stale);
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 300));

            const plugin = obs.plugins.plugins["marginalia"];
            const from = body.indexOf(pick);
            const anno = await plugin.store.createHighlight(tfile, from, from + pick.length);

            // Open the note in reading mode.
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "preview", source: false },
                active: true,
            });
            await plugin.store.load(tfile);
            await plugin.activateAside(true);
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            await aside.setSourceFile(file);
            return anno?.id ?? null;
        },
        FILE,
        BODY,
        PICK,
    );
}

/**
 * Run the jump, confirm the flash class lands, then force a heal/sync pass (the very
 * thing a real jump triggers: openFile → load → repaint → scheduleHeal) and confirm
 * the flash SURVIVES it. The earlier version returned on first sighting, so it missed
 * that `syncReadingHighlights`'s recolor clobbered `className` and stripped `mrg-flash`
 * within the flash window — highlight intact, glow gone (the reading-mode "no flash").
 */
async function jumpAndDetectFlash(id: string): Promise<{ appeared: boolean; survivedHeal: boolean }> {
    return browser.executeObsidian(
        async ({ app }, file, annoId) => {
            const obs = app as any;
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            // The aside's wired jump → jumpToAnnotation (reading branch → flashReadingMode).
            await aside.deps.jumpTo(file, annoId);

            const preview = (() => {
                let el: HTMLElement | null = null;
                obs.workspace.iterateAllLeaves((l: any) => {
                    if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                        el = l.view.containerEl.querySelector(".markdown-preview-view");
                    }
                });
                return el as HTMLElement | null;
            })();
            if (!preview) return { appeared: false, survivedHeal: false };

            const flashed = () => {
                const span = preview!.querySelector(`.mrg-highlight[data-anno-id="${annoId}"]`);
                return !!span && span.classList.contains("mrg-flash");
            };

            // The flash class is applied (with a brief paint retry) and stays ~1.5s.
            let appeared = false;
            for (let i = 0; i < 14; i++) {
                if (flashed()) {
                    appeared = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 100));
            }

            // Force the heal/sync pass that a jump triggers, then check the flash is
            // STILL on the span (the recolor must not strip it). store.load → onChange
            // → repaint → scheduleHeal → syncReadingHighlights (immediate + deferred).
            const plugin = obs.plugins.plugins["marginalia"];
            const tfile = obs.vault.getAbstractFileByPath(file);
            await plugin.store.load(tfile);
            await new Promise((r) => setTimeout(r, 250)); // let the deferred heal fire too
            return { appeared, survivedHeal: flashed() };
        },
        FILE,
        id,
    );
}

describe("jump flash (reading mode)", function () {
    it("flashes the painted highlight span and the flash survives a heal pass", async function () {
        const id = await setup();
        expect(id).not.toBeNull();
        // The highlight must paint before the jump can flash it.
        await browser.waitUntil(
            async () =>
                browser.executeObsidian(({ app }, file, annoId) => {
                    const obs = app as any;
                    let found = false;
                    obs.workspace.iterateAllLeaves((l: any) => {
                        if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                            found = !!l.view.containerEl.querySelector(
                                `.mrg-highlight[data-anno-id="${annoId}"]`,
                            );
                        }
                    });
                    return found;
                }, FILE, id),
            { timeout: 8000, interval: 250, timeoutMsg: "highlight never painted in reading mode" },
        );

        const r = await jumpAndDetectFlash(id as string);
        expect(r.appeared).toBe(true);
        expect(r.survivedHeal).toBe(true); // the bug: the heal's recolor stripped mrg-flash
    });
});
