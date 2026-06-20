/**
 * Regression test for reading-mode highlight rendering.
 *
 * Drives real Obsidian: for each case it creates a note, makes a highlight via the
 * plugin store, opens the note COLD directly in reading mode, and asserts a
 * `.mrg-highlight` span actually paints. Covers the cases that used to silently
 * fail — quotes spanning inline elements (`**bold**`, links) — alongside the
 * plain-prose control. See CLAUDE.md "Reading-mode highlights — RESOLVED".
 *
 * The paint is asynchronous (store load → `previewMode.rerender`), so we POLL for
 * the highlight rather than sleeping a fixed time.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

interface Case {
    file: string;
    body: string;
    pick: string; // source substring to highlight
    label: string;
}

const CASES: Case[] = [
    {
        file: "Plain.md",
        body: "# Plain\n\nThe quick brown fox jumps over the lazy dog.\n",
        pick: "quick brown fox",
        label: "plain prose",
    },
    {
        file: "Bold.md",
        body: "# Bold\n\nThe quick **brown fox** jumps over the lazy dog.\n",
        pick: "**brown fox** jumps",
        label: "spans bold",
    },
    {
        file: "Link.md",
        body: "# Link\n\nSee the [Obsidian site](https://obsidian.md) for more info today.\n",
        pick: "the [Obsidian site](https://obsidian.md) for",
        label: "spans a link",
    },
];

/** Create the note + highlight, then open it cold directly in reading mode. */
async function setupAndOpen(c: Case) {
    return browser.executeObsidian(
        async ({ app }, file, body, pick) => {
            const obs = app as any;
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 300));

            const plugin = obs.plugins.plugins["marginalia"];
            const from = body.indexOf(pick);
            const to = from + pick.length;
            const anno = await plugin.store.createHighlight(tfile, from, to);

            // Cold start: forget store + detach leaves, then open in reading mode.
            plugin.store.forget(file);
            obs.workspace.detachLeavesOfType("markdown");
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "preview", source: false },
                active: true,
            });

            const resolved = plugin.store.getResolved(file);
            return {
                quote: anno?.quote ?? null,
                resolvedStatus: resolved.map((r: any) => r.result.status),
            };
        },
        c.file,
        c.body,
        c.pick,
    );
}

/** Read the painted highlight text from the file's reading-mode preview. */
async function readHighlights(file: string): Promise<string[]> {
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
    }, file);
}

describe("reading-mode highlight cases", function () {
    for (const c of CASES) {
        it(`paints "${c.label}" in reading mode`, async function () {
            const setup = await setupAndOpen(c);
            expect(setup.resolvedStatus).toEqual(["anchored"]);

            // Poll until the async preview paint lands (store load → rerender).
            await browser.waitUntil(
                async () => (await readHighlights(c.file)).length > 0,
                {
                    timeout: 8000,
                    interval: 250,
                    timeoutMsg: `no .mrg-highlight painted for "${c.label}"`,
                },
            );

            const painted = (await readHighlights(c.file)).join("");
            console.log(`CASE ${c.label}: quote=${setup.quote} painted="${painted}"`);
        });
    }
});
