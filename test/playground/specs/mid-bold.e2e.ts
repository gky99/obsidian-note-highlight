/**
 * End-to-end coverage for importing highlights that touch an emphasis span,
 * driven through the REAL import path on real Obsidian:
 *   importer.planClip → locateMark → store.createHighlights → cold reload →
 *   reading-mode paint.
 *
 * The mark text is the *rendered* selection (markdown markers stripped), exactly
 * as the Web Highlights browser extension records it. We assert two things per
 * shape:
 *   1. the STORED quote keeps a wrapping emphasis delimiter balanced (so it is
 *      well-formed Markdown) — the import "leading/trailing bold" fix; and
 *   2. reading mode actually PAINTS the highlight over the rendered text.
 *
 * Guards the bugs reported 2026-06-26: a highlight starting at a bold span
 * dropped the opening `**`, and mid-bold highlights were thought not to paint.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const PAGE = "https://example.com/page";

interface Probe {
    label: string;
    file: string;
    body: string; // clip body (frontmatter is added automatically)
    markText: string; // rendered selection (markers stripped), as WH stores it
    expectQuote: string; // the quote the import must store (source slice)
    expectPaint: string; // concatenated reading-mode painted text
}

const fm = (body: string) => `---\nsource: ${PAGE}\n---\n\n${body}\n`;

const PROBES: Probe[] = [
    {
        label: "leading bold — select starts at **bold**",
        file: "MBLead.md",
        body: "See a **bold** word here today.",
        markText: "bold word",
        expectQuote: "**bold** word",
        expectPaint: "bold word",
    },
    {
        label: "whole bold word",
        file: "MBWhole.md",
        body: "See a **bold** thing here.",
        markText: "bold",
        expectQuote: "**bold**",
        expectPaint: "bold",
    },
    {
        label: "bold at paragraph start",
        file: "MBStart.md",
        body: "**Bold** start of the line.",
        markText: "Bold start",
        expectQuote: "**Bold** start",
        expectPaint: "Bold start",
    },
    {
        label: "leading italic (underscore)",
        file: "MBItal.md",
        body: "an _italic_ word here.",
        markText: "italic word",
        expectQuote: "_italic_ word",
        expectPaint: "italic word",
    },
    {
        label: "mid-bold within span",
        file: "MBWithin.md",
        body: "See a **bold text** zee here.",
        markText: "old text",
        expectQuote: "old text",
        expectPaint: "old text",
    },
    {
        label: "mid-bold running past the bold end",
        file: "MBPast.md",
        body: "See a **bold** rest of it here.",
        markText: "ld rest",
        expectQuote: "ld** rest",
        expectPaint: "ld rest",
    },
    {
        // Two source lines joined by a SINGLE newline = a soft line break inside
        // one paragraph. The rendered DOM keeps a literal "\n" between the text
        // nodes; the reading painter must match whitespace-insensitively or the
        // highlight vanishes (the reported bug — it painted in editing only).
        label: "quote spanning a soft line break",
        file: "MBSoft.md",
        body: "**A7 tear-off notepad**\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.",
        markText: "A7 tear-off notepad and a 0.5mm mechanical pencil (soft 2B leads) with me.",
        expectQuote: "**A7 tear-off notepad**\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.",
        expectPaint: "A7 tear-off notepad and a 0.5mm mechanical pencil (soft 2B leads) with me.",
    },
];

async function realImport(p: Probe) {
    return browser.executeObsidian(
        async ({ app }, file, body, markText, page) => {
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

            const plugin = obs.plugins.plugins["marginalia"];
            // Wait for metadataCache to parse frontmatter (urlFromMeta reads it).
            for (let i = 0; i < 50; i++) {
                if (obs.metadataCache.getFileCache(tfile)?.frontmatter?.source) break;
                await new Promise((r) => setTimeout(r, 100));
            }

            const data = { marks: [{ url: page, text: markText, color: "#fdffb4" }] };
            const plan = await plugin.importer.planClip(tfile, data);
            const sourceText = await obs.vault.read(tfile);
            const planned = plan.highlights.map((h: any) => ({
                slice: sourceText.slice(h.from, h.to),
            }));

            const made = await plugin.store.createHighlights(
                tfile,
                plan.highlights.map((h: any) => ({
                    from: h.from,
                    to: h.to,
                    color: h.color,
                    comment: h.comment,
                })),
            );

            // Cold reload + open reading mode.
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
                matched: plan.highlights.length,
                missing: plan.missing.length,
                slice: planned[0]?.slice ?? null,
                storedQuote: made[0]?.quote ?? null,
                resolvedStatus: resolved.map((r: any) => r.result.status),
            };
        },
        p.file,
        fm(p.body),
        p.markText,
        PAGE,
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

describe("import highlights touching an emphasis span", function () {
    for (const p of PROBES) {
        it(`${p.label}`, async function () {
            const s = await realImport(p);

            // The mark located + was created.
            expect(s.matched).toBe(1);
            expect(s.missing).toBe(0);
            // Import stored exactly the expected source slice as the quote.
            expect(s.slice).toBe(p.expectQuote);
            expect(s.storedQuote).toBe(p.expectQuote);
            // It anchored (not orphaned).
            expect(s.resolvedStatus).toEqual(["anchored"]);

            // Reading mode actually painted it, and the painted text matches the
            // rendered (marker-free) selection.
            await browser.waitUntil(
                async () => (await readHighlights(p.file)).length > 0,
                {
                    timeout: 8000,
                    interval: 200,
                    timeoutMsg: `no .mrg-highlight painted for "${p.label}"`,
                },
            );
            // Normalize whitespace: a soft-break highlight's spans join with the
            // rendered "\n", which is visually the single space the needle had.
            const painted = (await readHighlights(p.file)).join("").replace(/\s+/g, " ");
            expect(painted).toBe(p.expectPaint);
        });
    }
});
