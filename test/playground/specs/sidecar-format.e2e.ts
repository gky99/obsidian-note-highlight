/**
 * Regression test for the sidecar frontmatter format (Design.md §5.2/§5.3):
 *  - `annotation_schema` is a bare **number** (renamed from the string `schema`).
 *  - `annotates` is a **wikilink** `[[path]]` with the `.md` dropped — stored as a link
 *    (not a bare path) so Obsidian keeps it pointing at the source across a move/rename.
 *
 * Drives real Obsidian through `plugin.store.createHighlight`, then reads the sidecar back
 * off disk and asserts the on-disk shape. It also resolves the written wikilink through the
 * metadata cache the same way `resolveAnnotates` does, proving the link points at the source.
 *
 * Store writes are async (sidecar write-back → reload), so the scenario awaits each step.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

// A unique basename so the scan-based cleanup/lookup below can't hit other notes. The
// source lives in a subfolder so the wikilink exercises a real path (with the `.md` dropped).
const SRC = "Clips/MrgWikilinkFmt.md";
const TAG = "MrgWikilinkFmt";
const BODY = "# Wikilink format\n\nThe quick brown fox jumps over the lazy dog.\n";

async function runScenario() {
    return browser.executeObsidian(
        async ({ app }, src, tag, body) => {
            const obs = app as any;
            // Clean slate — the sidecar's location depends on settings (it may be a custom
            // folder), so find prior artefacts by the unique tag rather than a fixed path.
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
            const from = body.indexOf("brown fox");
            const created = await plugin.store.createHighlight(
                tfile,
                from,
                from + "brown fox".length,
            );
            await new Promise((r) => setTimeout(r, 400));

            // Locate the sidecar by the highlight id it now carries (settings-agnostic).
            let sidecarFile: any = null;
            let text: string | null = null;
            for (const f of obs.vault.getMarkdownFiles()) {
                if (!f.path.endsWith(".annotations.md")) continue;
                const t = await obs.vault.read(f);
                if (created && t.includes(created.id)) {
                    sidecarFile = f;
                    text = t;
                    break;
                }
            }

            // Pull `annotates` straight from the file text (no dependency on the sidecar
            // being indexed yet), strip YAML quoting, then resolve it the way the plugin
            // does — `getFirstLinkpathDest` is exactly what `resolveAnnotates` calls.
            const m = text ? text.match(/^annotates:\s*(.+)$/m) : null;
            const annotates = m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
            const inner = annotates.replace(/^\[\[/, "").replace(/\]\]$/, "");
            const dest = sidecarFile
                ? obs.metadataCache.getFirstLinkpathDest(inner, sidecarFile.path)
                : null;

            const result = {
                createdId: created?.id ?? null,
                text,
                annotates,
                resolvesToSource: dest?.path ?? null,
                resolvedCount: plugin.store.getResolved(src).length,
            };

            // Tidy up so re-runs start clean.
            if (sidecarFile) await obs.vault.delete(sidecarFile);
            const srcF = obs.vault.getAbstractFileByPath(src);
            if (srcF) await obs.vault.delete(srcF);

            return result;
        },
        SRC,
        TAG,
        BODY,
    );
}

describe("sidecar frontmatter format", function () {
    it("writes a numeric annotation_schema and a wikilink annotates that resolves to the source", async function () {
        const r = await runScenario();

        expect(r.createdId).not.toBeNull();

        // `annotation_schema` is a bare number, not the old `schema: webclip-annotations/1`.
        expect(r.text).toContain("annotation_schema: 1");
        expect(r.text).not.toContain("webclip-annotations");
        expect(r.text).not.toMatch(/^schema:/m);

        // `annotates` is a wikilink with the `.md` dropped …
        expect(r.annotates).toBe("[[Clips/MrgWikilinkFmt]]");
        // … and it resolves back to the real source note (the move-survival mechanism).
        expect(r.resolvesToSource).toBe(SRC);

        // The new format still loads — the highlight round-trips through the store.
        expect(r.resolvedCount).toBe(1);
    });
});
