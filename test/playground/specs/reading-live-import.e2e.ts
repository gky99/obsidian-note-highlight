/**
 * Reproduces the REAL user import flow (not a cold open): the clip is already
 * open in a view, the import runs, and we look at reading mode WITHOUT manually
 * reloading the store or reopening the note. This exercises the live repaint
 * path (store.onChange → main.repaint → previewMode.rerender), which the cold-
 * open specs bypassed.
 *
 * Two flows:
 *   A. clip already open in READING mode → import → highlight must appear.
 *   B. clip open in LIVE PREVIEW → import → switch to reading mode → must appear.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const PAGE = "https://example.com/live";

// A realistic web-clip: frontmatter with title + source, an H1 that echoes the
// title, then a body paragraph containing the bold span.
const FILE = "LiveClip.md";
const BODY =
    `---\ntitle: The Sample Page\nsource: ${PAGE}\n---\n\n` +
    `# The Sample Page\n\nIntro line before. See a **bold** word here today. Trailing line after.\n`;
const MARK_TEXT = "bold word"; // rendered selection (no markers)

async function freshClip() {
    return browser.executeObsidian(
        async ({ app }, file, body) => {
            const obs = app as any;
            const base = file.replace(/\.md$/, "");
            for (const f of obs.vault.getMarkdownFiles()) {
                if (!f.path.includes(".annotations")) continue;
                const t = await obs.vault.read(f).catch(() => "");
                if (t.includes(`[[${base}]]`)) await obs.vault.delete(f).catch(() => {});
            }
            const stale = obs.vault.getAbstractFileByPath(file);
            if (stale) await obs.vault.delete(stale);
            obs.workspace.detachLeavesOfType("markdown");
            const plugin = obs.plugins.plugins["marginalia"];
            plugin.store.forget(file);
            const tfile = await obs.vault.create(file, body);
            for (let i = 0; i < 50; i++) {
                if (obs.metadataCache.getFileCache(tfile)?.frontmatter?.source) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            return true;
        },
        FILE,
        BODY,
    );
}

/** Open the file in the given mode and wait for it to render. */
async function open(mode: "preview" | "source") {
    return browser.executeObsidian(
        async ({ app }, file, m) => {
            const obs = app as any;
            const tfile = obs.vault.getAbstractFileByPath(file);
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: m, source: false },
                active: true,
            });
            await new Promise((r) => setTimeout(r, 600));
            return true;
        },
        FILE,
        mode,
    );
}

/** Run the real import on the OPEN clip (store.createHighlights → onChange → repaint). */
async function importNow() {
    return browser.executeObsidian(
        async ({ app }, file, markText, page) => {
            const obs = app as any;
            const tfile = obs.vault.getAbstractFileByPath(file);
            const plugin = obs.plugins.plugins["marginalia"];
            const data = { marks: [{ url: page, text: markText, color: "#fdffb4" }] };
            const plan = await plugin.importer.planClip(tfile, data);
            await plugin.store.createHighlights(
                tfile,
                plan.highlights.map((h: any) => ({
                    from: h.from,
                    to: h.to,
                    color: h.color,
                    comment: h.comment,
                })),
            );
            return { matched: plan.highlights.length };
        },
        FILE,
        MARK_TEXT,
        PAGE,
    );
}

async function switchMode(mode: "preview" | "source") {
    return browser.executeObsidian(
        async ({ app }, file, m) => {
            const obs = app as any;
            obs.workspace.iterateAllLeaves((l: any) => {
                if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                    void l.setViewState({
                        type: "markdown",
                        state: { file, mode: m, source: false },
                        active: true,
                    });
                }
            });
            await new Promise((r) => setTimeout(r, 600));
            return true;
        },
        FILE,
        mode,
    );
}

async function readingHighlights(): Promise<string[]> {
    return browser.executeObsidian(({ app }, f) => {
        const obs = app as any;
        let preview: HTMLElement | null = null;
        obs.workspace.iterateAllLeaves((l: any) => {
            if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === f) {
                preview = l.view.containerEl.querySelector(".markdown-preview-view");
            }
        });
        if (!preview) return [];
        return Array.from(
            (preview as HTMLElement).querySelectorAll(".mrg-highlight"),
        ).map((h) => (h as HTMLElement).textContent ?? "");
    }, FILE);
}

describe("reading mode after a live import", function () {
    it("A: clip open in reading mode, import → highlight appears", async function () {
        await freshClip();
        await open("preview");
        expect((await readingHighlights()).length).toBe(0); // none before import
        const r = await importNow();
        expect(r.matched).toBe(1);

        await browser.waitUntil(
            async () => (await readingHighlights()).length > 0,
            { timeout: 8000, interval: 200, timeoutMsg: "no highlight painted after live import into open reading view" },
        );
        expect((await readingHighlights()).join("")).toBe("bold word");
    });

    it("B: clip open in live preview, import, then switch to reading mode → highlight appears", async function () {
        await freshClip();
        await open("source"); // Live Preview (source:false)
        const r = await importNow();
        expect(r.matched).toBe(1);
        await switchMode("preview");

        await browser.waitUntil(
            async () => (await readingHighlights()).length > 0,
            { timeout: 8000, interval: 200, timeoutMsg: "no highlight painted after switching to reading mode" },
        );
        expect((await readingHighlights()).join("")).toBe("bold word");
    });
});
