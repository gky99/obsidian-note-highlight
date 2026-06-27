/**
 * DIAGNOSTIC: reproduce the intermittent reading-mode paint. A long note with a
 * cross-paragraph bold highlight far down; switch Live Preview <-> Reading many
 * times and record how often the highlight actually paints. The user reports it
 * paints "sometimes" — a render/repaint race, not a matching failure.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "Flaky.md";

async function makeNote() {
    return browser.executeObsidian(async ({ app }, file) => {
        const obs = app as any;
        const base = file.replace(/\.md$/, "");
        for (const f of obs.vault.getMarkdownFiles()) {
            if (!f.path.includes(".annotations")) continue;
            const t = await obs.vault.read(f).catch(() => "");
            if (t.includes(`[[${base}]]`)) await obs.vault.delete(f).catch(() => {});
        }
        const stale = obs.vault.getAbstractFileByPath(file);
        if (stale) await obs.vault.delete(stale);

        // ~3600 chars of filler, then the cross-paragraph bold target.
        let filler = "";
        for (let i = 0; i < 60; i++) {
            filler += `Filler paragraph ${i} with some ordinary words to push content down.\n\n`;
        }
        const target =
            "**A7 tear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.\n";
        const body = filler + target;
        const tfile = await obs.vault.create(file, body);
        await new Promise((r) => setTimeout(r, 300));

        const plugin = obs.plugins.plugins["marginalia"];
        const from = body.indexOf("**A7 tear-off");
        const to = body.indexOf("with me.") + "with me.".length;
        const anno = await plugin.store.createHighlight(tfile, from, to);
        await plugin.store.load(tfile);
        return { quote: anno?.quote ?? null, from, to, len: body.length };
    }, FILE);
}

/** Switch the open markdown view's mode, scroll the highlight into view, return painted-span count. */
async function switchAndCount(mode: "source" | "preview"): Promise<number> {
    return browser.executeObsidian(async ({ app }, file, m) => {
        const obs = app as any;
        let leaf: any = null;
        obs.workspace.iterateAllLeaves((l: any) => {
            if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) leaf = l;
        });
        if (!leaf) {
            leaf = obs.workspace.getLeaf(true);
            const tfile = obs.vault.getAbstractFileByPath(file);
            await leaf.openFile(tfile, { active: true });
        }
        await leaf.setViewState({
            type: "markdown",
            state: { file, mode: m, source: false },
            active: true,
        });
        await new Promise((r) => setTimeout(r, 500));
        if (m !== "preview") return -1;
        const prev: HTMLElement | null = leaf.view.containerEl.querySelector(".markdown-preview-view");
        // Scroll to the bottom so the target section renders.
        if (prev) {
            prev.scrollTop = prev.scrollHeight;
            await new Promise((r) => setTimeout(r, 500));
        }
        return prev ? prev.querySelectorAll(".mrg-highlight").length : -2;
    }, FILE, mode);
}

/** Strip every painted span (preserving text) to simulate the rendered-but-
 *  unpainted race symptom, then run the plugin's self-heal and return the painted
 *  count before/after. */
async function stripThenHeal(): Promise<{ before: number; after: number }> {
    return browser.executeObsidian(async ({ app }, file) => {
        const obs = app as any;
        let view: any = null;
        obs.workspace.iterateAllLeaves((l: any) => {
            if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) view = l.view;
        });
        const prev: HTMLElement = view.containerEl.querySelector(".markdown-preview-view");
        // Unwrap spans → text stays, no .mrg-highlight remains (the exact symptom:
        // anchored + text in DOM + zero painted spans).
        prev.querySelectorAll(".mrg-highlight").forEach((s: Element) => {
            s.replaceWith(document.createTextNode(s.textContent ?? ""));
        });
        prev.normalize();
        const before = prev.querySelectorAll(".mrg-highlight").length;

        const plugin = obs.plugins.plugins["marginalia"];
        const resolved = plugin.store.getResolved(file);
        const q = resolved[0]?.annotation?.quote ?? "";
        const proj = q.split("\n").map((l: string) => l.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, "")).join(" ").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
        const dom = (prev.innerText || "").replace(/\s+/g, " ");
        plugin.healReadingViews(file); // the self-heal under test
        await new Promise((r) => setTimeout(r, 100));
        const after = view.containerEl.querySelectorAll(".markdown-preview-view .mrg-highlight").length;
        return {
            before,
            after,
            resolvedLen: resolved.length,
            status: resolved[0]?.result?.status,
            mode: view.getMode(),
            projInDom: dom.includes(proj),
            proj,
        };
    }, FILE);
}

describe("reading-mode self-heal", function () {
    it("re-paints an anchored highlight that lost its spans (the race symptom)", async function () {
        const info = await makeNote();
        console.log("quote:", JSON.stringify(info.quote), "len:", info.len);
        const painted = await switchAndCount("preview");
        expect(painted).toBe(4); // baseline: post-processor painted it

        const r = await stripThenHeal();
        console.log("HEAL DIAG:", JSON.stringify(r));
        expect(r.before).toBe(0); // symptom reproduced: rendered but unpainted
        expect(r.after).toBe(4); // self-heal recovered it
    });
});
