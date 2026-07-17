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

- Open encrypted or unencrypted iPhone backup folders (drag & drop or file picker);
  encrypted content is decrypted locally in a web worker after a session-only
  password prompt.
- Browse message threads with attachments in a fast, responsive UI.
- Search inside the same messages workspace with participant/attachment filters and
  an optional two-month calendar date-range picker, plus hit-counted threads,
  all-or-thread-scoped results, and jump-to-context.
- Preview native image, HEIC, and video attachments when Chrome/the media worker can
  decode them, and extract original attachment files back to disk.
- Select messages from timelines or search results into multiple named reports,
  order them, add notes/case metadata, and export a print-ready,
  court-exhibit-grade PDF through Chrome with source hashes, device identity,
  message GUIDs/raw timestamps, and an explicit timezone.
- Keep a "recent backups" list with friendly names for quick re-opening.
- Android backup support is planned (see `docs/Decisions.md` D-007).

## Requirements

- Google Chrome (latest stable). The app is intentionally Chrome-only — it relies on
  the File System Access API and the Origin Private File System.
- Static hosting under your control. No server application is required; all app code
  and wasm/font assets are served same-origin and cached for offline use.
- `pnpm build` writes the static end product to `dist/`.

## Status

M7 polish is underway on top of the completed M6 reports milestone for encrypted and
unencrypted iPhone backups. The repo contains the strict
Vite/React/TypeScript app shell,
token-driven light/dark theme foundation, offline PWA registration, worker and
sqlite-wasm diagnostics, CI workflow, license audit, privacy/offline Playwright
guardrails, and the first usable opening flow.

The app now gates unsupported browsers, opens iPhone Finder/iTunes backup folders via
Chrome folder APIs, detects backup metadata in `backup-worker` (including larger
real-world `Info.plist` app metadata), stores recent backups in IndexedDB, re-requests
directory permission on reopen, and wipes OPFS derived data when a recent backup is
removed. Recents and derived storage currently keep one active snapshot per detected
device ID. Selecting a different folder or backup date for an ID already on this
computer asks whether to keep the existing snapshot or replace it; replacement wipes
the old local ingest and opens the selected source as not ingested, while cancellation
does not change local state. The db-worker sqlite-wasm OPFS smoke path runs in dev and production builds
with sqlite-wasm excluded from Vite dependency optimization so its wasm asset resolves
correctly. A generated synthetic mini-backup fixture covers the open -> detect ->
recents flow in Playwright and now carries real unencrypted Manifest/sms/contact
SQLite data. The unencrypted M2 ingest path reads Manifest.db, applies committed WAL
frames to source SQLite copies, normalizes iPhone Messages, contacts, tapbacks,
attachments, and contact thumbnails, then writes a rebuildable OPFS derived database
with FTS, avatar paths, counts, warnings, and source-file provenance. The backup
overview can run and rebuild ingest. The messages UI now unifies a virtualized
conversation list, FTS-backed search panel, hit-counted filtered threads, scoped
search results, a virtualized timeline, and on-demand detail/provenance in one
workspace. Unquoted words use case-insensitive implicit-AND prefix matching; quoted
literals use case-insensitive substring verification in a single-pass scan bounded
to the newest 10,000 candidate rows, and the UI explicitly warns whenever that
budget truncates coverage. Date filtering uses a keyboard-accessible, token-styled
two-month calendar with month/year navigation, staged range selection, same-day
ranges, explicit apply/clear actions, and theme-aware native dropdown palettes with
automated light/dark contrast coverage. Its selectable years run from 2007 through
the browser's current year. Source-backed attachment
preview/extraction and the OPFS JPEG thumbnail cache remain integrated with the
timeline and details. HEIC thumbnails use
isolated same-origin `libheif-js` vendor files loaded lazily in `media-worker`
(production imports the public vendor module directly; Vite dev uses a fetch-to-Blob
module shim so the file is not transformed), prefer embedded HEIF thumbnails when
available, and fall back to serialized full-image decode with a 256 MiB RGBA-surface
cap that accommodates 48 MP phone photos. Native video preview uses Chrome's `<video>`
support from a lazily staged source Blob.
The messages layout follows the Lode message-rendering rules for deterministic
fallback avatars, sent/received bubble semantics, timestamp affordances, attachment
preview caps, compact search panes at the desktop floor, and an on-demand detail
overlay until the viewport is wide enough to dock all panes. Explicit group names are
preserved; unnamed group threads list every non-self participant using contact first
names when available (for example, "Brian, Karin and Sean") instead of looking like a
duplicate one-to-one thread. Derived database version 3 rebuilds older cached data for
the report ordering schema and the corrected explicit-name semantics.
Long normalization and write stages now surface throttled item-count progress, so large
message backups show advancing counts during otherwise long-running steps.
The M2 path is hardened for real-world backup quirks: stale/torn SQLite WAL tails are
handled like SQLite end-of-log, large attachment media is not eagerly read just to hash
it, ingest batches flow worker-to-worker without a UI relay, and interrupted rebuilds
recover as needing re-ingest. Per-backup sqlite-wasm `opfs-sahpool` storage now
reserves extra SAH slots and the overview releases its summary reader during rebuilds
so repeated real-backup ingests do not fail on stale journal/temp pool slots. Source
SQLite copies are forced out of WAL mode before their transient read-only opens.
Manifest and message/contact source databases now stream into per-backup transient
OPFS, apply WAL pages by random access, and enter a dedicated 16-slot
`opfs-sahpool` through its chunk callback without a full JavaScript or wasm-heap copy
(D-041). The required messages set is still validated before the destructive prepare
boundary: missing/malformed encrypted metadata, implausible multi-terabyte sizes, and
insufficient local OPFS quota fail without touching a previously ingested workspace.
Quota preflight reserves the three-copy staging/reconstruction/import peak, and every
required encrypted database key is trial-unwrapped and zeroized before that boundary.
Transient plaintext is deleted on close/lock/eviction, every encrypted ingest ends by
locking its worker session so no staged plaintext outlives a completed ingest, a
fresh worker sweeps crash leftovers, and Remove backup wipes the containing
derived-data directory.

Encrypted backups now use a defensive keybag TLV parser, the modern two-stage or
legacy PBKDF2 password derivation, AES-KW class/file key unwrapping, and zero-IV
AES-CBC decryption entirely in `backup-worker`. Wrong passwords fail before the
derived database is prepared, so a retry cannot invalidate a previously ingested
workspace. Source database files and WAL sidecars decrypt into the same streaming
pipeline; attachment reads decrypt in bounded chunks while an incremental hasher
preserves both plaintext and encrypted-source SHA-256 provenance. The password is
cleared from the UI immediately after dispatch; only unwrapped class keys and the
transient decrypted Manifest reader remain in the worker session. A new messages-route
worker asks once more before it can read original encrypted attachments, and its
unlock strip can explicitly lock that worker session without leaving the route.
Neither passwords nor keys are written to IndexedDB,
OPFS, logs, or error payloads. The overview discloses that the rebuildable OPFS
database and generated media previews can contain decrypted content, and that removing
the recent backup wipes that local derived data.
Per-file reads treat Manifest `MBFile.Size` as the authoritative plaintext length and
resize decrypted storage to match it: longer block-aligned stored tails are truncated,
and shorter sparse prefixes are zero-extended. Previews cross the worker boundary as
Blobs, while extraction writes decrypt chunks directly to the user-selected file
instead of materializing the former 1 GiB array. Failed extraction aborts atomically
without deleting a destination file that may already have existed.

Messages and search results now expose one shared report picker. It can create and
toggle multiple named reports without putting portal UI inside virtualized rows, and
every saved report is reachable from the backup overview's Reports tile through a
dedicated per-backup report list. The
report builder stores explicit item order, per-item notes, title, matter, preparer,
and an IANA timezone in the per-backup SQLite database. Same-version message-index
rebuilds preserve reports and notes, pruning only selections whose source message no
longer exists; backup replacement, version migration, and Remove backup still wipe
the affected local report state. The print view embeds readable source images,
re-reads every included attachment to capture labeled plaintext and stored-source
SHA-256 values, includes the exact source `sms.db` hashes captured during ingest,
and renders the selected messages as a transcript matching the Messages workspace:
sent/received alignment, service colors, attachment previews inside bubbles,
reactions/status, and full labeled timestamps. Neutral margin numbers link each
message to a separate metadata section after the transcript containing report notes,
participants, message GUID/row/raw timestamp fields, attachment source details/hashes,
and reaction provenance. The final appendix prints device/backup identity,
tool/build/export metadata, and methodology. Encrypted attachment preparation uses
the existing session-only password form and locks the worker again before printing.
Chrome's print dialog provides the PDF destination; print CSS forces a light,
shadow-free exhibit theme with repeated title/footer metadata and page counters.

The generated steampunk-automaton artwork is now integrated into the landing header,
active drag/drop overlay, unsupported-browser gate, and iPhone guide. Paired WebP assets
follow system, light, and dark themes without JavaScript theme selection, remain
decorative to assistive technology, and are omitted from printed reports without
leaving blank illustration columns. All variants are included in the PWA precache for
offline guide/theme changes; native lazy loading avoids downloading the hidden variant
during the initial page render, while the drag artwork is mounted and decoded before
the first drag.

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
