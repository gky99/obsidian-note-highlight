/**
 * Regression: reading-mode highlight changes (recolor / create / delete) update the
 * preview **in place** — no `previewMode.rerender(true)` — so the document neither
 * jumps nor flashes, and the change lands on the existing DOM.
 *
 * The old approach re-rendered the whole preview, which (a) restored Obsidian's
 * *remembered* scroll position — a visible flash-to-top, the reported bug — and (b)
 * was the only way colors updated. `syncReadingHighlights` recolors / unwraps /
 * paints the overlay spans directly. Live Preview is unaffected (CM6 decoration
 * effect, no re-render).
 *
 * Two properties, two cases:
 *   A. Scroll never moves — not even a one-frame dip — when a highlight changes while
 *      scrolled away (a bare rerender dips ~768px on the first frame).
 *   B. The update is in place: a recolor keeps the **same span element** (a rerender
 *      would replace the node) and flips its color; a delete unwraps the span.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("reading-mode highlight changes are in place (no rerender flash/jump)", function () {
    it("A: scroll does not move (not even a one-frame dip) on recolor/create/delete", async function () {
        const FILE = "ReadingScrollA.md";
        const LINES = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with word target${i} here.`);
        const BODY = `# Heading\n\n${LINES.join("\n\n")}\n`;
        const r = await browser.executeObsidian(
            async ({ app }, file, body) => {
                const obs = app as any;
                for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                    const f = obs.vault.getAbstractFileByPath(p);
                    if (f) await obs.vault.delete(f).catch(() => {});
                }
                const tfile = await obs.vault.create(file, body);
                await new Promise((r) => setTimeout(r, 250));
                const plugin = obs.plugins.plugins["marginalia"];
                obs.workspace.detachLeavesOfType("markdown");
                const leaf = obs.workspace.getLeaf(true);
                await leaf.openFile(tfile, { active: true });
                await leaf.setViewState({ type: "markdown", state: { file, mode: "preview", source: false }, active: true });
                await plugin.activateAside(true);
                await new Promise((r) => setTimeout(r, 500));
                const view = leaf.view;
                const scroller = () => view.containerEl.querySelector(".markdown-preview-view") as HTMLElement;
                const sourcePath = plugin.resolveSourcePath(file);
                const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

                // A highlight near the top; we then scroll far away from it.
                const w0 = "target3";
                const f0 = body.indexOf(w0);
                const anno = await plugin.store.createHighlight(tfile, f0, f0 + w0.length);
                await new Promise((r) => setTimeout(r, 400));

                const run = async (fn: () => void | Promise<unknown>) => {
                    scroller().scrollTop = scroller().scrollHeight;
                    await new Promise((r) => setTimeout(r, 250));
                    const before = scroller().scrollTop;
                    await fn();
                    let min = before;
                    for (let i = 0; i < 40; i++) { await raf(); min = Math.min(min, scroller().scrollTop); }
                    await new Promise((r) => setTimeout(r, 250));
                    return { before, min, after: scroller().scrollTop };
                };

                const recolor = await run(() => plugin.store.updateColor(sourcePath, anno.id, "#ff0000"));
                const w1 = "target5";
                const f1 = body.indexOf(w1);
                const create = await run(() => plugin.store.createHighlight(tfile, f1, f1 + w1.length));
                const del = await run(() => plugin.store.deleteAnnotation(sourcePath, anno.id));
                return { recolor, create, del };
            },
            FILE,
            BODY,
        );
        expect(r.recolor.before).toBeGreaterThan(100); // we did scroll away from the top
        expect(r.recolor.min).toBeGreaterThan(r.recolor.before - 20);
        expect(r.create.min).toBeGreaterThan(r.create.before - 20);
        expect(r.del.min).toBeGreaterThan(r.del.before - 20);
    });

    it("B: recolor keeps the same span node (no rerender) and flips its color; delete unwraps", async function () {
        const FILE = "ReadingScrollB.md";
        // Short enough that the highlighted paragraph is always rendered.
        const BODY = `# Heading\n\nAlpha bravo charlie delta echo foxtrot.\n\nGolf hotel india juliet.\n`;
        const r = await browser.executeObsidian(
            async ({ app }, file, body) => {
                const obs = app as any;
                for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                    const f = obs.vault.getAbstractFileByPath(p);
                    if (f) await obs.vault.delete(f).catch(() => {});
                }
                const tfile = await obs.vault.create(file, body);
                await new Promise((r) => setTimeout(r, 250));
                const plugin = obs.plugins.plugins["marginalia"];
                obs.workspace.detachLeavesOfType("markdown");
                const leaf = obs.workspace.getLeaf(true);
                await leaf.openFile(tfile, { active: true });
                await leaf.setViewState({ type: "markdown", state: { file, mode: "preview", source: false }, active: true });
                await plugin.activateAside(true);
                await new Promise((r) => setTimeout(r, 500));
                const view = leaf.view;
                const sourcePath = plugin.resolveSourcePath(file);
                const spans = (id: string) =>
                    Array.from(view.containerEl.querySelectorAll(`.mrg-highlight[data-anno-id="${id}"]`)) as HTMLElement[];

                const word = "charlie";
                const from = body.indexOf(word);
                const anno = await plugin.store.createHighlight(tfile, from, from + word.length);
                await new Promise((r) => setTimeout(r, 500));

                const painted = spans(anno.id).length;
                const nodeBefore = spans(anno.id)[0] ?? null;

                await plugin.store.updateColor(sourcePath, anno.id, "#ff0000");
                await new Promise((r) => setTimeout(r, 400));
                const nodeAfter = spans(anno.id)[0] ?? null;
                const sameNode = nodeBefore != null && nodeBefore === nodeAfter; // in place, not rebuilt
                const bg = nodeAfter ? nodeAfter.style.backgroundColor : null;

                await plugin.store.deleteAnnotation(sourcePath, anno.id);
                await new Promise((r) => setTimeout(r, 400));
                const afterDelete = spans(anno.id).length;
                const textIntact = (view.containerEl.querySelector(".markdown-preview-view") as HTMLElement)
                    .textContent?.includes("charlie");

                return { painted, sameNode, bg, afterDelete, textIntact };
            },
            FILE,
            BODY,
        );
        expect(r.painted).toBeGreaterThan(0); // highlight painted in reading mode
        expect(r.sameNode).toBe(true); // recolor mutated the existing node — no full rerender
        expect(r.bg).toContain("255, 0, 0"); // ...and the color actually changed (red, at highlight alpha)
        expect(r.afterDelete).toBe(0); // delete unwrapped the span
        expect(r.textIntact).toBe(true); // ...without eating the text
    });
});
