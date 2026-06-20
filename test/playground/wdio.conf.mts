/**
 * WebdriverIO config for the Marginalia end-to-end playground.
 *
 * This drives a *real* Obsidian instance via `wdio-obsidian-service`: the service
 * downloads an Obsidian build, opens the vault under `./vault`, installs + enables
 * the plugin from the repo root (which must contain a built `main.js` + `manifest.json`
 * — run `pnpm build` first), and runs the specs in `./specs`.
 *
 * Paths are resolved absolutely from this file's location, so the config works no
 * matter what cwd `wdio run` is invoked from.
 *
 * Run:  pnpm test:e2e   (== wdio run ./test/playground/wdio.conf.mts)
 */
import * as path from "node:path";

const here = import.meta.dirname;
// The plugin under test lives at the repo root (built main.js + manifest.json).
const pluginDir = path.resolve(here, "..", "..");

export const config: WebdriverIO.Config = {
    runner: "local",
    framework: "mocha",

    specs: [path.join(here, "specs", "**", "*.e2e.ts")],

    // One Obsidian instance is plenty for the playground.
    maxInstances: 1,

    capabilities: [
        {
            browserName: "obsidian",
            // The Obsidian *app* (JS bundle) version to download and run.
            browserVersion: "latest",
            "wdio:obsidianOptions": {
                // The Obsidian *installer* (Electron) version. "earliest" pins it to the
                // oldest installer compatible with the plugin's `minAppVersion`, which is
                // the best way to catch Electron-version regressions. Use "latest" if a
                // first run struggles to download an old installer.
                installerVersion: "earliest",
                // Load the plugin from the repo root. The dir must contain a built
                // main.js + manifest.json (run `pnpm build`).
                plugins: [pluginDir],
                // The vault to open. A bare directory of notes is a valid vault;
                // Obsidian generates default `.obsidian` config on first open.
                vault: path.join(here, "vault"),
            },
        },
    ],

    services: ["obsidian"],
    // `wdio-obsidian-reporter` wraps spec-reporter to print the Obsidian version
    // instead of the underlying Chromium version.
    reporters: ["obsidian"],

    // Downloaded Obsidian binaries are cached here (gitignored). First run is slow.
    cacheDir: path.resolve(pluginDir, ".obsidian-cache"),

    // Import browser/expect/describe/it explicitly in specs (see specs/*.e2e.ts).
    injectGlobals: false,

    logLevel: "warn",

    mochaOpts: {
        ui: "bdd",
        timeout: 60_000,
    },
};
