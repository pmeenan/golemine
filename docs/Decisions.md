# Decision Log

Product/architecture decisions with rationale. Add new entries at the bottom; never
rewrite history — supersede with a new entry that references the old one.

## D-001 — Chrome-only, fully offline browser app (2026-07-07)

The tool targets Chrome exclusively and runs entirely client-side with service-worker
offline support. This unlocks the File System Access API, OPFS, and
`getAsFileSystemHandle()` without fallback code, and guarantees the privacy story:
backup data never leaves the user's machine.

## D-002 — React 19 + TypeScript + Vite SPA (2026-07-07)

Chosen over Next/Nuxt/Astro/SvelteKit. The app is offline-first and statically hosted,
so SSR machinery is dead weight; React has the deepest ecosystem for virtualized lists,
component libraries (Radix/shadcn), and worker tooling. Vite + `vite-plugin-pwa` gives
the service-worker story directly.

## D-003 — Read backups in place; derived data in OPFS (2026-07-07)

Backups (often 50–200+ GB) are never copied into browser storage. The source folder is
accessed read-only via a persisted `FileSystemDirectoryHandle` (one permission click on
revisit); all derived data (normalized SQLite DB, FTS index, thumbnails) lives in OPFS
and is disposable/rebuildable. Rationale: no disk doubling, source stays pristine
(forensics), fast re-open. Trade-off accepted: removing the source drive breaks
browsing until reconnected.

## D-004 — Encrypted backup support is an early milestone (2026-07-07)

Encrypted iTunes backups are common (and contain more data). The file-access layer is
built around a decryption abstraction from day one; implementation lands right after
the unencrypted pipeline works (Plan M4). All crypto via WebCrypto in a worker;
passwords and keys are session-memory only.

## D-005 — License policy: permissive core, LGPL allowed for wasm codecs only (2026-07-07)

Project is Apache-2.0. Dependencies must be permissive (MIT/BSD/Apache/ISC/zlib), with
one carve-out: LGPL is allowed **only** for unmodified, dynamically-loaded wasm codec
modules (libheif, ffmpeg.wasm core) where the module is user-replaceable and upstream
source is linked in NOTICE. No GPL/AGPL anywhere. CI enforces via license audit.

## D-006 — Reports: court-exhibit grade, print-CSS → browser PDF (2026-07-07)

Reports carry provenance (SHA-256 of source DB and included attachments, device/backup
identity, tool version, explicit timezone, per-message GUID/rowid/raw timestamp,
methodology note) — suitable as a party-prepared supporting exhibit, not a certified
forensic examination. V1 exports via paginated print-CSS HTML + Chrome print-to-PDF;
programmatic PDF (pdf-lib) and full chain-of-custody tooling (hash manifests, audit
logs) are backlog.

## D-007 — Android format deferred; provider abstraction now (2026-07-07)

There is no standard Android full-backup format (adb backup deprecated, Google backups
cloud-locked). We design and prove a normalized `BackupProvider` interface with the
iOS implementation and defer choosing the Android input format (candidates: SMS Backup
& Restore XML, adb/filesystem dumps) until that phase begins.

## D-008 — No SharedArrayBuffer dependencies (2026-07-07)

sqlite-wasm uses the opfs-sahpool VFS and codecs run single-threaded, so the app needs
no COOP/COEP headers and can be hosted on any static host. Any future feature that
needs SAB must be raised as an explicit hosting decision.

## D-009 — "Lode" design system: token-driven, dual-theme, gold accent (2026-07-07)

All visual design is governed by `docs/Design.md`: OKLCH semantic tokens as CSS custom
properties (no hardcoded style values in components), mandatory light + dark themes
with system/manual selection, Inter + JetBrains Mono self-hosted (OFL), gold brand
accent used sparingly, iMessage-blue/SMS-green bubble colors reserved for message
semantics, print treated as a first-class theme for reports. Aesthetic direction:
calm high-end-tool feel (depth via stepped surfaces, restrained glass and motion),
not consumer-playful — the tool's output appears in court.

Theme rationale: the name is **Golem + Mine** — a mechanical automaton (à la Talos,
the bronze automaton — not a clay golem) mining through backup data. "Lode" and the
warm gold/bronze accent express both the automaton's metal and what it extracts
(finds, selections, highlights), not a "gold mine" pun; the golem itself shows up as
the calm, precise, machine-like feel and visible mechanical progress during ingest.
Clay/terracotta styling was considered and rejected as off-theme (2026-07-07).

## D-010 — pnpm, static hosting, PR-only CI, and generated fixtures (2026-07-07)

M0 uses pnpm rather than npm for reproducible installs, stable lockfiles, and cleaner
license-audit integration. The app is intended for a user-controlled static host with
root-relative asset paths by default; GitHub Pages-specific path assumptions are out of
scope unless deployment changes. GitHub Actions are used for pull-request validation
only: lint, typecheck, unit tests, Playwright Chromium e2e, and license audit. Test
fixtures must be synthetic and should include generator scripts or metadata so future
contributors can regenerate and inspect them.

Chrome latest stable is the only supported browser target. Chromium/Edge may work, but
the project will not add fallbacks or compatibility work solely for them.

## D-011 — M0 must prove privacy/offline/security invariants (2026-07-07)

Scaffolding is not just an empty app. M0 establishes the guardrails the rest of the
product depends on: offline reload after service-worker install, Playwright network
interception that fails on unexpected post-load network access, a restrictive
same-origin production CSP/security baseline, worker API type boundaries, a central
`derivedDbVersion` constant, read-only source-handle wrappers, and dependency license
auditing from the first installed packages onward.
