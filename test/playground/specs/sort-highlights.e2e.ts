/**
 * Regression test for the "Sort highlights in annotation file" command.
 *
 * Highlights two passages in *reverse* reading order (the later one first), so the
 * sidecar's on-disk order is creation order, then runs the sort and asserts the
 * units are now in source reading order.
 *
 * Teeth are inherent: the before-order (later-first) and after-order (earlier-first)
 * differ, so the test fails if the sort does nothing.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const SRC = "Clips/MrgSortHighlights.md";
const TAG = "MrgSortHighlights";
const BODY = "# Heading\n\nalpha is the early passage.\n\nzeta is the late passage.\n";

async function runScenario() {
    return browser.executeObsidian(
        async ({ app }, src, tag, body) => {
            const obs = app as any;
            for (const f of obs.vault.getMarkdownFiles()) {
                if (f.path.endsWith(".annotations.md")) {
                    const t = await obs.vault.read(f);
                    if (t.includes(tag)) await obs.vault.delete(f);
                }
            }
            const stale = obs.vault.getAbstractFileByPath(src);
            if (stale) await obs.vault.delete(stale);

            const folder = src.slice(0, src.lastIndexOf("/"));
            if (folder && !obs.vault.getAbstractFileByPath(folder)) {
                await obs.vault.createFolder(folder).catch(() => {});
            }
            const tfile = await obs.vault.create(src, body);
            await new Promise((r) => setTimeout(r, 400));

            const plugin = obs.plugins.plugins["marginalia"];

            // Highlight the LATER passage first, then the EARLIER one → sidecar is in
            // creation order (zeta, then alpha).
            const zf = body.indexOf("zeta");
            const z = await plugin.store.createHighlight(tfile, zf, zf + "zeta".length);
            await new Promise((r) => setTimeout(r, 300));
            const af = body.indexOf("alpha");
            const a = await plugin.store.createHighlight(tfile, af, af + "alpha".length);
            await new Promise((r) => setTimeout(r, 300));

            const findSidecar = async () => {
                for (const f of obs.vault.getMarkdownFiles()) {
                    if (!f.path.endsWith(".annotations.md")) continue;
                    const t = await obs.vault.read(f);
                    if (z && t.includes(z.id)) return t as string;
                }
                return "";
            };

            const before = await findSidecar();
            await plugin.store.sortBySourcePosition(tfile);
            await new Promise((r) => setTimeout(r, 300));
            const after = await findSidecar();

            const result = {
                beforeZetaFirst: before.indexOf("> zeta") < before.indexOf("> alpha"),
                afterAlphaFirst: after.indexOf("> alpha") < after.indexOf("> zeta"),
                bothPresentAfter: after.includes("> alpha") && after.includes("> zeta"),
                createdBoth: !!a && !!z,
            };

            for (const f of obs.vault.getMarkdownFiles()) {
                if (f.path.endsWith(".annotations.md")) {
                    const t = await obs.vault.read(f);
                    if (t.includes(tag)) await obs.vault.delete(f);
                }
            }
            const srcF = obs.vault.getAbstractFileByPath(src);
            if (srcF) await obs.vault.delete(srcF);
            return result;
        },
        SRC,
        TAG,
        BODY,
    );
}

describe("sort highlights command", function () {
    it("reorders the annotation file into source reading order", async function () {
        const r = await runScenario();
        expect(r.createdBoth).toBe(true);
        // Before sorting: creation order (zeta highlighted first).
        expect(r.beforeZetaFirst).toBe(true);
        // After sorting: source reading order (alpha precedes zeta).
        expect(r.afterAlphaFirst).toBe(true);
        expect(r.bothPresentAfter).toBe(true);
    });
});
