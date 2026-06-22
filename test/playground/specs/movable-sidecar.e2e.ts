/**
 * Regression test for `annotates`-based identity (Design.md §4.1): an annotation file
 * belongs to whatever clip its `annotates` link resolves to — *not* its name or folder.
 *
 *  1. A highlighted clip gets a sidecar at the default location.
 *  2. Moving that sidecar into a different folder does **not** lose it — the highlight
 *     still resolves (location-independent lookup).
 *  3. A second highlight lands in the *moved* file; no new canonical file is created.
 *  4. The collision modal's "Continue" now **overrides the link**: highlighting a
 *     same-basename sibling clip (folder mode) takes over the existing file for the
 *     sibling — its `annotates` flips, detaching the original clip.
 *
 * Drives real Obsidian through `plugin.store`; store writes are async, so each step waits.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

async function runMovability() {
    return browser.executeObsidian(async ({ app }) => {
        const obs = app as any;
        const TAG = "MrgMovable";
        const SRC = "Clips/MrgMovable.md";
        const BODY = "# Movable\n\nThe quick brown fox jumps over the lazy dog near the river.\n";
        const MOVED = "Moved/MrgMovable.relocated.md";

        // Clean slate — find prior artefacts by the unique tag (location-agnostic).
        for (const f of obs.vault.getMarkdownFiles()) {
            const t = await obs.vault.read(f).catch(() => "");
            if (t.includes(TAG) && f.path !== SRC) await obs.vault.delete(f).catch(() => {});
        }
        for (const p of [SRC, MOVED]) {
            const stale = obs.vault.getAbstractFileByPath(p);
            if (stale) await obs.vault.delete(stale);
        }
        for (const dir of ["Clips", "Moved"]) {
            if (!obs.vault.getAbstractFileByPath(dir)) await obs.vault.createFolder(dir).catch(() => {});
        }

        const plugin = obs.plugins.plugins["marginalia"];
        const savedFolder = plugin.store.settings.sidecarFolder;
        plugin.store.settings.sidecarFolder = ""; // alongside mode for this scenario

        const tfile = await obs.vault.create(SRC, BODY);
        await new Promise((r) => setTimeout(r, 400));

        // (1) First highlight → sidecar at the default (alongside) location.
        const from1 = BODY.indexOf("brown fox");
        const a1 = await plugin.store.createHighlight(tfile, from1, from1 + "brown fox".length);
        await new Promise((r) => setTimeout(r, 400));
        const countAfterCreate = plugin.store.getResolved(SRC).length;

        // Find the sidecar by the id it carries.
        const findSidecar = async () => {
            for (const f of obs.vault.getMarkdownFiles()) {
                if (!f.path.endsWith(".annotations.md")) continue;
                const t = await obs.vault.read(f);
                if (a1 && t.includes(a1.id)) return f;
            }
            return null;
        };
        const original = await findSidecar();

        // (2) Move the sidecar into an unrelated folder, then reload.
        await obs.vault.rename(original, MOVED);
        await new Promise((r) => setTimeout(r, 600));
        await plugin.store.load(tfile);
        await new Promise((r) => setTimeout(r, 200));
        const countAfterMove = plugin.store.getResolved(SRC).length;
        const movedExists = obs.vault.getAbstractFileByPath(MOVED) != null;

        // (3) Second highlight → must land in the moved file; no new sidecar appears.
        const from2 = BODY.indexOf("lazy dog");
        await plugin.store.createHighlight(tfile, from2, from2 + "lazy dog".length);
        await new Promise((r) => setTimeout(r, 400));
        const countAfterSecond = plugin.store.getResolved(SRC).length;
        // Count annotation files for this clip by content tag — the moved file is no
        // longer `*.annotations.md`-named, and a path-based write would have spawned a
        // second (canonical) one. The source body itself does not contain TAG.
        let sidecarCount = 0;
        for (const f of obs.vault.getMarkdownFiles()) {
            if (f.path === SRC) continue;
            const t = await obs.vault.read(f).catch(() => "");
            if (t.includes(TAG)) sidecarCount++;
        }
        const movedText = await obs.vault.read(obs.vault.getAbstractFileByPath(MOVED));

        // Tidy up + restore the setting so later specs aren't affected.
        plugin.store.settings.sidecarFolder = savedFolder;
        for (const p of [MOVED, SRC]) {
            const f = obs.vault.getAbstractFileByPath(p);
            if (f) await obs.vault.delete(f);
        }

        return {
            createdId: a1?.id ?? null,
            countAfterCreate,
            countAfterMove,
            movedExists,
            countAfterSecond,
            sidecarCount,
            movedHasBothIds: !!a1 && movedText.includes(a1.id),
        };
    });
}

async function runOverrideLink() {
    return browser.executeObsidian(async ({ app }) => {
        const obs = app as any;
        const TAG = "MrgOverride";
        const A = "AA/MrgOverride.md";
        const B = "BB/MrgOverride.md"; // same basename, different folder → canonical clash
        const BODY = "# Override\n\nThe quick brown fox jumps over the lazy dog by the bank.\n";
        const FOLDER = "_mrg_anno";

        // Clean slate.
        for (const f of obs.vault.getMarkdownFiles()) {
            const t = await obs.vault.read(f).catch(() => "");
            if (t.includes(TAG)) await obs.vault.delete(f).catch(() => {});
        }
        for (const dir of ["AA", "BB", FOLDER]) {
            if (!obs.vault.getAbstractFileByPath(dir)) await obs.vault.createFolder(dir).catch(() => {});
        }

        const plugin = obs.plugins.plugins["marginalia"];
        const savedFolder = plugin.store.settings.sidecarFolder;
        const savedOnCollision = plugin.store.onCollision;
        plugin.store.settings.sidecarFolder = FOLDER; // folder mode → flat by basename

        const fa = await obs.vault.create(A, BODY);
        const fb = await obs.vault.create(B, BODY); // copy → the kept old mark will anchor
        await new Promise((r) => setTimeout(r, 500));

        // Highlight A first → owns `_mrg_anno/MrgOverride.annotations.md`.
        const fromA = BODY.indexOf("brown fox");
        const aMark = await plugin.store.createHighlight(fa, fromA, fromA + "brown fox".length);
        await new Promise((r) => setTimeout(r, 400));

        // Highlight B with onCollision → 'continue' (override the link).
        plugin.store.onCollision = async () => "continue";
        const fromB = BODY.indexOf("lazy dog");
        await plugin.store.createHighlight(fb, fromB, fromB + "lazy dog".length);
        await new Promise((r) => setTimeout(r, 400));

        await plugin.store.load(fa);
        await plugin.store.load(fb);
        await new Promise((r) => setTimeout(r, 200));

        const sidecarPath = `${FOLDER}/MrgOverride.annotations.md`;
        const sidecarFile = obs.vault.getAbstractFileByPath(sidecarPath);
        const sidecarText = sidecarFile ? await obs.vault.read(sidecarFile) : "";
        const m = sidecarText.match(/^annotates:\s*(.+)$/m);
        const annotates = m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
        const inner = annotates.replace(/^\[\[/, "").replace(/\]\]$/, "");
        const dest = sidecarFile ? obs.metadataCache.getFirstLinkpathDest(inner, sidecarFile.path) : null;

        const result = {
            countA: plugin.store.getResolved(A).length, // detached → 0
            countB: plugin.store.getResolved(B).length, // old (re-anchored) + new → 2
            annotatesResolvesTo: dest?.path ?? null, // → B
            keptOldMark: !!aMark && sidecarText.includes(aMark.id),
        };

        // Restore settings + tidy up.
        plugin.store.settings.sidecarFolder = savedFolder;
        plugin.store.onCollision = savedOnCollision;
        for (const p of [sidecarPath, A, B]) {
            const f = obs.vault.getAbstractFileByPath(p);
            if (f) await obs.vault.delete(f);
        }
        return result;
    });
}

describe("movable sidecars (annotates-based identity)", function () {
    it("finds a sidecar after it is moved, and writes new highlights into the moved file", async function () {
        const r = await runMovability();
        expect(r.createdId).not.toBeNull();
        expect(r.countAfterCreate).toBe(1);
        // (2) Located after the move — identity is the link, not the path.
        expect(r.movedExists).toBe(true);
        expect(r.countAfterMove).toBe(1);
        // (3) Second highlight went into the moved file; no second sidecar was spawned.
        expect(r.countAfterSecond).toBe(2);
        expect(r.sidecarCount).toBe(1);
        expect(r.movedHasBothIds).toBe(true);
    });

    it("Continue overrides the link: a sibling clip takes over the file, detaching the original", async function () {
        const r = await runOverrideLink();
        expect(r.annotatesResolvesTo).toBe("BB/MrgOverride.md");
        expect(r.countA).toBe(0); // original detached
        expect(r.countB).toBe(2); // kept old mark (re-anchored) + the new one
        expect(r.keptOldMark).toBe(true);
    });
});
