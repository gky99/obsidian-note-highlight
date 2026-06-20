/**
 * Regression test for the "one passage, one highlight" rule and the lookups that
 * power the selection toolbar's edit mode (recolor / delete).
 *
 * Drives real Obsidian through `plugin.store`:
 *  - `createHighlight` succeeds over fresh text and over a disjoint range, but is
 *    REFUSED when the new range overlaps an existing highlight (no stacking).
 *  - `annotationAt(from, to)` finds the overlapping highlight (range lookup, used
 *    when the user selects over one) and `getById(id)` finds it by id (used when
 *    the user clicks a painted highlight) — these are what the toolbar resolves
 *    into an edit target.
 *
 * Store writes are async (sidecar write-back → reload), so each step awaits.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "Overlap.md";
const BODY = "# Overlap\n\nThe quick brown fox jumps over the lazy dog.\n";

/** Run the whole scenario inside Obsidian and report the observable outcomes. */
async function runScenario() {
    return browser.executeObsidian(
        async ({ app }, file, body) => {
            const obs = app as any;
            for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                const f = obs.vault.getAbstractFileByPath(p);
                if (f) await obs.vault.delete(f);
            }
            const tfile = await obs.vault.create(file, body);
            await new Promise((r) => setTimeout(r, 300));

            const plugin = obs.plugins.plugins["marginalia"];
            const range = (needle: string) => {
                const from = body.indexOf(needle);
                return { from, to: from + needle.length };
            };

            const fox = range("brown fox");
            const first = await plugin.store.createHighlight(tfile, fox.from, fox.to);

            // Exact same span, and a partial overlap, must both be refused.
            const dupe = await plugin.store.createHighlight(tfile, fox.from, fox.to);
            const partial = range("quick brown");
            const overlapping = await plugin.store.createHighlight(
                tfile,
                partial.from,
                partial.to,
            );

            // A disjoint span is allowed — two highlights can coexist.
            const dog = range("lazy dog");
            const second = await plugin.store.createHighlight(tfile, dog.from, dog.to);

            // Lookups the toolbar uses to find an edit target.
            const byRange = plugin.store.annotationAt(file, partial.from, partial.to);
            const byId = first ? plugin.store.getById(file, first.id) : null;
            const disjoint = range("The quick");
            const noHit = plugin.store.annotationAt(file, disjoint.from, disjoint.to);

            return {
                firstCreated: first?.id ?? null,
                dupeRejected: dupe === null,
                overlapRejected: overlapping === null,
                secondCreated: second?.id ?? null,
                byRangeId: byRange?.annotation?.id ?? null,
                byIdId: byId?.annotation?.id ?? null,
                noHit: noHit ?? null,
                count: plugin.store.getResolved(file).length,
            };
        },
        FILE,
        BODY,
    );
}

describe("highlight overlap guard", function () {
    it("refuses to stack highlights and resolves edit targets", async function () {
        const r = await runScenario();

        expect(r.firstCreated).not.toBeNull();
        expect(r.dupeRejected).toBe(true);
        expect(r.overlapRejected).toBe(true);
        expect(r.secondCreated).not.toBeNull();

        // The overlapping selection / a click both resolve to the first highlight.
        expect(r.byRangeId).toBe(r.firstCreated);
        expect(r.byIdId).toBe(r.firstCreated);
        // A disjoint range matches nothing.
        expect(r.noHit).toBeNull();

        // Only the two disjoint highlights survived.
        expect(r.count).toBe(2);
    });
});
