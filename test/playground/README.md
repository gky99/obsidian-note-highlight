# Marginalia e2e playground

A minimal end-to-end harness that runs the plugin inside a **real Obsidian** using
[`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service)
(WebdriverIO). Unlike the vitest suite (which tests the pure core against stubs), this
boots an actual Obsidian app, enables the built plugin, and drives it.

It is a *playground*, not a test suite — `specs/playground.e2e.ts` is a smoke test that
just opens and reads a note to prove the harness works. Add real specs alongside it.

## Layout

```
test/playground/
├── wdio.conf.mts            # WDIO config (paths resolved absolutely from this file)
├── tsconfig.json           # self-contained; kept out of the root `pnpm typecheck`
├── vault/                  # the test vault opened by Obsidian
│   └── Welcome.md          # the note the smoke test opens + reads
└── specs/
    └── playground.e2e.ts   # smoke test: plugin enabled, open note, read content
```

## Run it

```bash
pnpm build        # REQUIRED: the harness loads the built main.js + manifest.json
pnpm test:e2e     # == wdio run ./test/playground/wdio.conf.mts
```

The first run downloads an Obsidian build into `.obsidian-cache/` (repo root,
gitignored) and is slow; later runs reuse the cache.

## Notes

- **The plugin must be built first.** `wdio:obsidianOptions.plugins` points at the repo
  root, which must contain a current `main.js` + `manifest.json`.
- **Versions.** `browserVersion: "latest"` is the Obsidian *app*; `installerVersion:
  "earliest"` pins the *Electron installer* to the oldest compatible with the plugin's
  `minAppVersion`. Switch `installerVersion` to `"latest"` if an old installer is slow
  or unavailable to download.
- **`executeObsidian(fn, ...args)`** runs `fn` in the Obsidian renderer with the live
  `{ app, obsidian }` injected. The function is serialized — it can't capture local
  variables, so pass them as trailing args and use the injected `obsidian` module.
- Reset vault state between specs with `obsidianPage.resetVault()` (fast) or
  `browser.reloadObsidian({ vault })` (full reboot) — see the service docs.
