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

/** Run the jump and poll for the flash class on the painted reading-mode span. */
async function jumpAndDetectFlash(id: string): Promise<boolean> {
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
            if (!preview) return false;

            // The flash class is applied (with a brief paint retry) and stays ~1.5s.
            for (let i = 0; i < 14; i++) {
                const span = preview.querySelector(`.mrg-highlight[data-anno-id="${annoId}"]`);
                if (span && span.classList.contains("mrg-flash")) return true;
                await new Promise((r) => setTimeout(r, 100));
            }
            return false;
        },
        FILE,
        id,
    );
}

describe("jump flash (reading mode)", function () {
    it("flashes the painted highlight span when jumping in reading mode", async function () {
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

        const flashed = await jumpAndDetectFlash(id as string);
        expect(flashed).toBe(true);
    });
});
