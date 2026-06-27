/**
 * End-to-end coverage for the "don't highlight inside an annotation file"
 * safeguard on real Obsidian.
 *
 * A highlight created inside a sidecar would annotate the sidecar itself — a
 * sidecar-of-a-sidecar — and its painted marks would collide with the panel for
 * the note the sidecar actually annotates. So highlighting must be refused there.
 *
 * The guard lives at the single choke point `main#highlightRange`, which BOTH
 * interactive create paths funnel through (the floating toolbar's `highlightRequest`
 * and the `Highlight selection` command). This drives that method directly against a
 * real sidecar and asserts no nested annotation file is born. It also checks the
 * `isAnnotationFile` predicate the toolbar shares to stay hidden in a sidecar.
 *
 * Teeth: neutralize the `isAnnotationFile` guard in `highlightRange` (rebuild) and
 * `nestedAfter` flips to 1 — the safeguard is doing the work, not luck.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const SRC = "SafeguardSrc.md";
const SRC_BODY = "# T\n\nThe quick brown fox jumps over the lazy dog.\n";

async function run() {
    return browser.executeObsidian(async ({ app }, src, srcBody) => {
        const obs = app as any;
        const plugin = obs.plugins.plugins["marginalia"];
        const srcBase = src.replace(/\.md$/, "");

        // Annotation files (now or after) whose `annotates` resolves to `targetPath`.
        const sidecarsOf = async (targetPath: string): Promise<string[]> => {
            const out: string[] = [];
            for (const f of obs.vault.getMarkdownFiles()) {
                if (f.path === targetPath) continue;
                if (plugin.resolveSourcePath(f.path) === targetPath) out.push(f.path);
            }
            return out;
        };

        // --- clean slate: drop the source + anything annotating it (or its sidecar)
        const wipe = async (paths: string[]) => {
            for (const p of paths) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f).catch(() => {});
            }
        };
        const staleSrc = obs.vault.getAbstractFileByPath(src);
        if (staleSrc) {
            await wipe(await sidecarsOf(src));
            await obs.vault.delete(staleSrc).catch(() => {});
        }

        // --- create the source note and a real highlight → a real sidecar is born
        const srcFile = await obs.vault.create(src, srcBody);
        await new Promise((r) => setTimeout(r, 400));
        const qFrom = srcBody.indexOf("quick brown fox");
        await plugin.store.createHighlight(srcFile, qFrom, qFrom + "quick brown fox".length);
        await new Promise((r) => setTimeout(r, 400));

        const sidecarPaths = await sidecarsOf(src);
        const sidecarPath = sidecarPaths[0] ?? null;
        if (!sidecarPath) return { error: "no sidecar created", sidecarLink: `[[${srcBase}]]` };
        const sidecar = obs.vault.getAbstractFileByPath(sidecarPath);

        // --- predicate sanity: source is not an annotation file, the sidecar is
        const srcIsAnno = plugin.isAnnotationFile(srcFile);
        const sidecarIsAnno = plugin.isAnnotationFile(sidecar);

        // --- the guard: highlight a real range INSIDE the sidecar → must be refused
        const sidecarText = await obs.vault.read(sidecar);
        const hFrom = sidecarText.indexOf("quick");
        const nestedBefore = (await sidecarsOf(sidecarPath)).length;
        // Direct call to the shared choke point (private at compile time, callable
        // at runtime); both the toolbar and the command reach it the same way.
        await plugin.highlightRange(sidecar, hFrom, hFrom + "quick".length);
        await new Promise((r) => setTimeout(r, 400));
        const nestedAfter = (await sidecarsOf(sidecarPath)).length;

        return {
            error: null,
            srcIsAnno,
            sidecarIsAnno,
            foundRange: hFrom >= 0,
            nestedBefore,
            nestedAfter,
        };
    }, SRC, SRC_BODY);
}

describe("annotation-file highlight safeguard on real Obsidian", function () {
    it("refuses to highlight inside a sidecar (no sidecar-of-a-sidecar)", async function () {
        const r = await run();
        expect(r.error).toBe(null);
        expect(r.srcIsAnno).toBe(false); // a normal note is highlightable
        expect(r.sidecarIsAnno).toBe(true); // the sidecar is recognized as an annotation file
        expect(r.foundRange).toBe(true); // the range we tried to highlight is real text
        expect(r.nestedBefore).toBe(0);
        expect(r.nestedAfter).toBe(0); // ← the guard held: nothing was written to the sidecar
    });
});
