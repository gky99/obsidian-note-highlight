/**
 * Regression test for the frontmatter-anchoring bug (Design.md §6.5).
 *
 * A web clip's YAML `title` duplicates its H1, so the quote occurs once in the
 * frontmatter and once in the body. A record whose stored context points at the
 * frontmatter (as the reading-mode/import locators used to capture, first-
 * occurrence-wins) anchored *into* the frontmatter — where Live Preview renders
 * the Properties widget and the highlight silently vanished, even though reading
 * mode's best-effort painter found the body copy.
 *
 * This drives real Obsidian: it builds exactly that corrupt sidecar (status
 * `exact`, frontmatter-pointing before/after), opens the note in Live Preview,
 * and asserts the highlight re-anchors to the **body** H1 (the §6.5 recovery
 * branch) and actually paints there. Neutralizing the resolver's frontmatter
 * exclusion re-anchors it into the frontmatter → the body-offset assertion fails.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "FrontmatterDup.md";
const QUOTE = "Zonk Widget Manual";
// The YAML `title` repeats the H1, so QUOTE appears twice (frontmatter + body).
const BODY = [
    "---",
    `title: "${QUOTE}"`,
    'source: "https://example.com/x"',
    "---",
    `# ${QUOTE}`,
    "",
    "A body paragraph mentioning nothing special here.",
    "",
].join("\n");

/** Build the note + a sidecar whose context points at the frontmatter title. */
async function setup() {
    return browser.executeObsidian(
        async ({ app }, file, body, quote) => {
            const obs = app as any;
            const sidecarPath = file.replace(/\.md$/, ".annotations.md");
            for (const p of [file, sidecarPath]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 300));

            const plugin = obs.plugins.plugins["marginalia"];
            // Highlight the BODY H1 occurrence (the second one in the file).
            const from = body.indexOf(quote, body.indexOf(quote) + 1);
            const to = from + quote.length;
            await plugin.store.createHighlight(tfile, from, to);

            // Corrupt the record to mimic a reading-mode/import capture that landed
            // on the frontmatter: status `exact`, before/after from the YAML title.
            const scFile = obs.vault.getAbstractFileByPath(sidecarPath);
            let txt: string = await obs.vault.read(scFile);
            txt = txt
                .replace(/^before: .*$/m, "before: '--- title: \"'")
                .replace(/^after: .*$/m, "after: '\" source'")
                .replace(/^status: .*$/m, "status: exact");
            await obs.vault.modify(scFile, txt);

            // Cold start: forget store + detach leaves, open in Live Preview.
            plugin.store.forget(file);
            obs.workspace.detachLeavesOfType("markdown");
            const leaf = obs.workspace.getLeaf(true);
            await leaf.openFile(tfile, { active: true });
            await leaf.setViewState({
                type: "markdown",
                state: { file, mode: "source", source: false }, // Live Preview
                active: true,
            });
            await plugin.store.load(tfile);

            const resolved = plugin.store.getResolved(file);
            const r = resolved[0]?.result;
            return {
                bodyOffset: from, // where it SHOULD anchor (the H1)
                status: r?.status ?? null,
                rangeFrom: r?.status === "anchored" ? r.range.from : null,
            };
        },
        FILE,
        BODY,
        QUOTE,
    );
}

/** Painted highlight texts in the Live Preview (CM6) editor for the file. */
async function paintedInEditor(file: string): Promise<string[]> {
    return browser.executeObsidian(({ app }, f) => {
        const obs = app as any;
        let editor: HTMLElement | null = null;
        obs.workspace.iterateAllLeaves((l: any) => {
            if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === f) {
                editor = l.view.containerEl.querySelector(".cm-content");
            }
        });
        if (!editor) return [];
        return Array.from(
            (editor as HTMLElement).querySelectorAll(".mrg-highlight"),
        ).map((h) => (h as HTMLElement).textContent ?? "");
    }, file);
}

describe("frontmatter-dup highlight in Live Preview", function () {
    it("re-anchors to the body H1, not the frontmatter, and paints", async function () {
        const s = await setup();

        // The §6.5 recovery branch: anchored in the BODY, never the frontmatter.
        expect(s.status).toBe("anchored");
        expect(s.rangeFrom).toBe(s.bodyOffset);

        // And it actually paints in the Live Preview editor (not the Properties widget).
        await browser.waitUntil(
            async () => {
                const painted = await paintedInEditor(FILE);
                return painted.some((t) => t.includes(QUOTE));
            },
            {
                timeout: 8000,
                interval: 250,
                timeoutMsg: "highlight never painted on the body H1 in Live Preview",
            },
        );
    });
});
