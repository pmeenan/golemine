# Golemine Architecture

Browser-based, fully offline tool for exploring, searching, and extracting data from
phone backups (iPhone first, Android later), with court-exhibit-grade report export.
The name is Golem + Mine: a mechanical automaton that mines through backup data and
extracts the interesting bits — the worker pipeline (§3) is the golem doing the mining.

This document is the source of truth for how the system is structured. Read it before
making changes; update it when the structure changes. Product-level decisions and their
rationale live in [Decisions.md](Decisions.md). The iOS backup format details live in
[iOS-Backup-Format.md](iOS-Backup-Format.md). The build order lives in [Plan.md](Plan.md).
The visual design language (tokens, theming, component rules) lives in [Design.md](Design.md).

## 1. Product summary

- **Input:** a local iTunes/Finder iPhone backup folder (encrypted or unencrypted),
  opened via drag/drop or a directory picker. Android support comes later via the same
  provider abstraction.
- **Core features:** browse message threads, full-text search across all messages, view
  attachments (including HEIC/HEVC), select messages into a report, export a
  print-optimized report with forensic metadata (hashes, device info, timestamps).
- **Non-negotiables:** works entirely offline, never sends user data anywhere, never
  modifies the source backup, Chrome-only (free use of Chrome-specific APIs).

## 2. Platform constraints and choices

| Concern | Choice | Notes |
|---|---|---|
| Browser | Chrome only (latest stable) | File System Access API, OPFS, WebCodecs, `getAsFileSystemHandle()` all available. Chromium/Edge may work, but are not support targets. |
| Framework | React 19 + TypeScript (strict) + Vite | Pure client-side SPA, no SSR |
| Package manager | pnpm | Chosen for stable lockfiles, reproducible installs, and license-audit ergonomics |
| Hosting | User-controlled static hosting | No server-side app logic. Vite `base` should assume root hosting unless the deployment target changes. |
| Offline | Service worker via `vite-plugin-pwa` (Workbox) | Precache the app shell + wasm assets; app must fully work with no network after first load |
| CI | GitHub Actions for pull requests | Run lint, typecheck, unit tests, Playwright Chromium e2e, and license audit |
| SQLite | Official `@sqlite.org/sqlite-wasm` | Runs in a dedicated worker; `opfs-sahpool` VFS so COOP/COEP headers are NOT required |
| Media decode | libheif (wasm) for HEIC; native `<video>`/WebCodecs for HEVC where hardware allows; ffmpeg.wasm (single-threaded) as fallback | LGPL allowed only for unmodified, dynamically-loaded wasm codec modules — see AGENTS.md licensing rules |
| Worker RPC | Comlink (Apache-2.0) | Typed proxies over `postMessage`; transfer `ArrayBuffer`s, never copy large payloads |
| State | zustand (MIT) | UI state only; all data lives in the derived SQLite DB |
| Routing | react-router (MIT) | Client-side only |
| Styling/components | Tailwind CSS + shadcn/ui (Radix) — all MIT | Governed by the Lode design system: [Design.md](Design.md) |
| Virtualization | react-virtuoso (MIT) | Message lists can be 100k+ rows; nothing unvirtualized |
| Crypto | WebCrypto (PBKDF2, AES-KW, AES-CBC, SHA-256) | Encrypted-backup decryption and report hashing; no JS crypto libs for primitives |

**COOP/COEP:** we deliberately avoid `SharedArrayBuffer` dependencies (opfs-sahpool VFS,
single-threaded codecs) so the app can be hosted anywhere static files can be served,
with no special headers. If a future feature truly needs SAB (multithreaded ffmpeg),
that is a hosting decision to raise explicitly, not a silent dependency.

**Capability gate:** workspace routes are guarded at boot by `src/lib/capabilities.ts`.
The gate probes Chrome APIs rather than sniffing user agents. The
`createSyncAccessHandle` check is validated through a tiny capability worker because
that API is needed in the worker/OPFS runtime used by sqlite-wasm and is not reliably
exposed on the window prototype. The worker probe fails open when it cannot run
(timeout or worker startup failure) and blocks only on an explicit negative answer;
successful answers are cached in `sessionStorage`, and detection starts lazily via
`getBootBrowserCapabilities()` (D-017).

## 3. Process model: UI thread vs workers

The UI thread runs React and nothing else. All parsing, decryption, hashing, SQL, and
media decoding happens in dedicated workers. No task on the main thread may block for
more than ~16 ms.

```
┌─────────────────────────────── UI thread (React) ───────────────────────────────┐
│  Landing / Recents / Thread browser / Search / Report builder / Info pages      │
└──────┬──────────────────────────┬──────────────────────────┬────────────────────┘
       │ Comlink                  │ Comlink                  │ Comlink
┌──────▼─────────┐        ┌───────▼────────┐        ┌────────▼───────┐
│ backup-worker  │        │   db-worker    │        │  media-worker  │
│ FS scanning    │        │ sqlite-wasm    │        │ HEIC decode    │
│ Manifest parse │        │ derived DB     │        │ thumbnails     │
│ decryption     │        │ FTS5 queries   │        │ video fallback │
│ extraction     │        │ ingest writes  │        │ (ffmpeg.wasm)  │
│ SHA-256 hashing│        │ (opfs-sahpool) │        │                │
└──────┬─────────┘        └───────┬────────┘        └────────────────┘
       │  reads (read-only)       │  reads/writes
┌──────▼──────────────┐   ┌───────▼─────────────────┐
│ Source backup folder│   │ OPFS (browser storage)  │
│ (user's disk, via   │   │ per-backup derived data │
│ directory handle)   │   │ + thumbnails cache      │
└─────────────────────┘   └─────────────────────────┘
```

- **backup-worker** — owns the source `FileSystemDirectoryHandle` after the UI obtains
  it through a user gesture and hands it off. Validates the backup, parses
  `Info.plist`/`Manifest.plist`/`Manifest.db`, performs keybag/password key derivation
  and per-file decryption for encrypted backups, streams file bytes to other workers,
  computes SHA-256 hashes for provenance. This is the only component that touches the
  source folder, and it only ever reads; source access should go through read-only
  wrapper helpers so writable handles never enter provider code.
- **db-worker** — hosts sqlite-wasm. Owns the per-backup derived database in OPFS
  (normalized messages + FTS5 index + report selections). All queries the UI needs are
  RPC methods here; the UI never sees raw SQL.
- **media-worker** — decodes HEIC to RGBA/PNG, generates and caches thumbnails in OPFS,
  transcodes/extracts frames for unsupported video as a fallback. Codec wasm modules are
  lazy-loaded only when first needed.

Ingest (the one long-running pipeline) flows backup-worker → db-worker with progress
events surfaced to the UI (phase, counts, ETA). Ingest is resumable/restartable: if
interrupted, the derived DB is rebuilt from scratch (source is the source of truth).

## 4. Storage model

**The source backup is read in place and never copied wholesale or modified.**

- **IndexedDB** (small metadata only): the recents list — one record per known backup:
  `{ id, friendlyName, directoryHandle, deviceInfo snapshot, isEncrypted, lastOpened,
  ingestStatus, derivedDbVersion }`. `FileSystemDirectoryHandle` is structured-cloneable
  and persists across sessions; reopening a recent backup requires one
  `requestPermission()` user gesture. The storage facade lives in
  `src/lib/recents.ts` and owns rename/remove helpers plus permission re-grant helpers.
  Detection results are written through `BackupRecentsStore.recordDetection`, which
  preserves user renames and ingest status when a known backup is re-opened from any
  entry point, applies the `derivedDbVersion` staleness rule, and retires stale
  records (including their orphaned derived-data directories) when a folder detects
  under a new identity. Malformed stored records are skipped and reported rather
  than failing the whole list.
- **OPFS** (bulk derived data): one directory per backup under
  `golemine/backups/`, keyed by backup UDID when known and falling back to the recents
  id before detection has a UDID:
  - `golemine.sqlite` — the normalized message store + FTS5 index (schema below).
  - `thumbs/` — cached attachment thumbnails (content-addressed by attachment hash).
- Request `navigator.storage.persist()` on first ingest so Chrome doesn't evict data.
- Derived data is always disposable: deleting a backup from recents deletes its OPFS
  directory through `src/lib/recents.ts`; the source folder is untouched. A
  `derivedDbVersion` bump forces re-ingest after schema changes.
- `derivedDbVersion` is a single shared constant in source code. UI recents, db-worker
  schema setup, ingest invalidation, and tests must import that constant rather than
  duplicating version numbers.

For encrypted backups, the derived DB in OPFS contains **decrypted** message content
(that's the point of the index). The UI must clearly state this, and "Remove backup"
must wipe it. Passwords are held in memory only, never persisted.

## 5. Backup provider abstraction

Everything downstream of ingest works on a normalized model. Each backup format is a
`BackupProvider` implementation; the iPhone provider is the reference implementation and
the Android provider (format TBD — see Decisions.md D-007) plugs in later.

```ts
interface BackupProvider {
  id: string;                              // 'ios-itunes', later 'android-...'
  detect(root: ReadonlySourceDirectoryHandle): Promise<DetectResult>; // is this ours? encrypted?
  open(root, opts: { password?: string }): Promise<BackupSession>;
}

interface BackupSession {
  deviceInfo: DeviceInfo;                  // name, model, OS version, UDID, serial, phone number
  capabilities: Capability[];              // ['messages', 'contacts', ...]
  ingest(sink: IngestSink, progress: ProgressFn): Promise<IngestReport>;
  readAttachment(ref: AttachmentRef): Promise<ReadableStream>; // decrypts on the fly if needed
  hashSourceFile(ref: SourceFileRef): Promise<Sha256>;         // provenance for reports
}
```

At the worker RPC boundary, `BackupWorkerApi.detectBackup(root, progress?)` accepts the
structured-cloned `FileSystemDirectoryHandle` from the UI and immediately wraps it with
`asReadonlySourceDirectory()`. Provider detection/opening code accepts
`ReadonlySourceDirectoryHandle`; raw writable-capable source handles do not cross into
provider modules. Detection results carry the normalized `BackupDeviceInfo`
(name, model, osVersion, udid, serialNumber, phoneNumber): the iOS provider
translates Apple plist keys into that shape internally, so UI routes and the recents
store never see provider-specific field names.

`IngestSink` receives normalized entities and is implemented by the db-worker:

- **Conversation** — thread; 1:1 or group; participants; display name; service.
- **Participant** — handle (phone/email), resolved contact name, is-self flag.
- **Message** — conversation ref, sender, UTC timestamp (+ raw source timestamp),
  body text, service (iMessage/SMS), status (sent/delivered/read timestamps),
  edited/unsent flags, source GUID + source row id (provenance).
- **Attachment** — message ref, filename, MIME, size, source path ref, transfer name.
- **Reaction** — tapbacks etc., linked to their target message, never shown as rows.

Rule: provider-specific quirks (Apple epochs, `attributedBody` parsing, tapback
encodings) are resolved **inside the provider** at ingest time. The normalized model and
everything above it is provider-agnostic.

## 6. Derived database schema (OPFS, per backup)

SQLite via sqlite-wasm, FTS5 for search. Sketch (authoritative version lives in code
under `src/workers/db/schema.ts`):

```sql
conversations(id, provider_key, kind, display_name, service, last_message_at, message_count)
participants(id, handle, kind, contact_name, is_self)
conversation_participants(conversation_id, participant_id)
messages(id, conversation_id, sender_id, sent_at_utc, raw_timestamp, body, service,
         is_from_me, date_delivered, date_read, edited, unsent,
         source_guid, source_rowid)              -- provenance
attachments(id, message_id, filename, mime, bytes, source_path, source_domain, sha256)
reactions(id, target_message_id, sender_id, kind, sent_at_utc)
messages_fts(body)   -- FTS5, external-content table on messages
report_items(report_id, message_id, added_at, note)
reports(id, title, created_at, case_meta_json)
ingest_meta(key, value)  -- provider id/version, source hashes, ingest timestamps, counts
```

Search = FTS5 `MATCH` with filters (conversation, participant, date range, has-attachment)
compiled into SQL in the db-worker. Results return message ids + snippets; the UI
navigates to the message in its thread context.

## 7. UI structure

Routes (react-router, all client-side):

- `/` — landing: what the tool is, privacy statement ("your data never leaves this
  machine"), drag/drop + open-folder entry points, recents list (rename/remove).
- `/guide/iphone`, `/guide/android` — static how-to-back-up-your-phone pages.
- `/backup/:id` — backup overview: device info, ingest status/progress, capability tiles.
- `/backup/:id/messages` — three-pane messages UI: thread list (virtualized, sorted by
  recency) → message timeline (virtualized, bubble rendering, attachment previews,
  reactions badged onto their target) → detail/metadata panel for a selected message.
- `/backup/:id/search` — query + filters, result list with snippets, jump-to-context.
- `/backup/:id/report/:reportId` — report builder: ordered selected messages, case
  metadata form, print preview.
- `/backup/:id/report/:reportId/print` — print-optimized rendering (see §8).

UX rules: every long operation streams progress; the UI is never frozen or spinner-only
when partial results exist; message text from backups is **untrusted input** — always
rendered as text nodes, never HTML. All visual/interaction design follows
[Design.md](Design.md), including mandatory light + dark themes (system-auto with
manual override) and the token-only styling rule.

## 8. Reports (court-exhibit grade)

A report is a curated, ordered set of messages plus case metadata, rendered as paginated
print-CSS HTML and exported via Chrome's print-to-PDF (direct pdf-lib generation is a
later enhancement).

Every report includes a **provenance appendix**, generated at export time:

- Device identity: name, model, iOS version, UDID, serial number, phone number (from `Info.plist`).
- Backup identity: backup date, encrypted flag, source folder name.
- Integrity: SHA-256 of the source message database (`sms.db`) and of every attachment
  file included in the report, computed from the **source** bytes (for encrypted
  backups: hash of the encrypted source file, plus hash of decrypted content, both
  labeled as such).
- Extraction record: tool name + version + commit, export timestamp (UTC), timezone used
  for displayed timestamps (explicitly labeled on every page).
- Per-message provenance: source GUID, source row id, raw timestamp value alongside the
  human-readable rendering.
- Methodology note: brief fixed text describing how data was read (read-only, from an
  iTunes/Finder backup) and a pointer to the open-source code.

Timestamps: stored as UTC + raw source value; displayed in a user-selected timezone
(default: report author's choice, defaulting to device-local if known), with the
timezone printed on the report. Never display an ambiguous local time.

## 9. Encrypted backups

Supported from an early milestone (see Plan.md M4). All crypto runs in backup-worker
using WebCrypto only:

1. Parse the keybag from `Manifest.plist`; derive the password key
   (PBKDF2-SHA256 with ~10M iterations, then PBKDF2-SHA1 — details in
   [iOS-Backup-Format.md](iOS-Backup-Format.md) §5).
2. Unwrap class keys (AES-KW), unwrap the `ManifestKey`, decrypt `Manifest.db`
   (AES-256-CBC), then decrypt individual files on demand using their per-file wrapped
   keys from `Manifest.db`.

Password handling: prompted per session, held only in worker memory, wrong-password
detected via keybag unwrap failure. Derived class keys may be kept for the session so
attachments decrypt on demand without re-deriving (~seconds of PBKDF2).

## 10. Security & privacy posture

- **No network I/O with user data, ever.** The service worker serves everything after
  first load; the only permissible fetches are same-origin app assets. No analytics, no
  telemetry, no CDN-loaded code.
- **Network/offline behavior is test-enforced.** Playwright intercepts requests after
  app load and fails on unexpected network access; offline reload of the installed app
  shell is part of the M0 acceptance suite.
- **Production assets use a static-host CSP header template.** The M0 template lives in
  `public/_headers` so hosts that support static header files copy it into `dist/`.
  Scripts and `connect` are same-origin only; other asset types stay loose enough for
  generated static assets (`data:`/`blob:`) and workers. Compiling wasm (sqlite-wasm,
  libheif) in Chrome requires `script-src 'wasm-unsafe-eval'` — include it; it does not
  permit JS `eval`. Do not use a meta CSP for this app: it breaks Vite dev, cannot
  enforce `frame-ancestors`, and makes the pre-paint theme script hash-fragile.
- **Source backups are read-only.** No code path receives a writable handle to the
  source folder.
- **Backup content is hostile input.** SQL from backups is parsed by SQLite (wasm
  sandbox); strings are never interpolated into HTML/SQL; plist/typedstream parsers must
  be bounds-checked and fuzz-tolerant (malformed input → skip + log, never crash ingest).
- **Wasm modules are vendored/pinned**, loaded same-origin, and covered by the license
  audit (see AGENTS.md).

## 11. Repository layout (target)

```
/                     Vite app root
  src/
    app/              routes, layout, providers
    components/       shared UI components
    features/         landing/, recents/, messages/, search/, report/, guides/
    workers/
      backup/         backup-worker: providers/ios/, crypto/, plist/, typedstream/
      db/             db-worker: schema, queries, ingest sink, FTS
      media/          media-worker: heic, thumbs, video fallback
    lib/              shared utils (time, bytes, comlink helpers, types)
    assets/           bundled images: brand/ (icon master), illustrations/ (light/dark WebP pairs)
  public/             static assets, wasm binaries
    _headers          static-host security headers (CSP)
    theme-init.js     pre-paint theme preference script
    og-image.png      1200×630 social card (absolute URL in index.html OG tags)
  docs/               this documentation
    assets/           repo-facing images (README banner, golem character sheet)
  e2e/                Playwright Chromium tests
    fixtures/         synthetic fixture metadata + generator stubs (no real personal data)
  .github/workflows/  pull-request CI (lint, typecheck, unit, e2e, license audit)
```

Test strategy: Vitest for unit tests (parsers get golden-file tests against small
fixture backups checked into `e2e/fixtures/` — synthetic, no real personal data ever in
the repo, with generator scripts/metadata kept alongside them); Playwright (Chromium)
for end-to-end flows including drag/drop ingest, offline/privacy invariants, and report
printing.

The first generated fixture is `e2e/fixtures/generated/ios-mini-backup/`, a minimal
synthetic iPhone backup root used by the M1 open -> detect -> recents Playwright flow.
