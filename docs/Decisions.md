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
the unencrypted pipeline works (Plan M5). All crypto via WebCrypto in a worker;
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
thumbnail cache (M3), the M5 per-file decrypt path, and the Design.md §7.1 avatar
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

## D-019 — Role-specific root plist size bounds for iOS detection (2026-07-08)

Real iOS backups can have `Info.plist` files well above the original 8 MiB metadata
guard because `Info.plist` includes installed-application metadata. A reference backup
with a 12.1 MiB XML `Info.plist` should still detect normally.

Decision: iOS backup detection uses a 32 MiB bound for `Info.plist` and keeps the
existing 8 MiB bound for `Manifest.plist` and `Status.plist`. All three plists are
still read and parsed only inside `backup-worker`, and malformed or too-large files
remain recoverable detection errors.

Rationale: this preserves a hostile-input memory bound while allowing realistic iPhone
backup metadata. `Manifest.plist` and `Status.plist` do not carry the same bulky app
inventory payload, so keeping their tighter limit catches malformed folders earlier.

## D-020 — Keep sqlite-wasm out of Vite dependency optimization (2026-07-08)

Vite's dev dependency optimizer can prebundle `@sqlite.org/sqlite-wasm` into a
`node_modules/.vite/deps` module. In that form, sqlite-wasm's default wasm locator may
request a path that Vite answers with the SPA HTML fallback, causing WebAssembly
instantiation to fail with bytes beginning `<!do` instead of the wasm magic header.

Decision: `vite.config.ts` excludes `@sqlite.org/sqlite-wasm` from `optimizeDeps`.
The app still does not add COOP/COEP headers; sqlite's standard OPFS VFS may warn
about missing `SharedArrayBuffer`, but the project uses `opfs-sahpool`, which works
without those headers (D-008).

Rationale: this follows the package's Vite guidance for wasm asset resolution while
preserving Golemine's static-hosting constraint and no-`SharedArrayBuffer` posture.

## D-021 — Apply iOS source SQLite WAL frames before opening transient DBs (2026-07-08)

Unencrypted iOS ingest needs the current contents of source SQLite files such as
`Library/SMS/sms.db`, including committed transactions still present in `sms.db-wal`.
The iTunes/Finder backup stores those files under Manifest file IDs, not adjacent
runtime filenames, and sqlite-wasm's transient POSIX VFS did not reliably replay copied
sidecar files as a normal filesystem pair.

Decision: the backup-worker reads the main database and optional WAL sidecar through the
read-only Manifest lookup, validates the WAL magic/version/page size/salts, verifies the
SQLite rolling header/frame checksums, bounds the committed database size from the main
file plus frame count, applies only frames up to the last commit frame to a copy of the
main database bytes, resets the reconstructed copy to rollback journal mode in the
database header, and then opens that transient copy read-only with sqlite-wasm. Source
bytes and source hashes are still preserved for provenance, and the user's backup folder
is never modified.

Rationale: this keeps provider-specific SQLite recovery inside backup-worker, avoids
COOP/COEP or host filesystem assumptions, handles in-backup WAL sidecars deterministically,
and remains compatible with the future encrypted path, which can feed decrypted main/WAL
bytes into the same reconstruction helper.

## D-022 — M2 ingest hardening after adversarial review (2026-07-08)

Supersedes the strict WAL-frame portions of D-021. The WAL reader still rejects invalid
headers and impossible committed database sizes, but frame validation now follows
SQLite end-of-log behavior: apply the valid frame prefix, stop at the first invalid
frame checksum/salt/page number or torn tail, and ignore stale bytes after that point.
This handles checkpoint-reset WALs and copied sidecars with leftover frames without
dropping a valid committed prefix.

M2 ingest also avoids eager full-media reads. Attachment metadata is normalized for
all rows, but source SHA-256 is computed during ingest only when Manifest.db gives a
bounded size at or below 64 MiB, the actual `File.size` is within the read limit, and
the per-ingest eager attachment-hash budget has not been exhausted. Larger,
unknown-size, deceptive-size, or budget-exhausted attachments keep path/domain/GUID
provenance and emit a warning that source hashing is deferred to later
attachment/report extraction. Manifest.db lookup failures for individual attachments
are skip-and-report, not whole-ingest failures, and root `Manifest.db-wal`/`-shm`
sidecars are applied before querying Manifest records.

Production unencrypted ingest uses `BackupWorkerApi.ingestUnencryptedBackupToDb`,
where backup-worker creates a dedicated db-worker and streams batches directly to it.
The older sink-taking RPC remains as a test seam, but the React route no longer relays
backup-worker -> UI -> db-worker ingest batches. The route guards same-backup rebuilds
with Web Locks, marks recents `failed` only after the derived DB has actually been
prepared or db-worker reports a prepare/write/finalize failure, and recovers stale
persisted `ingesting` statuses as `needs-reingest` on read.

Rationale: real backups contain stale WAL tails, huge media attachments, malformed
per-file metadata, and users can open multiple tabs. These changes preserve the
offline/read-only/provenance posture while keeping the UI thread out of ingest data
transport and preventing transient pre-ingest failures from hiding a valid existing
derived database.

## D-023 — ingest_meta stores summary_json as the single machine-read record (2026-07-08)

The M2 cleanup pass removed the duplicated `counts_json`/`source_files_json`/
`warnings_json`/`count.*` rows from `ingest_meta`. `summary_json` is now the only
machine-read representation of an ingest (read back by the db-worker summary API);
the remaining scalar rows (`provider`, `started_at`, `completed_at`, `database_name`,
`derived_db_version`) exist purely as debugging aids for inspecting a derived DB
directly. Stored-summary validation is a shallow, provider-agnostic structural check —
no deep per-field guards or provider/role enumerations. A structurally-valid summary
written under a different `derivedDbVersion` is treated as absent (falling back to the
re-ingest path), not as malformed; only structural garbage raises `db_ingest_failed`.

Rationale: duplicated rows only stay correct if every writer keeps them in sync with
`summary_json`; a single canonical JSON blob removes that drift risk while keeping
quick manual SQLite inspection possible. Deep validation of the stored summary is
unnecessary because any change to the summary shape ships with a `derivedDbVersion`
bump, which already forces re-ingest.

## D-024 — Reserve headroom in per-backup sqlite-wasm SAH pools (2026-07-08)

Real backup rebuilds can fail during `prepareIngest` with `SQLITE_CANTOPEN` even when
the M0 sqlite smoke test passes. The smoke test uses one tiny database in its own pool,
but derived backup databases live in persistent per-backup `opfs-sahpool` directories.
sqlite-wasm persists the pool's file slots; interrupted rebuilds, rollback journals,
and temp files can leave a small pool full enough that opening or resetting
`golemine.sqlite` cannot allocate the next slot. Rebuilds can also briefly contend with
the overview's read-only summary db-worker if the backup was already marked ingested.

Decision: per-backup derived DB pools now initialize and reserve a 16-slot minimum, and
derived DB open failures report the OPFS directory, VFS name, capacity, and file count
through the db-worker error payload. The overview route releases its summary reader
while ingest is running. Playwright's M2 flow now ingests and then rebuilds the same
synthetic backup so this path is covered in-browser.

Rationale: increasing the pool is cheap for one derived DB per backup and avoids
fragility from stale journal/temp slots. The summary-reader lifecycle change keeps the
same-backup rebuild path from racing another worker for the same SAH pool. Do not shrink
the pool without testing repeated rebuilds and interrupted-ingest recovery in Chrome.

## D-025 — Force copied source SQLite DBs out of WAL mode before transient opens (2026-07-08)

Real iOS backups can contain SQLite main database files whose header still declares WAL
journal mode even when the sidecar is absent, stale, or contains no committed frames.
When backup-worker copies only the reconstructed main bytes into sqlite-wasm's
transient VFS and opens that copy read-only, sqlite may try to open a sibling `-wal`
file that does not exist in the transient VFS and fail with `SQLITE_CANTOPEN`.

Decision: `src/workers/backup/source-sqlite.ts` now prepares every source SQLite copy
through `prepareSourceSqliteBytesForReadOnlyOpen`, which copies the main bytes, applies
the valid committed WAL prefix when present, and always rewrites SQLite header bytes 18
and 19 to rollback-journal mode before `sqlite3.oo1.DB(..., "r")`. This includes
no-sidecar and no-committed-frame cases. Source SQLite open failures are wrapped in
`SourceSqliteOpenError` with structured, non-content details such as database role,
transient name, byte counts, and header journal versions.

Rationale: the backup folder remains read-only and provider-specific sidecar handling
stays deterministic in backup-worker. Forcing rollback mode on the transient copy
prevents sqlite-wasm from making filesystem assumptions about sidecars we deliberately
do not create.

## D-026 — Isolate LGPL codec packages when no better option exists (2026-07-08)

M3 needs attachment previews, and HEIC support may require LGPL code. D-005 keeps the
core application permissively licensed, but LGPL can be acceptable when there is no
good permissive alternative and the dependency can be used without tainting Golemine's
Apache-2.0 app code. For browser codecs, that means the LGPL pieces must stay as
separate, unmodified, dynamically loaded same-origin library files rather than being
bundled into app chunks or copied into project-owned source modules. This may include
the codec's JavaScript glue/wrapper when that glue is part of the unmodified upstream
LGPL distribution and is loaded as an isolated library file. This decision clarifies
the narrower "wasm codec modules" wording in D-005 for browser codec packages.

Decision: an LGPL codec dependency may be added if it is the best available option, is
same-origin hosted, is loaded lazily/dynamically from isolated vendor files, remains
unmodified or has any modifications published under the LGPL, is practically
replaceable by users, and is recorded in NOTICE plus the package-specific license audit
exceptions. GPL/AGPL remain disallowed.

Rationale: this gives users the browse/search/extract experience without weakening the
project's license posture or folding copyleft code into app-owned modules. Each LGPL
codec choice still needs its own package/version decision so replacement, NOTICE, and
license-audit details stay explicit.

## D-027 — Use isolated libheif-js for HEIC thumbnails (2026-07-08)

M3's attachment surface should preview common iPhone image formats. Chrome does not
natively decode HEIC everywhere, and no suitable permissively licensed browser HEIC
decoder was available in the current stack. `libheif-js` 1.19.8 packages libheif for
browser use under LGPL-3.0 and provides a wasm-backed ES module build.

Decision: Golemine uses `libheif-js` 1.19.8 for HEIC attachment thumbnails only. The
runtime files are copied unmodified under
`public/vendor/libheif-js/1.19.8/` and lazy-loaded by `media-worker` with a dynamic
import from that same-origin vendor path. Golemine does not import `libheif-js` from
app source or let Vite bundle it into app chunks. The package is recorded in NOTICE and
has a package-specific `scripts/license-audit.mjs` exception per D-026. The app-owned
media-worker bridge may call exported libheif thumbnail-handle APIs from that isolated
module: it prefers embedded HEIF thumbnails when they meet the display target and uses
the largest available embedded thumbnail when the primary image exceeds the worker
decode memory cap.

Rationale: this adds the expected iPhone HEIC preview path while keeping LGPL code out
of project-owned modules and preserving offline/static-host behavior. The worker still
returns original-file extraction for every attachment and caches decoded thumbnails as
rebuildable OPFS derived data.

Note (2026-07-08): D-033 adds the Vite-dev-only fetch-to-Blob module shim needed to
avoid Vite's public-dir transform guard. Production still imports the same public
vendor ES module directly.

Note (2026-07-09): the full-image guard is a 256 MiB decoded RGBA-surface budget
(67,108,864 pixels), replacing the original 64 MiB/16,777,216-pixel budget so 48 MP
phone photos can be previewed. Thumbnail generation is serialized regardless of caller
concurrency, libheif images/decoders remain explicitly released, and temporary canvas
backing stores are reset after downsampling. The budget describes one RGBA surface,
not total worker process memory; libheif, JavaScript `ImageData`, codec working buffers,
and canvas storage can make the transient process peak several times higher.

## D-028 — Cache attachment thumbnails as JPEG (2026-07-08)

M3 attachment thumbnails are overwhelmingly phone photos, including HEIC originals
decoded by `media-worker`. PNG thumbnails were simple but wasteful for photo previews.

Decision: `MediaWorkerApi.createAttachmentThumbnail` returns `image/jpeg` thumbnails
and stores them as `.jpg` files under the OPFS attachment thumbnail cache. The worker
resizes before encoding, uses high-quality JPEG compression, and flattens transparent
sources onto a white matte because JPEG has no alpha channel.

Rationale: JPEG keeps preview bytes and OPFS cache size much smaller for the expected
photo-heavy workload while still handing the browser a normal image format after HEIC
decode. The original source attachment remains available through extraction, so the
thumbnail cache stays disposable derived data.

## D-029 — M3 browse/search routes own route-scoped workers (2026-07-08)

One-shot open/detect/ingest operations create a fresh worker client per operation and
release it in `finally`, but the M3 messages/search routes issue many small queries,
previews, and thumbnail requests. Per-operation workers there would churn worker
startup and repeatedly reinstall the same per-backup `opfs-sahpool` VFS.

Decision: the M3 routes intentionally create db/backup/media worker clients scoped to
the route lifetime and release them on unmount. The consequence is accepted: the
per-backup SAH pool is held while the route is mounted, so browsing the same backup in
multiple tabs concurrently is out of scope for now. The transient hand-off race when
switching routes (a just-terminated worker's sync access handles still releasing while
the next worker installs its pool) is mitigated by retrying `installOpfsSAHPoolVfs`
briefly (`retryAsyncOperation`, 4 attempts with a 150/300/600 ms backoff) in the
ingest sink, and the backup worker memoizes the most recent backup's detection plus
open `ManifestDbReader` per `backupId` — sound because source backups are read-only.

Rationale: one worker set per mounted route keeps repeated queries cheap and avoids
SAH pool contention within a tab. Multi-tab same-backup browsing needs a coordinated
pool-ownership design (e.g. Web Locks hand-off) and should be its own decision if it
becomes a real need.

Note (2026-07-08): the retry must pass sqlite-wasm's `forceReinitIfPreviouslyFailed`
option — `installOpfsSAHPoolVfs` memoizes its install promise per VFS name and
otherwise replays the first rejection on every retry. The backoff schedule is
150/300/600 ms (~1.05 s total) because route-switch handle release can exceed 450 ms
on slow machines. When the pool still cannot be acquired during a rebuild's
`prepareIngest` (e.g. another tab holds it), the db-worker fails with the distinct
`derived_db_pool_unavailable` code, which guarantees the derived DB was not modified;
the overview route uses it to restore a previously `ingested` record instead of
downgrading it to `failed`. The memoized `ManifestDbReader` cache additionally
verifies root-directory identity (`isSameEntry`) on hits and retains byte-free
provenance metadata only.

## D-030 — FTS5 snippet sentinels degrade to unhighlighted snippets (2026-07-08)

Search snippets are produced by FTS5 `snippet()` using U+0001/U+0002 as highlight
delimiters, then parsed into structured segments so the UI never renders backup text
as HTML. Backup content is hostile input (hard rule 4): a message body may itself
contain those control characters and desynchronize delimiter parsing.

Decision: when a snippet's body text contains the sentinel characters, the db-worker
strips all sentinels and returns the snippet as a single non-highlighted segment
instead of guessing at highlight boundaries. Sentinel characters are always stripped
from every emitted segment as a final guard, so they can never reach the UI.

Rationale: losing highlight styling on a deliberately crafted message is harmless;
mis-parsed highlight boundaries could mislabel which text matched. Degrading to plain
text is the only failure mode that stays honest.

## D-031 — User-initiated extraction reads up to 1 GiB in memory (2026-07-08)

Attachment reads through `readUnencryptedSourceFile` are byte-capped by the caller
(`src/workers/shared/media-limits.ts`). Previews use small budgets, but "extract
original" must handle large videos, and the backup-worker read path currently
materializes the file bytes in worker memory before transfer.

Decision: user-initiated extraction uses an explicit `extractMaxReadBytes` budget of
1 GiB. The larger read is acceptable because the user explicitly chose a destination
file; files above the budget fail with a clear byte-cap error rather than an
out-of-memory crash. The extract flow checks permission, opens the save picker, reads
with the budget, and removes the zero-byte picker stub if the read fails. A streaming
source-to-disk copy (no full in-memory buffer, no practical cap) is deferred; the M5
per-file decrypt path is the natural time to revisit it.

Rationale: 1 GiB covers realistic phone attachments while keeping the read path
simple and transferable over Comlink. An unbounded in-memory read would trade a clear
error for an opaque tab crash on pathological files.

## D-032 — Normalized serviceKind drives message presentation (2026-07-08)

Bubble accent color depends on the message service (iMessage blue vs. SMS green), but
provider service strings are raw source values and must not be string-matched in the
UI (hard rule 8).

Decision: `src/workers/shared/service-kind.ts` owns `classifyServiceKind`, mapping the
trimmed, case-insensitive service token to `imessage`, `sms-family` (SMS/MMS/RCS), or
`unknown`; unrecognized variants deliberately fall through to `unknown` rather than
being guessed. The db-worker populates `serviceKind` on message records/previews, and
the UI styles `sms-family` with `--bubble-sms` and everything else — including
`unknown` — with `--bubble-imessage`.

Rationale: classification lives once in a shared worker module so db-worker and any
future provider agree, and the UI stays free of provider-specific string knowledge.
Rendering `unknown` as iMessage matches the dominant iPhone-backup case and keeps a
stable default for services added by future iOS versions.

## D-033 — Use a dev-only Blob import for public codec modules (2026-07-08)

Vite dev rejects module imports that resolve to `public/` assets, even when a
production static host can serve the same file as a same-origin ES module. This broke
HEIC previews with an internal server error for
`/vendor/libheif-js/1.19.8/libheif-wasm/libheif-bundle.mjs`.

Decision: production keeps importing the public `libheif-js` ES module directly from
`media-worker` as an isolated same-origin vendor module under the existing CSP. In
Vite dev only, `src/workers/media/thumbnails.ts` fetches the unmodified public vendor
file with same-origin credentials, imports it through a temporary Blob module URL, and
revokes the Blob URL after import. The vendored files still live under
`public/vendor/`, remain byte-compared by the license audit, and are not bundled or
transformed by Vite.

Rationale: dev and production both load the same LGPL vendor bytes lazily and offline.
The dev-only Blob URL sidesteps Vite's public-dir module guard without weakening the
production CSP or moving vendor code into app source.

## D-034 — Search folds into the messages workspace with substring-capable semantics (2026-07-09)

The M3 standalone search page and the messages browser split one exploration task
across two routes: search results lose thread context, and browsing loses the ability
to narrow by text. M4 unifies them (Plan.md M4): a search panel above the messages
workspace, a Threads pane filtered to conversations with hits (ordered by most-recent
hit, with hit counts), a results column between Threads and the timeline (all results
when no thread is selected, thread-scoped when one is, with an "All" affordance to
unselect), jump-to-message on result click, an on-demand collapsible details pane, and
a reset control that returns to plain browsing. Search always spans all conversations
— the conversation filter field is dropped; the results column's thread scoping
replaces it. M4 removed the standalone search route after parity landed. Encrypted
backups and later milestones renumber to M5+.

Search text semantics:

- Case-insensitive throughout.
- Unquoted space-separated words are an implicit AND, matching in any order anywhere
  in the message, each word as an FTS5 prefix query (`word*`), not whole-word only.
- Quoted strings are true Unicode-case-insensitive substring matches: only ASCII
  letter/digit/underscore tokens whose boundary is provably inside the literal
  compile to an FTS narrowing query, and the db-worker verifies the raw substring
  with escaped `/iu` matchers against candidate bodies. Restricting quoted narrowing
  keys to ASCII avoids false negatives when JavaScript and SQLite's bundled
  `unicode61` tables recognize different Unicode case pairs. A quote without a
  compatible narrowing token (punctuation/emoji-only, non-ASCII-only internal tokens,
  or a single token that may begin mid-word) falls back to a newest-first non-FTS scan
  capped at 10,000 filtered rows; the response reports candidate coverage and
  truncation. (D-035 later extended the same 10,000-row budget to FTS-narrowed
  verification scans.)

Implementation resolution: active search uses compact tokenized Threads, Results,
and Timeline widths at the 1024px desktop floor. The on-demand Details pane overlays
with dialog/focus semantics until the viewport reaches 96rem, where all four panes can
dock without violating their minima.

Rationale: FTS5 phrase queries match token sequences, so they cannot deliver
"string match as-is" (no mid-word matches, punctuation ignored); narrowing with FTS
and verifying the substring in the db-worker keeps the common path index-fast while
honoring the user's literal quoted text. Prefix matching for words matches user
expectations for message search better than whole-word matching at negligible FTS5
cost. All compilation and verification stay in the db-worker so hostile bodies are
never interpolated and the D-030 snippet-sentinel rules keep applying.

## D-035 — Every quoted-literal verification scan is budgeted and single-pass (2026-07-09)

The initial M4 implementation verified FTS-narrowed quoted literals against the
entire candidate set, in `LIMIT/OFFSET` batches that re-executed the FTS match and
its `ORDER BY` for every batch. On a real backup a quoted phrase whose narrowing
token is common ("the") could make one search — issued twice per submit, again per
load-more, and again per thread-scope click — stall the db-worker for minutes with
no disclosure and no progress.

Decision: `scanVerifiedSearchMatches` always applies the newest-first
`boundedSearchRowBudget` (10,000 candidate rows), whether or not the literal has an
FTS narrowing key, and reads candidates with a single ordered prepared statement
stepped row-by-row (one FTS match, one sort, one row in memory at a time) with
throttled worker progress. Coverage is a discriminated union: a complete scan keeps
the `fts` shape (`truncated: false`, no budget field), and any scan that could not
examine every candidate — or any no-narrowing-key scan, whose budget is its defining
semantic — reports `bounded-scan` with `rowBudget` so the UI must disclose omitted
older rows.

Also recorded from D-034's test suite, now explicit: a conversation-scoped quoted
search without a narrowing key shares the one global bounded corpus (the
`conversationId` filter applies after the newest-first budget, in the db-worker).
Scoping therefore cannot resurrect matches older than the newest 10,000 filtered
rows; global and scoped coverage stay identical by design so hit counts never
disagree between the Threads and Results panes. Quoted-path snippets highlight the
verified literals and, within the literal-centered window, unquoted AND-terms as
whole prefixed tokens (FTS `snippet()` is unavailable on the verification path);
window boundaries are aligned to code points so emoji are never split into lone
surrogates.

## D-036 — Unnamed groups derive identity from all non-self participants (2026-07-10)

iOS normalization previously filled every missing conversation `displayName` from the
first non-self participant. For an unnamed group this erased the distinction between
an explicit source title and a one-person fallback, so the messages workspace rendered
many different groups as if each were a duplicate direct thread with that person.

Decision: for `chat.style = 43` groups, normalized `displayName` is populated only from
an explicit non-empty `chat.display_name`; neither the first participant nor the
opaque `chat_identifier` is stored as a group title. Normalized participants retain
`contactFirstName` separately from the full `contactName`, persisted as
`participants.contact_first_name`. Presentation keeps explicit titles, keeps a full
participant label for one-to-one threads, and labels unnamed groups from every
non-self participant: first name when available, otherwise full contact name, then raw
handle. Two labels use "A and B"; longer lists use "A, B and C". Derived database
version 2 forces existing cached first-participant titles to be rebuilt from source.

Rationale: group identity is participant-set identity unless the source names it. A
distinct normalized first-name field avoids guessing name structure in React, while
full-name and handle fallbacks keep unresolved or organization-only contacts visible.
The version bump is necessary because the old derived rows do not record whether a
stored group title was explicit or synthesized.

## D-037 — React DayPicker powers optional search date ranges (2026-07-10)

The paired native Chrome date inputs in the messages search panel were compact but
made a range feel like two unrelated fields and exposed a limited browser calendar.
The replacement needs range semantics, long-distance month/year navigation, full
keyboard operation, local styling in both Lode themes, and a license compatible with
the Apache-2.0 project.

Decision: use MIT-licensed React DayPicker v10 as the calendar engine inside an
MIT-licensed Radix Popover. The form exposes one optional "Date range" trigger. The
popover displays two contiguous fixed-height months, month/year dropdowns, outside
days, previous/next navigation, an announced selection status, and Lode-token styling
with lucide navigation icons. Range changes are staged until "Apply dates"; Apply is
disabled after only a start date, selecting the start again completes a one-day range,
and Cancel/Escape discard the draft and restore trigger focus. Clear is available in
the popover and beside an applied range. Calendar dates convert through local
`YYYY-MM-DD` components, after which the existing search form continues to produce
inclusive UTC start and exclusive-next-day UTC end query bounds.

React Datepicker was also permissively licensed and popular, but its more opinionated
input/calendar presentation would require more design-system overrides. React Aria's
Apache-2.0 DateRangePicker provides a strong accessibility baseline but brings a much
broader internationalized date/state stack than this filter needs. MUI X's polished
Date Range Picker was rejected because the range component is a commercially licensed
Pro feature. React DayPicker fits the existing shadcn/Radix architecture, exposes the
range and navigation behavior directly, and keeps every visible style under Lode's
semantic tokens.

Dark-theme follow-up: React DayPicker places a transparent native `select` over each
styled dropdown label. Styling only the label leaves the browser-owned month/year list
on its default light palette. The actual `select` and `option` nodes therefore inherit
the root `color-scheme` and receive Lode surface/text tokens. Clickable outside-month
dates use full-opacity `--text-secondary`; automated browser coverage checks both
themes' dropdown palettes and WCAG AA contrast for all calendar text states.

The messages corpus cannot predate the first iPhone release, so the picker explicitly
bounds navigation and selection to January 2007 through December of the browser's
current year. The upper year is calculated at runtime rather than maintained as a
hardcoded release value. DayPicker omits outside-month cells beyond those navigation
edges, and an explicit disabled matcher provides a second selection guard. Browser
coverage asserts that both year dropdowns contain exactly the descending inclusive
2007–current-year range and that no out-of-bounds spillover day is rendered.
