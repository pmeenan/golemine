# Golemine

![Golemine — a bronze automaton mining veins of data](docs/assets/readme-banner.png)

Browser-based tool for exploring, searching, and extracting data from phone backups —
starting with iPhone (iTunes/Finder) backups and their Messages data.

The name is **Golem + Mine**: a mechanical golem/automaton that mines through the
data in a backup and extracts the interesting bits.

Everything runs locally in your browser. **Your backup data never leaves your
machine** — there is no server, no upload, no telemetry, and the app works fully
offline after the first load.

## What it does (current + goals)

- Open an unencrypted iPhone backup folder today (drag & drop or file picker);
  encrypted backups are planned for M5 and will be decrypted locally in the browser.
- Browse message threads with attachments in a fast, responsive UI.
- Full-text search across all messages with filters (person, thread, date range,
  attachments).
- Preview native image, HEIC, and video attachments when Chrome/the media worker can
  decode them, and extract original attachment files back to disk.
- Select messages into a report and export a print-ready, court-exhibit-grade PDF
  including forensic provenance (file hashes, device identity, message GUIDs,
  explicit timezones) in a later milestone.
- Keep a "recent backups" list with friendly names for quick re-opening.
- Android backup support is planned (see `docs/Decisions.md` D-007).

## Requirements

- Google Chrome (latest stable). The app is intentionally Chrome-only — it relies on
  the File System Access API and the Origin Private File System.
- Static hosting under your control. No server application is required; all app code
  and wasm/font assets are served same-origin and cached for offline use.
- `pnpm build` writes the static end product to `dist/`.

## Status

M3 is implemented for unencrypted iPhone backups. The repo contains the strict
Vite/React/TypeScript app shell,
token-driven light/dark theme foundation, offline PWA registration, worker and
sqlite-wasm diagnostics, CI workflow, license audit, privacy/offline Playwright
guardrails, and the first usable opening flow.

The app now gates unsupported browsers, opens iPhone Finder/iTunes backup folders via
Chrome folder APIs, detects backup metadata in `backup-worker` (including larger
real-world `Info.plist` app metadata), stores recent backups in IndexedDB, re-requests
directory permission on reopen, and wipes OPFS derived data when a recent backup is
removed. The db-worker sqlite-wasm OPFS smoke path runs in dev and production builds
with sqlite-wasm excluded from Vite dependency optimization so its wasm asset resolves
correctly. A generated synthetic mini-backup fixture covers the open -> detect ->
recents flow in Playwright and now carries real unencrypted Manifest/sms/contact
SQLite data. The unencrypted M2 ingest path reads Manifest.db, applies committed WAL
frames to source SQLite copies, normalizes iPhone Messages, contacts, tapbacks,
attachments, and contact thumbnails, then writes a rebuildable OPFS derived database
with FTS, avatar paths, counts, warnings, and source-file provenance. The backup
overview can run and rebuild ingest. The M3 UI now adds a virtualized conversation
list, virtualized message timeline, message detail/provenance panel, FTS-backed search
with filters and snippets, source-backed attachment preview/extraction, and an OPFS
JPEG thumbnail cache for native image and HEIC attachments. HEIC thumbnails use
isolated same-origin `libheif-js` vendor files loaded lazily in `media-worker`
(production imports the public vendor module directly; Vite dev uses a fetch-to-Blob
module shim so the file is not transformed), prefer embedded HEIF thumbnails when
available, and fall back to serialized full-image decode with a 256 MiB RGBA-surface
cap that accommodates 48 MP phone photos. Native video preview uses Chrome's `<video>`
support from lazily read source bytes.
The messages layout follows the Lode message-rendering rules for deterministic
fallback avatars, sent/received bubble semantics, timestamp affordances, attachment
preview caps, and a detail overlay below the desktop responsive floor.
Long normalization and write stages now surface throttled item-count progress, so large
message backups show advancing counts during otherwise long-running steps.
The M2 path is hardened for real-world backup quirks: stale/torn SQLite WAL tails are
handled like SQLite end-of-log, large attachment media is not eagerly read just to hash
it, ingest batches flow worker-to-worker without a UI relay, and interrupted rebuilds
recover as needing re-ingest. Per-backup sqlite-wasm `opfs-sahpool` storage now
reserves extra SAH slots and the overview releases its summary reader during rebuilds
so repeated real-backup ingests do not fail on stale journal/temp pool slots. Source
SQLite copies are forced out of WAL mode before their transient read-only opens.

The iPhone guide covers Finder/iTunes backups created on any Mac or Windows computer,
with inline Finder steps and links to Apple Support for current screenshots and
troubleshooting. On macOS, copy the specific backup folder out of the default
`~/Library/Application Support/MobileSync/Backup/` location before opening it in Chrome,
because Chrome may not be allowed to read directly from `~/Library`.
See [docs/Plan.md](docs/Plan.md) for the current milestone status.

## Documentation

- [docs/Architecture.md](docs/Architecture.md) — system design
- [docs/Design.md](docs/Design.md) — design system (theming, tokens, component rules)
- [docs/Plan.md](docs/Plan.md) — milestones and status
- [docs/iOS-Backup-Format.md](docs/iOS-Backup-Format.md) — iOS backup format reference
- [docs/Decisions.md](docs/Decisions.md) — decision log
- [AGENTS.md](AGENTS.md) — project rules for AI agents / contributors

## License

Apache-2.0. Dependencies are permissively licensed; LGPL is permitted only for
isolated, dynamically loaded, replaceable codec packages when no better permissive
option exists (see AGENTS.md and Decisions.md D-026).
