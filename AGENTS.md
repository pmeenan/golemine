# Golemine : Phone backup data extraction and exploration.

Browser-based tooling for exploring phone backups (iPhone and Android). Chrome-only,
fully offline SPA; iPhone Messages first. This file is long-term project memory and
the rulebook for agents.

The name is **Golem + Mine** (NOT "gold mine"): a **mechanical** golem/automaton in
the vein of Talos, the bronze automaton — not a clay golem — that mines through backup
data and extracts the interesting bits. The web workers are the golem's working parts;
the theme informs naming and design language (warm gold/bronze accent = the automaton's
metal and the ore it surfaces; no clay/terracotta styling).

## Workflow (mandatory)

- **Start:** read `docs/Architecture.md` and `docs/Plan.md`. For iOS parsing work also
  read `docs/iOS-Backup-Format.md`. For any UI work also read `docs/Design.md`.
- **Terminal:** on Windows, run terminal commands with PowerShell 7 (`pwsh`) by default,
  not Windows PowerShell 5.1 (`powershell`), so UTF-8 output stays readable. Use
  Windows PowerShell only when a task specifically requires it, and note why.
- **End:** update `README.md`, `docs/Plan.md` (check off / add tasks and the status
  line), `docs/Architecture.md` (if structure changed), `docs/Decisions.md` (if a
  decision was made), and `AGENTS.md` (this file) with anything future agents must know.
- **Hygiene:** delete any throw-away diagnostic scripts, `.log` files, and scratch
  outputs from the repo root before concluding. Do **not** delete generated build/test
  output directories such as `dist/` or `test-results/`; they are ignored by git and
  useful for local review.
- **Encoding:** keep all project text files UTF-8 clean. Preserve UTF-8 when editing,
  avoid tools/settings that write mojibake, and fix accidental replacement characters
  or mis-decoded punctuation before concluding.
- **No Automatic Commits:** Never automatically commit or push changes to this project.
  All changes must be left in the workspace and will be manually reviewed before being
  committed.

## Hard rules

1. **Privacy is absolute.** No network requests carrying user data, ever. No analytics,
   telemetry, or CDN-loaded code. After first load the app must work fully offline.
2. **Never modify source backups.** All access to the user's backup folder is
   read-only. Derived data goes to OPFS and must always be rebuildable from source.
3. **The UI thread does UI only.** Parsing, SQL, crypto, hashing, and media decoding
   run in web workers. Nothing may block the main thread beyond ~16 ms. Long
   operations stream progress.
4. **Backup content is hostile input.** Never interpolate backup strings into
   HTML/SQL. Parsers (plist, typedstream, keybag) must tolerate malformed input:
   skip and report, never crash ingest.
5. **Licensing:** project is Apache-2.0. Dependencies must be MIT/BSD/Apache/ISC/zlib.
   Sole exception: LGPL is permitted only for unmodified, dynamically-loaded wasm
   codec modules (libheif, ffmpeg core), recorded in NOTICE. No GPL/AGPL, no
   copyleft in app code. Check the license of every new dependency before adding it.
6. **No real personal data in the repo.** Test fixtures are synthetic backups only.
7. **Chrome-only is a feature.** Use Chrome APIs (File System Access, OPFS,
   `getAsFileSystemHandle`, WebCodecs) freely; do not add cross-browser fallbacks.
   Unsupported browsers are handled by the boot-time capability gate
   (`src/lib/capabilities.ts`, M1): when you take a dependency on a new
   browser-specific API that the app cannot function without, add its feature probe
   to the gate (sniff the capability, never the user-agent string). APIs with a
   graceful in-app fallback (e.g. WebCodecs → poster frame) stay out of the gate.
8. **Provider quirks stay in providers.** Everything above ingest works on the
   normalized model (Architecture §5); no Apple-isms leak into UI or db layers.
9. **Provenance is sacred.** Keep source GUIDs, row ids, raw timestamps, and hashes
   flowing through the pipeline — reports depend on them (Architecture §8).
10. **TypeScript strict; no `any` escapes without a comment stating why.** Unit tests
    for every parser (golden files); Playwright for user flows.
11. **The design system is law.** All UI follows `docs/Design.md`: semantic tokens only
    (no hardcoded colors/sizes/durations), every screen works in light AND dark theme,
    and the "definition of done" checklist in Design.md §11 applies to all UI work.
    Extend Design.md when a new pattern is needed — don't improvise one-offs.
12. **UTF-8 is mandatory.** Documentation, source, fixtures, and generated text
    checked into the repo must be valid UTF-8. Do not introduce mojibake; if a terminal
    displays garbled punctuation, verify the file bytes before editing and preserve the
    existing encoding.

## Key technical anchors (details in docs/)

- Stack: React 19 + TS + Vite; zustand; react-router; Tailwind + shadcn/ui;
  react-virtuoso; Comlink for worker RPC; `@sqlite.org/sqlite-wasm` with
  **opfs-sahpool** VFS (no COOP/COEP — do not introduce SharedArrayBuffer deps, D-008).
- Package manager: pnpm. CI runs on pull requests for lint, typecheck, unit tests,
  Playwright Chromium e2e, and license audit.
- M0 guardrails live in `e2e/m0.spec.ts`; fixture conventions live in
  `e2e/fixtures/fixtures.json` plus `e2e/fixtures/generate-fixtures.mjs`. Keep all
  fixture data synthetic and regenerable.
- Static-host security headers live in `public/_headers`, and the pre-paint theme
  bootstrap lives in `public/theme-init.js`. Do not reintroduce a CSP meta tag in
  `index.html`; it breaks dev mode and cannot enforce `frame-ancestors`. The e2e suite
  replays the `_headers` CSP via Playwright header injection (D-013), so policy edits
  are CI-guarded even though `vite preview` ignores header files.
- The M0 landing shell includes browser-run worker diagnostics: backup/db/media
  Comlink round-trips plus a db-worker sqlite-wasm `opfs-sahpool` smoke database. Keep
  future diagnostics off the UI thread and behind typed worker APIs.
- Read-only source handle wrappers begin in
  `src/workers/backup/read-only-source.ts`; provider code should accept those wrappers
  rather than raw writable-capable `FileSystemDirectoryHandle`s.
- M1 backup detection is exposed as `BackupWorkerApi.detectBackup(root, progress?)`.
  It wraps the UI-provided `FileSystemDirectoryHandle` with
  `asReadonlySourceDirectory()` before provider detection, validates the iTunes/Finder
  root files, and parses XML plus bounded common binary plist values in
  `src/workers/backup/plist.ts`. Detection returns the normalized
  `BackupDeviceInfo` (name/model/osVersion/udid/serial/phone); the Apple plist key
  translation lives inside `src/workers/backup/ios-backup.ts` so no Apple-isms
  cross the worker boundary (hard rule 8).
- M1 workspace capability gating lives in `src/lib/capabilities.ts`; the
  sync-access-handle probe intentionally falls back to
  `src/workers/capability/capability.worker.ts` because Chromium exposes that API in
  the worker/OPFS context used by sqlite-wasm (headless Chromium exercises this
  path on every boot). The probe fails open on timeout/startup errors (D-017),
  caches its answer in sessionStorage, is skipped entirely when other required
  window checks already failed, and boot detection starts lazily via
  `getBootBrowserCapabilities()` — never at module evaluation (a module-eval
  probe caused a TDZ crash in production bundles). Worker construction
  (including the probe worker) is centralized in `src/lib/worker-client.ts`. UI
  actions create a fresh backup worker client per operation and release it in a
  `finally` — a shared cached client was tried and reverted because a dead
  worker would poison every later open and per-call progress proxies leaked.
- Chrome-only File System Access typings are declared once in
  `src/types/file-system-access.d.ts` (included by both tsconfig projects); do not
  re-declare `showDirectoryPicker`/`queryPermission`/`getAsFileSystemHandle` shapes
  ad hoc. Drop-event directory extraction lives in `src/lib/drag-drop.ts` and must
  collect `getAsFileSystemHandle()` promises synchronously during drop dispatch —
  the drag data store deactivates at the first `await`.
- License audit is fail-closed in `scripts/license-audit.mjs`. Non-standard licenses
  are package-specific exceptions only (see Decisions.md D-012); do not broaden the
  global allowlist without a recorded decision.
- Workers: `backup-worker` (source FS, manifest, crypto), `db-worker` (derived
  SQLite + FTS5 in OPFS), `media-worker` (HEIC/thumbnails/video fallback).
- Storage: recents + directory handles in IndexedDB; per-backup derived data in
  OPFS keyed by UDID; `derivedDbVersion` bump forces re-ingest. M1 recents storage
  lives in `src/lib/recents.ts`: IndexedDB database `golemine-recents`, store
  `backups`, permission re-grant helpers for stored directory handles, and wipe on
  remove for OPFS derived data under `golemine/backups/<UDID-or-id>`. Keep db-worker
  derived paths aligned with the exported constants there. All detection writes go
  through `BackupRecentsStore.recordDetection`, which preserves user renames and
  ingest status across every entry point, applies the `derivedDbVersion` staleness
  rule, and retires stale records (wiping only derived-data directories the new
  record does not share). Recents parsing is skip-and-report per record; unknown
  ingest statuses map to `needs-reingest` instead of rejecting the row.
- The M1 synthetic mini-backup fixture is generated under
  `e2e/fixtures/generated/ios-mini-backup/` and covers open -> detect -> recents in
  `e2e/m1.spec.ts`. The synthetic device values and plist builder live once in
  `e2e/fixtures/ios-mini-backup.mjs` (shared by the generator, ios-backup unit
  tests, and the Playwright spec) — extend that module rather than re-declaring
  fixture metadata.
- Crypto: WebCrypto only (PBKDF2, AES-KW, AES-CBC, SHA-256); passwords/keys are
  session memory only, never persisted.
