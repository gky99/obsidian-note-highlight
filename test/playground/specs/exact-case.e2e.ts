/**
 * DIAGNOSTIC (temporary): the user's exact failing case. Full text is two
 * paragraphs (blank line). The selection that fails starts mid-word ("ear" not
 * "tear") AND ends mid-word ("2" not "2B"); making either boundary a whole word
 * fixes it. Reproduce all three via store.createHighlight (exact offsets) and
 * dump quote / status / range / painted / preview DOM.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const BODY =
    "**A7 tear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2B leads) with me.\n";

interface Probe {
    label: string;
    file: string;
    pick: string;
}

const PROBES: Probe[] = [
    {
        label: "FAIL: both mid-word (ear … soft 2)",
        file: "EC1.md",
        pick: "ear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2",
    },
    {
        label: "OK: start whole word (tear … soft 2)",
        file: "EC2.md",
        pick: "tear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2",
    },
    {
        label: "OK: end whole word (ear … soft 2B)",
        file: "EC3.md",
        pick: "ear-off notepad**\n\nand a **0.5mm mechanical pencil** (soft 2B",
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

            // LIVE flow: open the note in reading mode FIRST, then create the
            // highlight (as select-and-mark does), and let the store's onChange ->
            // repaint -> previewMode.rerender paint it. No cold reopen — this is
            // what the user actually does.
            obs.workspace.detachLeavesOfType("markdown");
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "preview", source: false },
                active: true,
            });
            await new Promise((r) => setTimeout(r, 500));

            const anno = await plugin.store.createHighlight(tfile, from, to);
            const resolved = plugin.store.getResolved(file);
            return {
                foundPick: from >= 0,
                from,
                to,
                quote: anno?.quote ?? null,
                status: resolved.map((r: any) => r.result.status),
                range: resolved.map((r: any) =>
                    r.result.status === "anchored" ? r.result.range : null,
                ),
            };
        },
        p.file,
        BODY,
        p.pick,
    );
}

async function inspect(file: string): Promise<{ painted: string[]; html: string }> {
    return browser.executeObsidian(({ app }, f) => {
        const obs = app as any;
        let preview: HTMLElement | null = null;
        obs.workspace.iterateAllLeaves((l: any) => {
            if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === f) {
                preview = l.view.containerEl.querySelector(".markdown-preview-view");
            }
        });
        if (!preview) return { painted: [], html: "(no preview)" };
        const painted = Array.from(
            (preview as HTMLElement).querySelectorAll(".mrg-highlight"),
        ).map((h) => (h as HTMLElement).textContent ?? "");
        // Just the rendered content paragraphs, trimmed for readability.
        const html = Array.from((preview as HTMLElement).querySelectorAll("p"))
            .map((p) => (p as HTMLElement).outerHTML)
            .join("\n");
        return { painted, html };
    }, file);
}

describe("exact-case diagnostics", function () {
    for (const p of PROBES) {
        it(`${p.label}`, async function () {
            const s = await setup(p);
            await new Promise((r) => setTimeout(r, 1500)); // let the paint land
            const { painted, html } = await inspect(p.file);
            console.log(`\n=== ${p.label} ===`);
            console.log("foundPick:", s.foundPick, "range:", JSON.stringify(s.range));
            console.log("quote :", JSON.stringify(s.quote));
            console.log("status:", JSON.stringify(s.status));
            console.log("painted:", JSON.stringify(painted));
            console.log("html  :\n" + html);
            expect(s.foundPick).toBe(true);
            expect(s.status).toEqual(["anchored"]);
            // The highlight spans the blank-line break: both bold terms must paint.
            const joined = painted.join(" ").replace(/\s+/g, " ");
            expect(joined).toContain("off notepad");
            expect(joined).toContain("0.5mm mechanical pencil");
        });
    }
});
