/**
 * Smoke test for the Marginalia e2e playground.
 *
 * This is intentionally NOT a real plugin test suite — it just proves the harness
 * works end to end: a real Obsidian boots with the plugin enabled, and a note from
 * the vault can be opened and read back. Build real specs against this scaffold.
 *
 * Two ways to drive Obsidian are shown:
 *   - `obsidianPage.*` — high-level helpers from the service (openFile, read, ...).
 *   - `browser.executeObsidian(fn, ...args)` — the escape hatch: runs `fn` inside the
 *     Obsidian renderer with the live `{ app, obsidian }` injected. The callback is
 *     serialized and shipped across the wire, so it can't close over variables from
 *     this file — pass data as trailing args and use the injected `obsidian` module.
 */
import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

const NOTE = "Welcome.md";

describe("Marginalia playground", function () {
    it("boots Obsidian with the Marginalia plugin enabled", async function () {
        const enabled = await browser.executeObsidian(({ app }) => {
            // `app.plugins` is an internal API not in the public typings.
            const plugins = (app as unknown as {
                plugins: { enabledPlugins: Set<string> };
            }).plugins;
            return plugins.enabledPlugins.has("marginalia");
        });
        expect(enabled).toBe(true);
    });

    it("opens a note from the vault and makes it the active file", async function () {
        await obsidianPage.openFile(NOTE);

        const activePath = await browser.executeObsidian(
            ({ app }) => app.workspace.getActiveFile()?.path ?? null,
        );
        expect(activePath).toBe(NOTE);
    });

    it("reads the note's content from the vault", async function () {
        const content = await obsidianPage.read(NOTE);
        expect(content).toContain("Welcome to the Marginalia playground");
        expect(content).toContain("The quick brown fox jumps over the lazy dog.");
    });
});
