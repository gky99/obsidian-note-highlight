/**
 * End-to-end coverage for the manual "select and mark" path on real Obsidian
 * (store.createHighlight with exact offsets, as Live Preview produces):
 *
 *  - P1: a selection that starts right after the opening `**` must store a
 *    *balanced* quote that includes the leading marker — same rule the importer
 *    applies (problem 1, fixed via text/emphasis#balanceEmphasisRange).
 *  - P2–P4: a selection that starts in the MIDDLE of a bold span and runs over a
 *    newline must still PAINT in reading mode, across the soft break / blank-line
 *    / hard-break variants (problem 2 — guarded by the reading painter's
 *    whitespace-insensitive match).
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

interface Probe {
    label: string;
    file: string;
    body: string;
    pick: string; // exact source substring the selection covers
    expectQuote: string; // the quote createHighlight must store
    fragments: string[]; // substrings that must all appear in the painted text
}

const MULTI_QUOTE =
    "tear-off notepad**\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.";
const MULTI_FRAGMENTS = ["tear-off notepad", "0.5mm mechanical pencil", "with me."];

const PROBES: Probe[] = [
    {
        label: "P1 select starts right after ** → quote keeps the leading marker",
        file: "SM1.md",
        body: "# T\n\nSee a **bold** word here today.\n",
        pick: "bold** word",
        expectQuote: "**bold** word",
        fragments: ["bold", "word"],
    },
    {
        label: "P2 mid-bold + soft break (one paragraph) paints in reading mode",
        file: "SM2.md",
        body: "# T\n\n**A7 tear-off notepad**\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.\n",
        pick: "tear-off notepad**\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.",
        expectQuote: MULTI_QUOTE,
        fragments: MULTI_FRAGMENTS,
    },
    {
        label: "P3 mid-bold + blank line (two paragraphs) paints in reading mode",
        file: "SM3.md",
        body: "# T\n\n**A7 tear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.\n",
        pick: "tear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.",
        expectQuote: MULTI_QUOTE,
        fragments: MULTI_FRAGMENTS,
    },
    {
        label: "P4 mid-bold + hard break (trailing spaces) paints in reading mode",
        file: "SM4.md",
        body: "# T\n\n**A7 tear-off notepad**  \nand a **0.5mm mechanical pencil** (soft 2B leads) with me.\n",
        pick: "tear-off notepad**  \nand a **0.5mm mechanical pencil** (soft 2B leads) with me.",
        expectQuote: MULTI_QUOTE,
        fragments: MULTI_FRAGMENTS,
    },
];

async function setup(p: Probe) {
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
            const to = from + pick.length;
            const anno = await plugin.store.createHighlight(tfile, from, to);

            plugin.store.forget(file);
            obs.workspace.detachLeavesOfType("markdown");
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "preview", source: false },
                active: true,
            });
            await plugin.store.load(tfile);
            const resolved = plugin.store.getResolved(file);
            return {
                foundPick: from >= 0,
                quote: anno?.quote ?? null,
                status: resolved.map((r: any) => r.result.status),
            };
        },
        p.file,
        p.body,
        p.pick,
    );
}

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

describe("select-and-mark on real Obsidian", function () {
    for (const p of PROBES) {
        it(`${p.label}`, async function () {
            const s = await setup(p);
            expect(s.foundPick).toBe(true);
            expect(s.quote).toBe(p.expectQuote); // problem 1: leading marker kept
            expect(s.status).toEqual(["anchored"]);

            await browser.waitUntil(
                async () => (await readHighlights(p.file)).length > 0,
                { timeout: 8000, interval: 200, timeoutMsg: `no highlight painted for "${p.label}"` },
            );
            const painted = (await readHighlights(p.file)).join(" ").replace(/\s+/g, " ");
            for (const frag of p.fragments) expect(painted).toContain(frag);
        });
    }
});
