/**
 * Regression test for the Live Preview jump flash (§8.1). The reading-mode flash is
 * covered by `jump-flash.e2e.ts`; this covers the *other* mode, which broke silently.
 *
 * In Live Preview the flash is a CM6 mark decoration that wraps the highlight as a
 * separate OUTER span (`.mrg-flash > .mrg-highlight`). An `inset` box-shadow only
 * renders over a background it shares an element with — a child's background paints
 * over a parent's inset shadow — so the flash's accent painted UNDER the inner
 * highlight's translucent tint and read as "no flash". The fix runs the same
 * animation on the inner highlight span too, so the accent paints over the highlight
 * color exactly like reading mode (one span carrying both classes).
 *
 * Teeth: remove the `.mrg-flash .mrg-highlight` selector from styles.css and the
 * inner (visible) highlight span no longer runs the `mrg-flash` animation → fails.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

const FILE = "JumpFlashLP.md";
const BODY = "# Probe\n\nThe quick brown fox jumps over the lazy dog today.\n";
const PICK = "quick brown fox";

describe("jump flash (Live Preview)", function () {
    it("animates the visible highlight surface when jumping in Live Preview", async function () {
        const result = await browser.executeObsidian(
            async ({ app }, file, body, pick) => {
                const obs = app as any;
                const base = file.replace(/\.md$/, "");
                for (const f of obs.vault.getMarkdownFiles()) {
                    if (f.path.includes(".annotations")) {
                        const t = await obs.vault.read(f).catch(() => "");
                        if (t.includes(`[[${base}]]`)) await obs.vault.delete(f).catch(() => {});
                    }
                }
                const stale = obs.vault.getAbstractFileByPath(file);
                if (stale) await obs.vault.delete(stale);
                const tfile = await obs.vault.create(file, body);
                await new Promise((r) => setTimeout(r, 300));

                const plugin = obs.plugins.plugins["marginalia"];
                const from = body.indexOf(pick);
                const anno = await plugin.store.createHighlight(tfile, from, from + pick.length);

                // Open in Live Preview (mode: source, source: false).
                const leaf = obs.workspace.getLeaf(true);
                await leaf.openFile(tfile, { active: true });
                await leaf.setViewState({
                    type: "markdown",
                    state: { file, mode: "source", source: false },
                    active: true,
                });
                await plugin.store.load(tfile);
                await plugin.activateAside(true);
                const aside = obs.workspace.getLeavesOfType("marginalia-aside")[0]?.view;
                await aside.setSourceFile(file);
                await new Promise((r) => setTimeout(r, 400));

                const editorEl = (() => {
                    let el: HTMLElement | null = null;
                    obs.workspace.iterateAllLeaves((l: any) => {
                        if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                            el = l.view.containerEl.querySelector(".cm-editor") ?? l.view.containerEl;
                        }
                    });
                    return el as HTMLElement | null;
                })();

                const editorMode = (() => {
                    let m = "?";
                    obs.workspace.iterateAllLeaves((l: any) => {
                        if (l.view?.getViewType?.() === "markdown" && l.view.file?.path === file) {
                            m = l.view.getMode?.() ?? "?";
                        }
                    });
                    return m;
                })();

                // Jump (source branch → flash(cm, from, to)).
                await aside.deps.jumpTo(file, anno?.id);

                // Poll during the ~1.67s window: the flash decoration must be applied
                // (outer span) AND reach the visible surface (the `.mrg-highlight` span
                // that carries the background must itself run the `mrg-flash` animation).
                let sawFlashSpan = false;
                let visibleSurfaceFlashed = false;
                for (let i = 0; i < 18; i++) {
                    if (editorEl?.querySelector(".mrg-flash")) sawFlashSpan = true;
                    const hl = editorEl?.querySelector(".mrg-highlight") as HTMLElement | null;
                    if (hl) {
                        const names = getComputedStyle(hl).animationName.split(",").map((s) => s.trim());
                        if (names.includes("mrg-flash")) {
                            visibleSurfaceFlashed = true;
                            break;
                        }
                    }
                    await new Promise((r) => setTimeout(r, 80));
                }

                // Clean up so this spec leaves no residue for the next one (a shared
                // Obsidian instance; an extra open leaf / note can race the next
                // spec's reading-mode paint). Detach the leaf we opened, delete files.
                try {
                    leaf.detach();
                } catch {
                    /* ignore */
                }
                for (const p of [file, file.replace(/\.md$/, ".annotations.md")]) {
                    const f = obs.vault.getAbstractFileByPath(p);
                    if (f) await obs.vault.delete(f).catch(() => {});
                }

                return { annoId: anno?.id, editorMode, sawFlashSpan, visibleSurfaceFlashed };
            },
            FILE,
            BODY,
            PICK,
        );

        expect(result.annoId).toBeTruthy();
        expect(result.editorMode).toBe("source");
        expect(result.sawFlashSpan).toBe(true);
        expect(result.visibleSurfaceFlashed).toBe(true);
    });
});
