/**
 * Regression test for structure-preserving sidecar writes.
 *
 * Adding/editing a highlight must NOT rewrite the whole annotation file: any custom
 * content the user added (here a `## My private notes` section) has to survive, and a
 * new highlight's quote unit must land before the trailing `anno` code blocks.
 *
 * Drives real Obsidian: highlight passage 1 (creates the sidecar), inject a custom
 * section into the sidecar on disk, then highlight passage 2 (the in-place patch path).
 * Reads the file back and asserts the custom section is still there.
 *
 * Teeth: revert `store.rmw` to a full `serializeSidecar` rewrite and the custom section
 * vanishes → this test fails (verified neutralize → fail → restore → pass).
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const SRC = "Clips/MrgStructPreserve.md";
const TAG = "MrgStructPreserve";
const BODY = "# Structure preserving\n\nalpha beta gamma delta.\n\nepsilon zeta eta theta.\n";
const CUSTOM = "## My private notes";

async function runScenario() {
    return browser.executeObsidian(
        async ({ app }, src, tag, body, custom) => {
            const obs = app as any;
            // Clean slate by tag (the sidecar location depends on settings).
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

            // 1) First highlight — creates the sidecar (full serialize, no patch yet).
            const f1 = body.indexOf("beta");
            const created1 = await plugin.store.createHighlight(tfile, f1, f1 + "beta".length);
            await new Promise((r) => setTimeout(r, 400));

            // Locate the sidecar by the id it now carries.
            const findSidecar = async () => {
                for (const f of obs.vault.getMarkdownFiles()) {
                    if (!f.path.endsWith(".annotations.md")) continue;
                    const t = await obs.vault.read(f);
                    if (created1 && t.includes(created1.id)) return { f, t };
                }
                return { f: null as any, t: null as string | null };
            };
            const first = await findSidecar();

            // 2) Inject a hand-written section right after the frontmatter.
            const injected = (first.t as string).replace(
                /\n---\n/,
                `\n---\n\n${custom}\n\nThese are my own notes.\n`,
            );
            await obs.vault.modify(first.f, injected);
            await new Promise((r) => setTimeout(r, 400));

            // 3) Second highlight — goes through the in-place patch path.
            const f2 = body.indexOf("epsilon");
            const created2 = await plugin.store.createHighlight(tfile, f2, f2 + "epsilon".length);
            await new Promise((r) => setTimeout(r, 400));

            const after = await findSidecar();
            const text2 = after.t ?? "";

            const result = {
                created1Id: created1?.id ?? null,
                created2Id: created2?.id ?? null,
                hasCustom: text2.includes(custom),
                hasBeta: text2.includes("> beta"),
                hasEpsilon: text2.includes("> epsilon"),
                secondQuoteBeforeAnno:
                    text2.indexOf("> epsilon") >= 0 &&
                    text2.indexOf("> epsilon") < text2.indexOf("```anno"),
                resolvedCount: plugin.store.getResolved(src).length,
                text2,
            };

            if (after.f) await obs.vault.delete(after.f);
            const srcF = obs.vault.getAbstractFileByPath(src);
            if (srcF) await obs.vault.delete(srcF);
            return result;
        },
        SRC,
        TAG,
        BODY,
        CUSTOM,
    );
}

describe("structure-preserving sidecar write", function () {
    it("keeps custom content and inserts the new unit before the anno blocks", async function () {
        const r = await runScenario();

        expect(r.created1Id).not.toBeNull();
        expect(r.created2Id).not.toBeNull();

        // The hand-written section survived the second highlight's write.
        expect(r.hasCustom).toBe(true);

        // Both highlights are present, and the new one's quote sits before the anno blocks.
        expect(r.hasBeta).toBe(true);
        expect(r.hasEpsilon).toBe(true);
        expect(r.secondQuoteBeforeAnno).toBe(true);

        // Both still load.
        expect(r.resolvedCount).toBe(2);
    });
});
