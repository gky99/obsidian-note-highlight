/**
 * Regression test: jumping to a highlight must not leave the text *selected*.
 * In Live Preview the jump used to `setSelection(range)`, which leaves an accent
 * (purple) selection over the highlight long after the transient flash has faded —
 * looking like the flash never ends. The jump should place the cursor, not select.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "JumpNoSel.md";
const BODY = "# Clip\n\nThe quick brown fox jumps over the lazy dog today.\n";
const PICK = "quick brown fox";

async function jumpAndInspect() {
    return browser.executeObsidian(
        async ({ app }, file, body, pick) => {
            const obs = app as any;
            const base = file.replace(/\.md$/, "");
            for (const f of obs.vault.getMarkdownFiles()) {
                if (f.path.includes(".annotations")) {
                    const t = await obs.vault.read(f).catch(() => "");
                    if (t.includes(`[[${base}]]`)) await obs.vault.delete(f).catch(() => {});
                }
            }
            const stale = obs.vault.getAbstractFileByPath(file);
            if (stale) await obs.vault.delete(stale);
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 250));

            const plugin = obs.plugins.plugins["marginalia"];
            const from = body.indexOf(pick);
            const anno = await plugin.store.createHighlight(tfile, from, from + pick.length);

            // Open in Live Preview (editor visible).
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "source", source: false },
                active: true,
            });
            await plugin.store.load(tfile);
            await plugin.activateAside(true);
            const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
            await aside.setSourceFile(file);

            // Jump, then wait past the flash and inspect what's left over the text.
            await aside.deps.jumpTo(file, anno?.id);
            await new Promise((r) => setTimeout(r, 2000));

            let selectedText = "";
            let flashCount = 0;
            obs.workspace.iterateAllLeaves((l: any) => {
                if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                    selectedText = l.view.editor?.getSelection?.() ?? "";
                    flashCount = l.view.containerEl.querySelectorAll(".mrg-flash").length;
                }
            });

            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            return { selectedText, flashCount };
        },
        FILE,
        BODY,
        PICK,
    );
}

describe("jump leaves no persistent overlay", function () {
    it("does not leave the highlight selected after the flash fades", async function () {
        const r = await jumpAndInspect();
        // No lingering accent selection over the highlighted text…
        expect(r.selectedText).toBe("");
        // …and no lingering flash element either.
        expect(r.flashCount).toBe(0);
    });
});
