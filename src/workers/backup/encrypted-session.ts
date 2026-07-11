import {
  type BackupDetectionResult,
  type ReadSourceFileRequest,
  type UnlockBackupSessionRequest,
  type UnlockBackupSessionResponse,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
  toWorkerError,
  workerFail,
  workerOk,
} from "../../lib/worker-types";
import { emitWorkerProgress } from "../shared/progress";
import {
  BackupCryptoError,
  type CbcChunkProgressCallback,
  type KdfProgressEvent,
  type UnlockedBackupKeybag,
  unlockBackupKeybag,
} from "./crypto";
import {
  BackupDetectionError,
  backupIdMatchesDetection,
  detectIosBackup,
  maxCompanionRootPlistBytes,
} from "./ios-backup";
import {
  ManifestDbReader,
  type DecryptedPlaintextDestination,
  type ManifestFileRecord,
  type ReadEncryptedSourceFileBytesOptions,
  type ReadSourceFileBytesOptions,
  type SourceFileBlob,
  type SourceFileBytes,
  type SourceFileChunkSink,
  type SourceFileInfo,
  decryptSourceFileToDestination,
  getStoredSourceFile,
  readEncryptedSourceFileBytes,
  readEncryptedSourceFileBlob,
  writeEncryptedSourceFileToSink,
  SourceFileDecryptionError,
  SourceFileTooLargeError,
} from "./manifest-db";
import {
  getPlistData,
  isPlistDictionary,
  parsePlist,
} from "./plist";
import {
  asReadonlySourceDirectory,
  isSameDirectoryHandle,
  type ReadonlySourceDirectoryHandle,
} from "./read-only-source";

/**
 * Encrypted-read options: the shared byte-budget/provenance options plus
 * encryption-internal chunk controls that only this session understands.
 * Keeping the decrypt knobs here (not on the generic read options) makes
 * passing them to an unencrypted read a type error instead of a silent no-op.
 */
export interface EncryptedSessionReadOptions
  extends ReadSourceFileBytesOptions {
  decryptChunkBytes?: number;
  decryptProgress?: CbcChunkProgressCallback;
}

/**
 * Session-lifetime guard passed to a caller-owned tracked operation. It
 * deliberately exposes no password or key material. `finalize` performs the
 * last synchronous activity check while the operation is still registered,
 * immediately before the caller returns its RPC response.
 */
export interface EncryptedSessionTrackedOperation {
  assertActive(): void;
  finalize<TValue>(value: TValue): TValue;
}

export interface EncryptedBackupSessionContext {
  readonly backupId: string;
  readonly root: ReadonlySourceDirectoryHandle;
  readonly detection: BackupDetectionResult;
  readonly manifest: ManifestDbReader;
  assertActive(): void;
  runTrackedOperation<TValue>(
    operation: (
      tracked: EncryptedSessionTrackedOperation,
    ) => Promise<TValue>,
  ): Promise<TValue>;
  /**
   * Bounded in-memory decrypt of one source file (eager hashing, previews).
   * The returned bytes are the caller's to zeroize; a session lock racing the
   * read zeroizes them before the tracked promise rejects.
   */
  readSourceFile(
    record: ManifestFileRecord,
    options?: EncryptedSessionReadOptions,
  ): Promise<SourceFileBytes>;
  /**
   * Decrypts one source file into session-owned transient OPFS staging and
   * returns it as a Blob (WAL/SHM sidecar payloads for database opens, which
   * can be too large for memory but are consumed as read-only Blobs). The
   * staged plaintext is retained by the session until the caller's
   * `cleanup()` or session lock/eviction removes it. Main databases do not
   * use this path: they decrypt-stream straight into the source-sqlite
   * workspace through `stageSourceFile`.
   */
  readSourceFileBlob(
    record: ManifestFileRecord,
    options?: EncryptedSessionReadOptions,
  ): Promise<SourceFileBlob>;
  /**
   * Decrypt-streams one source file into a caller-owned destination (the
   * source-sqlite workspace's staged main file) inside one tracked session
   * operation, so an explicit lock drains for the full stage duration. No
   * session-retained plaintext copy is created; the caller owns the
   * destination's lifetime. Returns plaintext/stored digests and provenance.
   */
  stageSourceFile(
    record: ManifestFileRecord,
    destination: DecryptedPlaintextDestination,
    options?: EncryptedSessionReadOptions,
  ): Promise<SourceFileInfo>;
  /**
   * Streams the decrypted source file into `sink` inside one tracked session
   * operation. `finalize` runs inside that tracked window, after the full
   * plaintext has been written and hashed but before the runner's final
   * activity check: callers place their commit point (e.g. closing an atomic
   * writable) there. A lock landing after `finalize` succeeded still rejects
   * the returned promise, so committed callers must capture their result
   * inside `finalize` and treat that rejection as post-commit.
   */
  writeSourceFile(
    record: ManifestFileRecord,
    sink: SourceFileChunkSink,
    options?: EncryptedSessionReadOptions,
    finalize?: (source: SourceFileInfo) => Promise<void>,
  ): Promise<SourceFileInfo>;
  /** Verifies and immediately zeroizes a per-file key before ingest prepare. */
  verifySourceFileKey(record: ManifestFileRecord): Promise<void>;
}

interface EncryptedBackupSessionCacheEntry
  extends EncryptedBackupSessionContext {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly keybag: UnlockedBackupKeybag;
  readonly abortController: AbortController;
  readonly activeReads: Set<Promise<unknown>>;
  readonly stagedSourceBlobs: Set<SourceFileBlob>;
}

interface EncryptedManifestMaterial {
  keybagBytes: Uint8Array;
  manifestKey: Uint8Array;
}

let activeEncryptedSession: EncryptedBackupSessionCacheEntry | undefined;
let sessionEpoch = 0;
let sessionMutationTail: Promise<void> = Promise.resolve();

export class BackupSessionError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly details?: Record<string, WorkerStructuredValue>,
    readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "BackupSessionError";
  }
}

export async function unlockBackupSession(
  rootHandle: FileSystemDirectoryHandle,
  request: UnlockBackupSessionRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<UnlockBackupSessionResponse>> {
  const requestEpoch = captureEncryptedSessionEpoch();
  let password: string | undefined = request.password;

  // The request is a worker-owned structured clone. Clear it at the public
  // boundary; only the narrow open/KDF call below receives the string.
  request.password = "";

  try {
    await emitWorkerProgress(
      "backup",
      progress,
      "starting",
      "Checking encrypted backup identity",
      0,
      3,
    );

    const root = asReadonlySourceDirectory(rootHandle);
    const detection = await detectIosBackup(root);
    assertBackupIdMatches(request.backupId, detection);

    if (!detection.isEncrypted) {
      await resetEncryptedBackupSession();
      await emitWorkerProgress(
        "backup",
        progress,
        "complete",
        "Backup does not require a password",
        3,
        3,
      );
      return workerOk({ backupId: detection.id, isEncrypted: false });
    }

    const openPromise = openEncryptedBackupSession(
      rootHandle,
      root,
      detection,
      password,
      progress,
      requestEpoch,
    );
    password = undefined;
    const session = await openPromise;

    await emitWorkerProgress(
      "backup",
      progress,
      "complete",
      "Encrypted backup unlocked",
      3,
      3,
    );
    // A concurrent explicit lock/root replacement may run while the proxied
    // completion callback is pending. Never report an already-evicted unlock.
    session.assertActive();

    return workerOk({ backupId: detection.id, isEncrypted: true });
  } catch (cause) {
    return workerFail(toBackupSessionWorkerError(cause));
  } finally {
    password = undefined;
  }
}

export async function openEncryptedBackupSession(
  rootHandle: FileSystemDirectoryHandle,
  root: ReadonlySourceDirectoryHandle,
  detection: BackupDetectionResult,
  password: string | undefined,
  progress?: WorkerProgressCallback,
  requestEpoch = captureEncryptedSessionEpoch(),
): Promise<EncryptedBackupSessionContext> {
  return withSessionMutation(() =>
    openEncryptedBackupSessionLocked(
      rootHandle,
      root,
      detection,
      password,
      progress,
      requestEpoch,
    ),
  );
}

async function openEncryptedBackupSessionLocked(
  rootHandle: FileSystemDirectoryHandle,
  root: ReadonlySourceDirectoryHandle,
  detection: BackupDetectionResult,
  password: string | undefined,
  progress: WorkerProgressCallback | undefined,
  requestEpoch: number,
): Promise<EncryptedBackupSessionContext> {
  assertSessionRequestActive(requestEpoch, detection.id);
  const existing = await matchingActiveSessionLocked(
    rootHandle,
    detection.id,
    requestEpoch,
  );
  assertSessionRequestActive(requestEpoch, detection.id);

  // Only a caller that supplies no password may reuse the unlocked session
  // (session-based access). A caller that supplies a password is asking for
  // that credential to be verified; never report success for a password that
  // was never checked — fall through to a full unlock, which replaces the
  // active session and fails with backup_password_incorrect when wrong.
  if (existing !== undefined && (password === undefined || password.length === 0)) {
    return existing;
  }

  if (password === undefined || password.length === 0) {
    throw new BackupSessionError(
      "backup_password_required",
      "Enter the encrypted backup password to continue.",
      true,
      { backupId: detection.id },
    );
  }

  await evictActiveEncryptedSession();

  await emitWorkerProgress(
    "backup",
    progress,
    "unlocking",
    "Reading encrypted backup key material",
    1,
    3,
  );

  const material = await readEncryptedManifestMaterial(root);
  let keybag: UnlockedBackupKeybag | undefined;
  let manifest: ManifestDbReader | undefined;

  try {
    const unlockPromise = unlockBackupKeybag(
      material.keybagBytes,
      password,
      (event) => emitKdfProgress(progress, event),
    );
    password = undefined;
    const unlockedKeybag = await unlockPromise;
    keybag = unlockedKeybag;

    await emitWorkerProgress(
      "backup",
      progress,
      "decrypting",
      "Decrypting Manifest.db file index",
      2,
      3,
    );

    // Skip-and-report: corrupt sibling class-key records must not make the
    // whole backup unopenable when the classes this backup needs unwrapped
    // with the verified password (hard rule 4). Files in a failed class stay
    // unreadable and surface as unsupported at read time.
    for (const warning of unlockedKeybag.warnings) {
      console.warn(
        `Skipped a backup keybag class key that failed its integrity check (protection class ${String(warning.protectionClass)}).`,
      );
    }

    manifest = await ManifestDbReader.open(root, {
      backupId: detection.id,
      decryptMainChunks: (encryptedFile) =>
        unlockedKeybag.decryptManifestDatabaseChunks(
          encryptedFile,
          material.manifestKey,
        ),
    });

    // A synchronous lock/reset can run while any awaited WebCrypto, progress,
    // file, or SQLite operation above is pending. Never publish a context
    // whose request epoch was superseded; the catch path closes/destroys it.
    assertSessionRequestActive(requestEpoch, detection.id);

    const session: EncryptedBackupSessionCacheEntry = {
      backupId: detection.id,
      root,
      rootHandle,
      detection,
      manifest,
      keybag: unlockedKeybag,
      abortController: new AbortController(),
      activeReads: new Set<Promise<unknown>>(),
      stagedSourceBlobs: new Set<SourceFileBlob>(),
      assertActive(): void {
        assertSessionReadActive(this);
      },
      runTrackedOperation<TValue>(
        operation: (
          tracked: EncryptedSessionTrackedOperation,
        ) => Promise<TValue>,
      ): Promise<TValue> {
        const trackedOperation: EncryptedSessionTrackedOperation = {
          assertActive: () => {
            assertSessionReadActive(this);
          },
          finalize: <TResult>(value: TResult): TResult => {
            assertSessionReadActive(this);
            return value;
          },
        };
        return runTrackedSessionOperation(this, () =>
          operation(trackedOperation),
        );
      },
      readSourceFile(record, options): Promise<SourceFileBytes> {
        return runTrackedSessionOperation(
          this,
          () =>
            readEncryptedSourceFile(
              this.root,
              this.keybag,
              record,
              options,
              this.abortController.signal,
            ),
          (source) => {
            source.bytes.fill(0);
          },
        );
      },
      readSourceFileBlob(record, options): Promise<SourceFileBlob> {
        return runTrackedSessionOperation(
          this,
          () =>
            readEncryptedSourceFileAsBlob(
              this.root,
              this.keybag,
              this.backupId,
              record,
              options,
              this.abortController.signal,
            ).then((source) => retainSessionSourceBlob(this, source)),
          (source) => source.cleanup(),
        );
      },
      stageSourceFile(record, destination, options): Promise<SourceFileInfo> {
        return runTrackedSessionOperation(this, () =>
          stageEncryptedSourceFile(
            this.root,
            this.keybag,
            record,
            destination,
            options,
            this.abortController.signal,
          ),
        );
      },
      writeSourceFile(record, sink, options, finalize): Promise<SourceFileInfo> {
        return runTrackedSessionOperation(this, async () => {
          const source = await writeEncryptedSourceFile(
            this.root,
            this.keybag,
            record,
            sink,
            options,
            this.abortController.signal,
          );
          await finalize?.(source);
          return source;
        });
      },
      verifySourceFileKey(record): Promise<void> {
        return runTrackedSessionOperation(this, () =>
          verifyEncryptedSourceFileKey(this.keybag, record),
        );
      },
    };

    activeEncryptedSession = session;

    return session;
  } catch (cause) {
    try {
      manifest?.close();
      await manifest?.cleanup();
    } catch {
      // Cleanup is best-effort and must not mask the unlock/decrypt failure;
      // SourceSqliteDatabase.close still unlinks in its own finally path.
    } finally {
      keybag?.destroy();
    }
    throw mapCryptoCause(cause, detection.id);
  } finally {
    // These are copies from parsed Manifest.plist, not views into source
    // storage. Clear the temporary key blobs once WebCrypto imports complete.
    material.keybagBytes.fill(0);
    material.manifestKey.fill(0);
  }
}

export async function requireEncryptedBackupSession(
  rootHandle: FileSystemDirectoryHandle,
  request: Pick<ReadSourceFileRequest, "backupId">,
  detection: BackupDetectionResult,
): Promise<EncryptedBackupSessionContext> {
  const suppliedBackupId = request.backupId?.trim();
  // Unlike find(), an absent request id resolves against the detection id
  // (the caller has already detected this root) rather than whatever session
  // happens to be active.
  const requestedBackupId =
    suppliedBackupId === undefined || suppliedBackupId.length === 0
      ? detection.id
      : suppliedBackupId;
  const session = await findEncryptedBackupSession(
    rootHandle,
    requestedBackupId,
  );

  if (session !== undefined) {
    return session;
  }

  throw new BackupSessionError(
    "backup_password_required",
    "Unlock this encrypted backup before reading attachments.",
    true,
    { backupId: requestedBackupId },
  );
}

export async function findEncryptedBackupSession(
  rootHandle: FileSystemDirectoryHandle,
  backupId?: string,
): Promise<EncryptedBackupSessionContext | undefined> {
  const requestEpoch = captureEncryptedSessionEpoch();
  const normalizedBackupId = backupId?.trim();
  const activeBackupId = activeEncryptedSession?.backupId;

  const requestedBackupId =
    normalizedBackupId !== undefined && normalizedBackupId.length > 0
      ? normalizedBackupId
      : activeBackupId;

  if (requestedBackupId === undefined) {
    return undefined;
  }

  return withSessionMutation(() =>
    matchingActiveSessionLocked(rootHandle, requestedBackupId, requestEpoch),
  );
}

/**
 * Immediately invalidates retained keys, then waits for every active read and
 * every session mutation already queued at lock time to settle. Once this
 * resolves, no old-session read can newly return plaintext.
 */
export async function resetEncryptedBackupSession(): Promise<void> {
  sessionEpoch += 1;
  const mutationSnapshot = sessionMutationTail;
  const readsDrained = clearActiveEncryptedSession();

  await Promise.all([readsDrained, mutationSnapshot]);
}

export function captureEncryptedSessionEpoch(): number {
  return sessionEpoch;
}

async function clearActiveEncryptedSession(): Promise<void> {
  const session = activeEncryptedSession;
  activeEncryptedSession = undefined;

  if (session === undefined) {
    return;
  }

  session.abortController.abort();
  session.keybag.destroy();

  // Keys are already destroyed, so no read can newly produce plaintext.
  // Drain the tracked reads BEFORE closing the transient Manifest sqlite
  // copy so an in-flight read cannot observe a closed database handle and
  // surface a raw sqlite error instead of the recoverable session code.
  await Promise.allSettled([...session.activeReads]);

  // Session-retained staged plaintext comes only from readSourceFileBlob
  // (encrypted WAL/SHM sidecar staging for ingest database opens); bounded
  // preview reads decrypt in memory and main databases decrypt-stream into
  // caller-owned workspaces, so neither registers here. Ingest cleans up its
  // own staged sidecars, but a lock that races the open window must still
  // guarantee no staged plaintext survives session teardown, so the sweep
  // stays.
  const cleanupFailures: unknown[] = [];
  const stagedResults = await Promise.allSettled(
    [...session.stagedSourceBlobs].map((source) => source.cleanup()),
  );
  session.stagedSourceBlobs.clear();
  for (const result of stagedResults) {
    if (result.status === "rejected") {
      cleanupFailures.push(result.reason as unknown);
    }
  }

  try {
    session.manifest.close();
  } catch (cause) {
    cleanupFailures.push(cause);
  }

  try {
    await session.manifest.cleanup();
  } catch (cause) {
    cleanupFailures.push(cause);
  }

  if (cleanupFailures.length === 1) {
    throw cleanupFailures[0];
  }
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      "Could not fully remove encrypted-session plaintext staging.",
    );
  }
}

/**
 * Eviction/replace-unlock variant of {@link clearActiveEncryptedSession}: the
 * old session's keys are still destroyed and its tracked reads drained before
 * this resolves, but staging-cleanup failures are logged instead of thrown so
 * a NEW operation (opening a different backup, or re-verifying a supplied
 * password) never fails on the OLD session's cleanup problems. The explicit
 * lock RPC keeps the throwing variant: its caller falls back to terminating
 * the worker when cleanup cannot be guaranteed.
 */
async function evictActiveEncryptedSession(): Promise<void> {
  try {
    await clearActiveEncryptedSession();
  } catch (cause) {
    console.warn(
      "Could not fully remove the evicted encrypted session's plaintext staging.",
      cause,
    );
  }
}

/**
 * Registers a staged source Blob for the session-teardown sweep. Never throws:
 * the tracked runner's post-resolve activity check (with its cleanup discard
 * hook) owns invalidation, so failing here would only orphan the staged file.
 */
function retainSessionSourceBlob(
  session: EncryptedBackupSessionCacheEntry,
  source: SourceFileBlob,
): SourceFileBlob {
  const originalCleanup = source.cleanup.bind(source);
  let cleanupPromise: Promise<void> | undefined;

  source.cleanup = () => {
    cleanupPromise ??= originalCleanup().finally(() => {
      session.stagedSourceBlobs.delete(source);
    });
    return cleanupPromise;
  };
  session.stagedSourceBlobs.add(source);
  return source;
}

async function matchingActiveSessionLocked(
  rootHandle: FileSystemDirectoryHandle,
  backupId: string,
  requestEpoch: number,
): Promise<EncryptedBackupSessionCacheEntry | undefined> {
  if (requestEpoch !== sessionEpoch) {
    return undefined;
  }

  const session = activeEncryptedSession;

  if (session === undefined) {
    return undefined;
  }

  if (session.backupId !== backupId) {
    await evictActiveEncryptedSession();
    return undefined;
  }

  const sameRoot = await isSameDirectoryHandle(session.rootHandle, rootHandle);

  // resetEncryptedBackupSession synchronously invalidates keys before its
  // returned drain promise resolves. It may run while isSameEntry is pending;
  // re-check both the cancellation epoch and object identity after the await.
  if (requestEpoch !== sessionEpoch || activeEncryptedSession !== session) {
    return undefined;
  }

  if (!sameRoot) {
    await evictActiveEncryptedSession();
    return undefined;
  }

  return session;
}

/**
 * The single session-lifetime mechanism for source-touching work. It
 * registers the operation in the session's tracked set so an explicit lock or
 * eviction drains it for its full duration, asserts the session is active
 * before starting and again after the operation resolves, and maps failures
 * observed after a lock aborted the session to the recoverable needs-password
 * error. When the post-resolve activity check fails, the optional `discard`
 * hook runs first (and is awaited before the drain completes) so resolved
 * plaintext the caller will never receive — bytes buffers, staged blobs — is
 * zeroized or removed instead of outliving the lock.
 */
function runTrackedSessionOperation<TValue>(
  session: EncryptedBackupSessionCacheEntry,
  operation: () => Promise<TValue>,
  discard?: (value: TValue) => void | Promise<void>,
): Promise<TValue> {
  const pending = (async () => {
    assertSessionReadActive(session);
    let value: TValue;

    try {
      value = await operation();
    } catch (cause) {
      if (session.abortController.signal.aborted) {
        throw new BackupSessionError(
          "backup_password_required",
          "The encrypted backup session was locked during the source read.",
          true,
          { backupId: session.backupId },
          cause,
        );
      }
      throw cause;
    }

    try {
      assertSessionReadActive(session);
    } catch (cause) {
      await discard?.(value);
      throw cause;
    }
    return value;
  })();
  const tracked = pending.finally(() => {
    session.activeReads.delete(tracked);
  });
  session.activeReads.add(tracked);
  return tracked;
}

function assertSessionReadActive(
  session: EncryptedBackupSessionCacheEntry,
): void {
  if (
    activeEncryptedSession === session &&
    !session.abortController.signal.aborted
  ) {
    return;
  }

  throw new BackupSessionError(
    "backup_password_required",
    "The encrypted backup session was locked during the source read.",
    true,
    { backupId: session.backupId },
  );
}

async function withSessionMutation<TValue>(
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const predecessor = sessionMutationTail;
  let release: (() => void) | undefined;
  sessionMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await predecessor;

  try {
    return await operation();
  } finally {
    release?.();
  }
}

function assertSessionRequestActive(
  requestEpoch: number,
  backupId: string,
): void {
  if (requestEpoch === sessionEpoch) {
    return;
  }

  throw new BackupSessionError(
    "backup_password_required",
    "The encrypted backup session was locked before unlock completed.",
    true,
    { backupId },
  );
}

async function readEncryptedManifestMaterial(
  root: ReadonlySourceDirectoryHandle,
): Promise<EncryptedManifestMaterial> {
  const file = await root.getFile("Manifest.plist");

  if (file.size <= 0 || file.size > maxCompanionRootPlistBytes) {
    throw new BackupSessionError(
      "backup_crypto_malformed",
      "Encrypted Manifest.plist has an invalid size.",
      false,
      { file: "Manifest.plist", bytes: file.size },
    );
  }

  try {
    const parsed = parsePlist(new Uint8Array(await file.arrayBuffer()));

    if (!isPlistDictionary(parsed.value)) {
      throw new BackupSessionError(
        "backup_crypto_malformed",
        "Encrypted Manifest.plist is not a dictionary.",
        false,
        { file: "Manifest.plist" },
      );
    }

    const keybagBytes = getPlistData(parsed.value, "BackupKeyBag");
    const manifestKey = getPlistData(parsed.value, "ManifestKey");

    if (keybagBytes === undefined || manifestKey === undefined) {
      throw new BackupSessionError(
        "backup_crypto_malformed",
        "Encrypted Manifest.plist is missing required key material.",
        false,
        { file: "Manifest.plist" },
      );
    }

    return {
      keybagBytes: keybagBytes.slice(),
      manifestKey: manifestKey.slice(),
    };
  } catch (cause) {
    if (cause instanceof BackupSessionError) {
      throw cause;
    }

    throw new BackupSessionError(
      "backup_crypto_malformed",
      "Encrypted Manifest.plist could not be parsed.",
      false,
      { file: "Manifest.plist" },
      cause,
    );
  }
}

/**
 * Builds the decrypt-chunk stream for one stored file, forwarding the core
 * reader's optional ciphertext tee into the crypto layer so an opt-in
 * stored-source hash folds into the single decrypt read pass instead of
 * costing a second full read of the stored file.
 */
function sessionDecryptChunks(
  keybag: UnlockedBackupKeybag,
  encryptionKey: Uint8Array,
  plaintextSize: number,
  options: EncryptedSessionReadOptions,
  signal?: AbortSignal,
): ReadEncryptedSourceFileBytesOptions["decryptChunks"] {
  return (source, onCiphertextChunk) =>
    keybag.decryptFileChunks(source, encryptionKey, plaintextSize, {
      ...(signal === undefined ? {} : { signal }),
      ...(options.decryptChunkBytes === undefined
        ? {}
        : { chunkBytes: options.decryptChunkBytes }),
      ...(options.decryptProgress === undefined
        ? {}
        : { progress: options.decryptProgress }),
      ...(onCiphertextChunk === undefined ? {} : { onCiphertextChunk }),
    });
}

async function readEncryptedSourceFile(
  root: ReadonlySourceDirectoryHandle,
  keybag: UnlockedBackupKeybag,
  record: ManifestFileRecord,
  options: EncryptedSessionReadOptions = {},
  signal?: AbortSignal,
): Promise<SourceFileBytes> {
  const { plaintextSize, encryptionKey } = encryptedFileMetadata(record);

  try {
    return await readEncryptedSourceFileBytes(root, record, {
      plaintextSize,
      ...(signal === undefined ? {} : { signal }),
      ...(options.maxReadBytes === undefined
        ? {}
        : { maxReadBytes: options.maxReadBytes }),
      ...(options.includeSourceSha256 === undefined
        ? {}
        : { includeSourceSha256: options.includeSourceSha256 }),
      decryptChunks: sessionDecryptChunks(
        keybag,
        encryptionKey,
        plaintextSize,
        options,
        signal,
      ),
    });
  } catch (cause) {
    // Preserve source access/size/manifest failures for the established
    // actionable attachment-read mappings. Only crypto failures are folded
    // into the M5 crypto error codes.
    throw mapEncryptedSourceReadCause(cause, record.fileId);
  }
}

async function readEncryptedSourceFileAsBlob(
  root: ReadonlySourceDirectoryHandle,
  keybag: UnlockedBackupKeybag,
  backupId: string,
  record: ManifestFileRecord,
  options: EncryptedSessionReadOptions = {},
  signal?: AbortSignal,
): Promise<SourceFileBlob> {
  const { plaintextSize, encryptionKey } = encryptedFileMetadata(record);

  try {
    return await readEncryptedSourceFileBlob(root, record, {
      backupId,
      plaintextSize,
      ...(signal === undefined ? {} : { signal }),
      ...(options.maxReadBytes === undefined
        ? {}
        : { maxReadBytes: options.maxReadBytes }),
      ...(options.includeSourceSha256 === undefined
        ? {}
        : { includeSourceSha256: options.includeSourceSha256 }),
      decryptChunks: sessionDecryptChunks(
        keybag,
        encryptionKey,
        plaintextSize,
        options,
        signal,
      ),
    });
  } catch (cause) {
    throw mapEncryptedSourceReadCause(cause, record.fileId);
  }
}

async function stageEncryptedSourceFile(
  root: ReadonlySourceDirectoryHandle,
  keybag: UnlockedBackupKeybag,
  record: ManifestFileRecord,
  destination: DecryptedPlaintextDestination,
  options: EncryptedSessionReadOptions = {},
  signal?: AbortSignal,
): Promise<SourceFileInfo> {
  const { plaintextSize, encryptionKey } = encryptedFileMetadata(record);

  try {
    signal?.throwIfAborted();
    const file = await getStoredSourceFile(root, record);
    const digests = await decryptSourceFileToDestination(record, file, destination, {
      plaintextSize,
      ...(signal === undefined ? {} : { signal }),
      ...(options.maxReadBytes === undefined
        ? {}
        : { maxReadBytes: options.maxReadBytes }),
      ...(options.includeSourceSha256 === undefined
        ? {}
        : { includeSourceSha256: options.includeSourceSha256 }),
      decryptChunks: sessionDecryptChunks(
        keybag,
        encryptionKey,
        plaintextSize,
        options,
        signal,
      ),
    });

    return {
      record,
      sha256: digests.sha256,
      ...(digests.sourceSha256 === undefined
        ? {}
        : { sourceSha256: digests.sourceSha256 }),
      byteLength: digests.byteLength,
      sourceByteLength: digests.sourceByteLength,
      isEncrypted: true,
    };
  } catch (cause) {
    throw mapEncryptedSourceReadCause(cause, record.fileId);
  }
}

async function writeEncryptedSourceFile(
  root: ReadonlySourceDirectoryHandle,
  keybag: UnlockedBackupKeybag,
  record: ManifestFileRecord,
  sink: SourceFileChunkSink,
  options: EncryptedSessionReadOptions = {},
  signal?: AbortSignal,
): Promise<SourceFileInfo> {
  const { plaintextSize, encryptionKey } = encryptedFileMetadata(record);

  try {
    return await writeEncryptedSourceFileToSink(root, record, sink, {
      plaintextSize,
      ...(signal === undefined ? {} : { signal }),
      ...(options.maxReadBytes === undefined
        ? {}
        : { maxReadBytes: options.maxReadBytes }),
      ...(options.includeSourceSha256 === undefined
        ? {}
        : { includeSourceSha256: options.includeSourceSha256 }),
      decryptChunks: sessionDecryptChunks(
        keybag,
        encryptionKey,
        plaintextSize,
        options,
        signal,
      ),
    });
  } catch (cause) {
    throw mapEncryptedSourceReadCause(cause, record.fileId);
  }
}

function encryptedFileMetadata(record: ManifestFileRecord): {
  plaintextSize: number;
  encryptionKey: Uint8Array;
} {
  const plaintextSize = record.metadata.size;
  const encryptionKey = record.metadata.encryptionKey;

  if (
    plaintextSize === undefined ||
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize < 0 ||
    encryptionKey === undefined
  ) {
    throw new BackupSessionError(
      "backup_crypto_malformed",
      "Encrypted file metadata is missing a valid size or encryption key.",
      false,
      {
        fileId: record.fileId,
        domain: record.domain,
        relativePath: record.relativePath,
      },
    );
  }

  return { plaintextSize, encryptionKey };
}

async function verifyEncryptedSourceFileKey(
  keybag: UnlockedBackupKeybag,
  record: ManifestFileRecord,
): Promise<void> {
  const { encryptionKey } = encryptedFileMetadata(record);

  try {
    await keybag.verifyFileKey(encryptionKey);
  } catch (cause) {
    throw mapEncryptedSourceReadCause(cause, record.fileId);
  }
}

function mapEncryptedSourceReadCause(cause: unknown, fileId: string): unknown {
  if (cause instanceof SourceFileDecryptionError) {
    return new BackupSessionError(
      "backup_crypto_malformed",
      "Decrypted file bytes did not match encrypted backup metadata.",
      false,
      { fileId },
      cause,
    );
  }
  if (cause instanceof BackupCryptoError || cause instanceof BackupSessionError) {
    return mapCryptoCause(cause, fileId);
  }
  return cause;
}

function assertBackupIdMatches(
  backupId: string,
  detection: BackupDetectionResult,
): void {
  if (backupIdMatchesDetection(backupId, detection)) {
    return;
  }

  throw new BackupSessionError(
    "backup_invalid",
    "The selected folder no longer matches this recent backup.",
    true,
    {
      expectedBackupId: backupId.trim(),
      actualBackupId: detection.id,
      actualUdid: detection.deviceInfo.udid,
    },
  );
}

async function emitKdfProgress(
  progress: WorkerProgressCallback | undefined,
  event: KdfProgressEvent,
): Promise<void> {
  const stage =
    event.stage === "double-protection"
      ? "Deriving modern backup password key"
      : "Deriving backup passcode key";

  await emitWorkerProgress(
    "backup",
    progress,
    "unlocking",
    `${stage}${event.state === "complete" ? " complete" : ""}`,
    event.completedStages,
    event.totalStages,
  );
}

function mapCryptoCause(cause: unknown, source: string): BackupSessionError {
  if (cause instanceof BackupSessionError) {
    return cause;
  }

  if (cause instanceof BackupCryptoError) {
    if (cause.code === "wrong-password") {
      return new BackupSessionError(
        "backup_password_incorrect",
        "The encrypted backup password is incorrect.",
        true,
        { source },
      );
    }

    return new BackupSessionError(
      cause.code === "unsupported-keybag"
        ? "backup_crypto_unsupported"
        : "backup_crypto_malformed",
      cause.code === "unsupported-keybag"
        ? "This encrypted backup uses unsupported keybag settings."
        : "Encrypted backup key material or ciphertext is malformed.",
      false,
      { source, cryptoCode: cause.code },
      cause,
    );
  }

  if (cause instanceof SourceFileTooLargeError) {
    return new BackupSessionError(
      "backup_crypto_unsupported",
      "Encrypted Manifest.db exceeds the staged-file sanity limit or available local storage quota.",
      false,
      { source },
      cause,
    );
  }

  return new BackupSessionError(
    "backup_crypto_malformed",
    "Encrypted backup data could not be decrypted.",
    false,
    { source },
    cause,
  );
}

export function toBackupSessionWorkerError(cause: unknown) {
  if (cause instanceof BackupSessionError) {
    return toWorkerError({
      worker: "backup",
      code: cause.code,
      message: cause.message,
      recoverable: cause.recoverable,
      cause: cause.originalCause,
      details: cause.details,
    });
  }

  if (cause instanceof BackupDetectionError) {
    return toWorkerError({
      worker: "backup",
      code: cause.code,
      message: cause.message,
      recoverable: true,
      cause: cause.originalCause,
      details: cause.details,
    });
  }

  return toWorkerError({
    worker: "backup",
    code: "backup_crypto_malformed",
    message: "Encrypted backup session failed unexpectedly.",
    recoverable: false,
    cause,
  });
}
