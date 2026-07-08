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

## D-012 — License audit fails closed with narrow package exceptions (2026-07-07)

The M0 audit scans installed pnpm package manifests rather than trusting a lockfile key
shape. It globally allows the project's approved permissive license families (MIT,
BSD-2/3, Apache-2.0, ISC, Zlib, 0BSD) and rejects missing licenses, weak copyleft, and
GPL/AGPL/LGPL by default. Non-standard licenses are package-specific exceptions with
documented reasons: OFL font asset packages, build-time metadata/parser packages that
do not ship app code, and BlueOak-licensed transitive Workbox glob/cache packages used
only during `vite-plugin-pwa` service-worker generation. Future exceptions must be
added deliberately in `scripts/license-audit.mjs`, not by broad license family.

## D-013 — CSP is a static-host header template, not an HTML meta tag (2026-07-07)

The production CSP baseline lives in `public/_headers` and is copied into `dist/` for
static hosts that honor header files. The policy keeps `script-src` and `connect-src`
same-origin, includes `'wasm-unsafe-eval'` for sqlite-wasm/codec compilation, and keeps
other asset channels loose enough for self-hosted static output (`data:`/`blob:` where
needed). The no-flash theme initializer is a same-origin static script
(`public/theme-init.js`) so it works under `script-src 'self'`.

We do not use a meta CSP in `index.html`: it cannot enforce `frame-ancestors`, it made
the inline theme script hash-fragile, and it blocked Vite's development React-refresh
preamble. Hosting-specific stricter headers can supersede `public/_headers`, but must
preserve offline/PWA, worker, and wasm behavior.

Because `vite preview` does not serve header files, the Playwright suite replays the
`public/_headers` CSP onto every response (with service workers blocked so nothing
bypasses the route handler) and runs the app shell, worker round-trips, and
sqlite-wasm smoke under it, failing on any CSP console violation. Policy edits that
would break the deployed app therefore fail CI.

## D-014 — shadcn/ui vs. hand-rolled split for the messages UI (2026-07-07)

Resolves Plan.md OQ-1. The rule: vendor shadcn/ui where Radix solves hard
interaction/accessibility problems (focus traps, portals, keyboard navigation,
positioning); hand-roll where the component is domain-specific, lives inside a
virtualized list, or is simpler than the abstraction. Vendor per-milestone when a
component is first used — never pre-vendor.

Vendored from shadcn/ui (copied into `src/components/ui/`, restyled via the token
mapping per Design.md §7; all MIT): Dialog/AlertDialog (attachment viewer, destructive
confirms), Tooltip (icon-only buttons), DropdownMenu/Popover (message actions, filters,
backup switcher), Resizable (`react-resizable-panels` — the three-pane splitters per
Design.md §8), Toast (sonner), and Command (cmdk) if M3 search wants a palette input.

Hand-rolled: the entire Design.md §7.1 message timeline (bubbles, sender runs, day
separators, system events, reaction chips, edited/unsent annotations, search
highlights), thread list rows, the detail panel, empty states, and the existing
Button/Badge/Panel primitives from M0 (Panel/PanelHeader/StatusCard should be promoted
from `src/features/m0/` into `src/components/` rather than replaced by shadcn Card).

Performance constraint: nothing portal-based (Radix Tooltip/Popover/etc.) inside
react-virtuoso rows — a portal per row breaks the 100k-message 60 fps budget (Plan.md
M3). Hover timestamps and similar affordances in virtualized rows are CSS-driven per
Design.md §7.1.

## D-015 — Contact avatars ship in v1, thumbnails only (2026-07-07)

Resolves Plan.md OQ-2: yes. Nearly all required infrastructure exists in v1
regardless — Manifest.db lookup and read-only access (M1), the db-worker SQLite path
and ABPerson rowid join from contacts resolution (M2), the content-addressed OPFS
thumbnail cache (M3), the M4 per-file decrypt path, and the Design.md §7.1 avatar
slots with the §1.5 fallback ramp. The marginal cost is one tolerant parser plus
fixtures.

Scope and posture:

- Thumbnails only (`ABThumbnailImage`); full-size images (`ABFullSizeImage`) and
  group-avatar composition are deferred (groups use the §1.5 fallback ramp).
- Avatars are a progressive enhancement over the §1.5 hash-colored fallback, which
  remains the guaranteed baseline; avatar failures never degrade contact resolution.
- Blob parsing is tolerant per AGENTS rule 4: multiple `format` variants per record
  exist across iOS versions, and blobs may carry a prefix before the image data — sniff
  for JPEG/PNG magic bytes rather than trusting offset 0. Skip and report per record;
  a missing or empty AddressBookImages.sqlitedb is a silent no-op.
- Decoding is native browser JPEG/PNG — no HEIC/codec dependency for avatars.

## D-016 — Probe sync OPFS access in a worker for the capability gate (2026-07-07)

M1 adds a boot-time browser capability gate for workspace routes. Most required APIs
are window-visible (`showDirectoryPicker`, OPFS root access, and dragged directory
handles), but `FileSystemFileHandle.prototype.createSyncAccessHandle` is the capability
sqlite-wasm's OPFS path depends on in a worker context. Chromium may not expose that
method on the window prototype even when the worker/OPFS runtime supports the app's
SQLite path.

Decision: `src/lib/capabilities.ts` performs the normal window probes, then falls back
to `src/workers/capability/capability.worker.ts` for the sync-access-handle probe. The
gate still checks once at boot and still blocks workspace routes when required APIs are
missing. Backup guides remain accessible without the gate.

Rationale: this keeps the gate feature-based and Chrome-only without blocking supported
Chromium runs because a worker-only API is absent from the UI global.

## D-017 — Worker capability probe fails open and caches per session (2026-07-07)

The M1 code review confirmed two reliability problems with the D-016 worker probe:
a slow worker startup (cold dev server, overloaded CI) hit the 3-second timeout and
rendered the "Chrome is required" block screen on fully-capable Chrome, and because
Chromium does not expose `createSyncAccessHandle` on the window prototype, every
boot paid a worker spawn before workspace routes rendered.

Decision: the probe distinguishes "the worker answered `false`" (the API is truly
missing — the gate blocks) from "the probe could not run" (timeout, worker startup
failure — the gate fails open and logs a warning). Successful probe answers are
cached in `sessionStorage`; boot detection starts lazily via
`getBootBrowserCapabilities()` rather than at module evaluation, and
`detectBootBrowserCapabilities` accepts an injectable probe so the fallback path is
unit-testable.

Rationale: a browser that reaches the worker fallback has already passed the other
three Chrome-only window probes, so a missing answer is an environment hiccup, not
evidence of an unsupported browser. Failing closed produced false block screens and
flaky e2e; failing open costs nothing because sqlite-wasm surfaces a clear error in
the ingest path if the API is genuinely absent.

## D-018 — Steampunk Automaton Visual Identity & Image Post-Processing Workflow (2026-07-08)

To resolve inconsistencies in the golem's appearance and prevent it from resembling a sleek sci-fi superhero, we established a clear steampunk-inspired visual identity for the "Talos" mechanical automaton:
- **Design Elements:** Articulated brass-gold plates, cogs/gears on joints/chest, rivets, exposed copper pipes/pistons, and a dome head with a single circular optical gear lens in the center.
- **Cohesive Workflow:** We generated a primary character sheet (`docs/assets/golem-reference-sheet.png`) and passed it as context (`ImagePaths`) to all subsequent `generate_image` calls.
- **Format & Transparency Processing:** Since the image generation tool outputs JPEGs (RGB mode), all assets are generated directly against their target UI backgrounds (`#1E2127` for dark mode/brand, `#F9FAFB` for light mode). A throw-away Pillow script (deleted per AGENTS.md hygiene; technique recorded here for regeneration) converted the JPEGs to the final transparent WebP/PNG assets by keying out the target background color with tolerance, avoiding mosquito noise and edge haloing.

The identity, asset locations, and light/dark variant rules are codified in Design.md §12; the character sheet is the mandatory image context for any future golem art.

