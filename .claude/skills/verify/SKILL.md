---
name: verify
description: How to build, run, and drive Golemine to verify changes at runtime.
---

# Verifying Golemine at runtime

Golemine is a Chrome-only offline SPA (Vite + React). Verify against the
**production build** when service-worker/precache behavior matters; dev mode
(`pnpm dev`) skips the SW.

## Build + serve

```sh
pnpm build                 # emits dist/ including sw.js precache manifest
pnpm preview --port 4173 --strictPort   # serves dist/ at http://127.0.0.1:4173
```

## Drive it

Use Playwright's Chromium directly (already a devDependency; browsers are
installed for the e2e suite). From a scratch script, resolve it through the
repo: `createRequire("D:/src/golemine/package.json")("@playwright/test")`.

Useful controls that map to this app's feature set:

- Theme matrix: click the top-bar buttons (`Use light theme` / `Use dark theme`
  / `Use system theme`) and combine with `page.emulateMedia({ colorScheme })`.
  The manual-override guard specifically exists for manual-light + OS-dark.
- Print rules: `page.emulateMedia({ media: "print" })`, then read computed
  styles (`.golemine-illustration` display, `[data-illustrated-section]`).
- Drag/drop overlay: `page.dispatchEvent('[data-backup-drop-target]',
  'dragover' | 'dragleave')` — no DataTransfer needed for the visual state.
- Offline: wait for `navigator.serviceWorker.ready` + ~2s for precache fill,
  then `context.setOffline(true)` and navigate; assets must come from the
  workbox precache (`caches.keys()` → `workbox-precache-v2-...`).
- Capability gate: `context.addInitScript(() => { delete
  window.showDirectoryPicker; })` before load renders the unsupported-browser
  screen in a real Chromium.

## Gotchas

- The Claude Browser pane tab can report `document.visibilityState ===
  "hidden"`; Chromium then defers all `loading="lazy"` images and screenshots
  time out. If that happens, drive with a scripted Playwright Chromium instead.
- Ingest/backup flows need the synthetic fixtures under
  `e2e/fixtures/generated/` (see `e2e/fixtures/generate-fixtures.mjs`).
- Leave no `.claude/launch.json` or scratch scripts in the repo when done.
