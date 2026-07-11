# iOS (iTunes/Finder) Backup Format Reference

Technical reference for implementing the iOS `BackupProvider`. Covers backup folder
structure, the manifest, the Messages database, contacts, and encrypted-backup crypto.
Verify details against a real backup before relying on them — Apple changes minor
details between iOS versions; this doc targets iOS 13–18 era backups.

## 1. Backup folder structure

A backup is a single folder (name = device UDID, 40-hex or 24-hex `XXXXXXXX-XXXXXXXXXXXXXXXX`
on newer devices) containing:

```
<UDID>/
  Info.plist          Device metadata (XML or binary plist)
  Manifest.plist      Backup metadata + keybag (binary plist)
  Manifest.db         SQLite index of all backed-up files (encrypted if backup is encrypted)
  Status.plist        Backup completion state
  00/ .. ff/          256 shard dirs; files stored by fileID hash
```

Every backed-up file is stored at `<first 2 hex of fileID>/<fileID>` where:

```
fileID = SHA1(domain + "-" + relativePath)   // lowercase hex
```

### Info.plist (unencrypted always)

Keys of interest: `Device Name`, `Display Name`, `Product Type` (e.g. `iPhone15,2`),
`Product Version` (iOS version), `Serial Number`, `Unique Identifier`/`Target Identifier`
(UDID), `Phone Number`, `IMEI`, `Last Backup Date`, `Installed Applications`.

Real `Info.plist` files can be much larger than the other root metadata plists because
the installed-application section may carry bulky app metadata. Detection keeps this
bounded separately from `Manifest.plist`/`Status.plist` (D-019).

### Manifest.plist (unencrypted always)

Keys: `IsEncrypted` (bool), `Version`, `Date`, `Lockdown` (device info dict),
`BackupKeyBag` (binary blob — see §5), `ManifestKey` (only in encrypted backups:
4-byte protection class LE + AES-wrapped key for Manifest.db).

### Manifest.db

SQLite. Main table:

```sql
Files(fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INT, file BLOB)
-- flags: 1 = file, 2 = directory, 4 = symlink
```

`file` is a binary plist (NSKeyedArchiver) holding an `MBFile` record: `Size`, `Mode`,
`ProtectionClass`, `LastModified`, and — in encrypted backups — `EncryptionKey`
(NSMutableData: 4-byte protection class LE + 40-byte AES-wrapped per-file key).
If root `Manifest.db-wal`/`Manifest.db-shm` sidecars exist, apply the WAL before
querying `Files`; uncheckpointed Manifest rows can otherwise hide source files.

## 2. Key files for our features

| Data | Domain | relativePath | fileID (SHA1) |
|---|---|---|---|
| Messages DB | `HomeDomain` | `Library/SMS/sms.db` | `3d0d7e5fb2ce288813306e4d4636395e047a3d28` |
| Message attachments | `MediaDomain` | `Library/SMS/Attachments/**` | (per file) |
| Contacts DB | `HomeDomain` | `Library/AddressBook/AddressBook.sqlitedb` | `31bb7ba8914766d4ba40d6dfb6113c8b614be442` |
| Contact images | `HomeDomain` | `Library/AddressBook/AddressBookImages.sqlitedb` | `cd6702cea29fe89cf280a76794405adb17f9a0ee` |

Attachment paths inside `sms.db` usually look like
`~/Library/SMS/Attachments/ab/11/<GUID>/file.heic`, but real rows may also carry
absolute device paths such as `/var/mobile/Library/SMS/Attachments/...` or
`/private/var/mobile/Library/SMS/Attachments/...`. Normalize by extracting the
`Library/SMS/Attachments/` suffix as the `MediaDomain` relativePath, then look that
path up in Manifest.db (don't recompute blindly — look up the path in `Files` to be
safe about edge cases).

Contact avatars in `AddressBookImages.sqlitedb`: `ABThumbnailImage` (and
`ABFullSizeImage`) rows join to contacts via `record_id` = `ABPerson.ROWID` in
`AddressBook.sqlitedb`. Multiple `format` variants per record exist across iOS
versions, and image blobs may carry a binary prefix — sniff for JPEG/PNG magic bytes
instead of assuming the image starts at offset 0. The database may be absent or empty;
treat that as a no-op (see Decisions.md D-015 for v1 scope).

## 3. sms.db schema (Messages)

Relevant tables and columns (schema varies slightly by iOS version — always feature-test
columns with `PRAGMA table_info`):

```
handle(ROWID, id /* phone/email */, service /* iMessage|SMS */, uncanonicalized_id)
chat(ROWID, guid, chat_identifier, service_name, display_name, style /* 43=group, 45=1:1 */)
chat_handle_join(chat_id, handle_id)
message(ROWID, guid, text, attributedBody /* BLOB */, handle_id, service,
        date, date_read, date_delivered,          /* Apple epoch, see below */
        is_from_me, is_read, is_sent, is_delivered,
        cache_has_attachments, item_type, group_action_type,
        associated_message_guid, associated_message_type,
        balloon_bundle_id, expressive_send_style_id,
        date_edited, date_retracted /* iOS 16+ edit/unsend */,
        subject, error, is_audio_message, ...)
chat_message_join(chat_id, message_id, message_date)
attachment(ROWID, guid, filename /* ~/Library/... */, mime_type, transfer_name,
           total_bytes, is_sticker, uti)
message_attachment_join(message_id, attachment_id)
```

### Timestamps

Apple epoch = 2001-01-01 00:00:00 UTC (Unix 978307200). Modern iOS stores
**nanoseconds** since Apple epoch; very old backups store seconds. Robust conversion:

```
unix_seconds = value > 1e12 ? value / 1e9 + 978307200 : value + 978307200
```

Store both the raw value and the converted UTC time (provenance).

### Message text: `text` vs `attributedBody`

On iOS 16+, `text` is frequently NULL and the real content is in `attributedBody` — a
**typedstream**-serialized `NSAttributedString` (legacy NeXTSTEP serialization, NOT a
binary plist / NSKeyedArchiver). We need a small typedstream parser that extracts the
`NSString` payload; attribute runs (mentions, links) can be ignored initially.
Fallback order: `text` → parsed `attributedBody` → empty (but still show the message
row; it may carry attachments or be an app/balloon message).

### Tapbacks / reactions

Rows with `associated_message_type` in 2000–2999 are reaction adds (2000–2005 are the
classic tapbacks: loved/liked/disliked/laughed/emphasized/questioned; iOS 17-era
custom/emoji reactions land above that). Treat the ranges as open-ended: fold any
unmapped add as a reaction of kind `unknown` — never drop it. 3000–3999 are removals:
divert them from the message timeline and do not emit a reaction for them.
`associated_message_guid` is `p:<part>/<target GUID>` or `bp:<target GUID>`. Fold these
onto their target message; never render them as timeline rows.

### Group chats & system events

`chat.style` 43 = group. `message.item_type` != 0 marks non-text events
(participant joined/left = 1 w/ `group_action_type`, name change = 2, photo change = 3);
render as inline system notices. Participants come from `chat_handle_join`, but the
sender of a specific message is `message.handle_id` (0 + `is_from_me`=1 means self).
For a group, `chat.display_name` is the explicit user-facing title; do not replace a
missing value with the first participant or opaque `chat_identifier`. The UI derives
an unnamed-group label from every non-self participant (D-036).

### Threads (inline replies, iOS 14+)

`thread_originator_guid` links a reply to its parent message. Initial rendering may
show these flat; preserve the column for later.

## 4. Contacts resolution (AddressBook.sqlitedb)

```
ABPerson(ROWID, First, Last, Organization, ...)
ABMultiValue(UID, record_id, property /* 3=phone, 4=email */, value)
```

Normalize phone numbers before matching `handle.id` (strip punctuation, compare last
7–10 digits, handle `+<country>` prefixes). Use `libphonenumber-js` (MIT) rather than
hand-rolling. Preserve `ABPerson.First` separately from the full resolved contact name
so unnamed groups can use concise first-name lists; unresolved handles display as the
raw number/email.

## 5. Encrypted backups

When `Manifest.plist:IsEncrypted` is true. All crypto is WebCrypto-implementable.

### 5.1 Keybag (`BackupKeyBag` blob)

Binary TLV stream: 4-byte ASCII type, 4-byte big-endian length, payload.
Header entries: `VERS`, `TYPE` (1 = backup keybag), `UUID`, `HMCK`, `WRAP`, `SALT`,
`ITER`, `DPWT`, `DPIC`, `DPSL`. Then repeated class-key blocks, each starting at a
`UUID` entry: `UUID`, `CLAS` (protection class number), `WRAP` (bitmask: 1 = wrapped
with device key — unavailable to us; 2 = wrapped with passcode key), `KTYP`, `WPKY`
(the wrapped 32-byte class key, 40 bytes).

### 5.2 Password → passcode key (iOS 10.2+)

```
intermediate = PBKDF2-SHA256(password_utf8, salt=DPSL, iterations=DPIC /* ~10,000,000 */, 32 bytes)
passcodeKey  = PBKDF2-SHA1(intermediate,   salt=SALT, iterations=ITER /* ~10,000 */,     32 bytes)
```

(If `DPSL`/`DPIC` are absent — pre-10.2 backups — only the second step applies, with the
raw password.) The DPIC step takes ~1–5 s with native WebCrypto; show progress. Wrong
password is detected when class-key unwrap fails (AES-KW has integrity built in).

### 5.3 Unwrapping and file decryption

- Class keys: `classKey = AES-KW-unwrap(passcodeKey, WPKY)` for entries with WRAP bit 2.
- `Manifest.db`: `ManifestKey` from `Manifest.plist` = 4-byte class LE + wrapped key;
  `dbKey = AES-KW-unwrap(classKey[class], wrappedKey)`; decrypt the whole file with
  **AES-256-CBC, zero IV**; result is a normal SQLite file.
- Per-file: from the file's `EncryptionKey` blob (class + wrapped key), unwrap with the
  matching class key, decrypt `<shard>/<fileID>` with AES-256-CBC zero IV, truncate to
  `Size` from the MBFile record. Treat that value as the authoritative logical
  plaintext length: real stored ciphertext can retain more than one aligned tail block,
  so it is not valid to require the ciphertext/`Size` difference to be at most one CBC
  padding block. Sparse files can also have a logical `Size` larger than the
  materialized encrypted prefix; decrypt that prefix and zero-extend the logical file
  to `Size`. Still require block-aligned ciphertext; caller read caps bind the logical
  plaintext size, with the stored ciphertext allowed up to one extra padding block
  (`maxReadBytes + 16`) — both checked before reading, allocating, or decrypting.

Keep unwrapped class keys in worker memory for the session; never persist them or the
password.

Golemine's M5/M5.5 implementation lives under `src/workers/backup/crypto/` with
session integration in `src/workers/backup/encrypted-session.ts` (D-038/D-041).
Manifest.db decrypts in bounded raw-CBC chunks into transient OPFS and accepts a valid
producer-appended PKCS suffix at a SQLite page boundary. MBFiles decrypt from bounded
`File` slices and truncate/extend to authoritative `Size`; database plaintext is
staged/imported without a full array, preview responses carry Blobs, and extraction
writes chunks directly to the chosen destination. Incremental plaintext and opt-in
ciphertext hashes remain distinct. Normalized attachment hashes refer to plaintext,
and report export re-reads the exact Manifest path to capture both labeled hashes.
Encrypted root Manifest WAL/SHM files are not applied because the
backup provides no independent root-sidecar key metadata. Wrong-password is determined
by AES-KW integrity before the ingest `prepare` boundary, while malformed and
unsupported keybags/ciphertext remain separate errors.

## 6. Gotchas checklist

- Feature-test columns per iOS version; never assume schema.
- `sms.db` may have WAL sidecars in the backup (`sms.db-wal`, `sms.db-shm` as separate
  backup files) — locate and apply them, or messages written since the last checkpoint
  are silently missing. Same for other DBs. When reconstructing a source DB from bytes,
  scan the WAL like SQLite: apply committed frames from the valid prefix, stop at the
  first invalid/stale/torn frame, and ignore frames after the last valid commit (D-022).
  Frames after that point can be uncommitted or stale and must not enter normalized
  output. Always force the copied main DB header to rollback-journal mode before the
  transient read-only sqlite-wasm open, even when no sidecar is present or no WAL frame
  commits; otherwise sqlite may try to open missing transient sidecars and report
  `SQLITE_CANTOPEN` (D-025).
- Deleted messages may linger in DB free pages; recovery is out of scope for now
  (documented as a future forensic feature — do not accidentally surface half-parsed
  deleted content as real messages).
- HEIC/HEIF attachments are the iPhone default photo format; videos are often HEVC in
  `.mov`. Live Photos = image + paired `.mov`.
- Plists come in XML and binary flavors; use one parser that handles both
  (or detect by magic `bplist00`).
- `attributedBody` typedstream parsing must be defensive — malformed/unknown versions
  skip to fallback, never crash ingest.
