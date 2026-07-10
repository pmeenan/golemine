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
  type ManifestFileRecord,
  type ReadSourceFileBytesOptions,
  type SourceFileBytes,
  readEncryptedSourceFileBytes,
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

export interface EncryptedBackupSessionContext {
  readonly backupId: string;
  readonly root: ReadonlySourceDirectoryHandle;
  readonly detection: BackupDetectionResult;
  readonly manifest: ManifestDbReader;
  assertActive(): void;
  readSourceFile(
    record: ManifestFileRecord,
    options?: EncryptedSessionReadOptions,
  ): Promise<SourceFileBytes>;
}

interface EncryptedBackupSessionCacheEntry
  extends EncryptedBackupSessionContext {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly keybag: UnlockedBackupKeybag;
  readonly abortController: AbortController;
  readonly activeReads: Set<Promise<SourceFileBytes>>;
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

  await clearActiveEncryptedSession();

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
      decryptMain: (encryptedBytes) =>
        unlockedKeybag.decryptManifestDatabase(encryptedBytes, material.manifestKey),
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
      activeReads: new Set<Promise<SourceFileBytes>>(),
      assertActive(): void {
        assertSessionReadActive(this);
      },
      readSourceFile(record, options): Promise<SourceFileBytes> {
        return runTrackedSessionRead(this, record, options);
      },
    };

    activeEncryptedSession = session;

    return session;
  } catch (cause) {
    try {
      manifest?.close();
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

  session.manifest.close();
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
    await clearActiveEncryptedSession();
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
    await clearActiveEncryptedSession();
    return undefined;
  }

  return session;
}

function runTrackedSessionRead(
  session: EncryptedBackupSessionCacheEntry,
  record: ManifestFileRecord,
  options: EncryptedSessionReadOptions | undefined,
): Promise<SourceFileBytes> {
  const operation = (async () => {
    assertSessionReadActive(session);
    let source: SourceFileBytes;

    try {
      source = await readEncryptedSourceFile(
        session.root,
        session.keybag,
        record,
        options,
        session.abortController.signal,
      );
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
      return source;
    } catch (cause) {
      source.bytes.fill(0);
      throw cause;
    }
  })();
  const tracked = operation.finally(() => {
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

async function readEncryptedSourceFile(
  root: ReadonlySourceDirectoryHandle,
  keybag: UnlockedBackupKeybag,
  record: ManifestFileRecord,
  options: EncryptedSessionReadOptions = {},
  signal?: AbortSignal,
): Promise<SourceFileBytes> {
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
      decryptChunks: (source) =>
        keybag.decryptFileChunks(source, encryptionKey, plaintextSize, {
          ...(signal === undefined ? {} : { signal }),
          ...(options.decryptChunkBytes === undefined
            ? {}
            : { chunkBytes: options.decryptChunkBytes }),
          ...(options.decryptProgress === undefined
            ? {}
            : { progress: options.decryptProgress }),
        }),
    });
  } catch (cause) {
    // Preserve source access/size/manifest failures for the established
    // actionable attachment-read mappings. Only crypto failures are folded
    // into the M5 crypto error codes.
    if (cause instanceof SourceFileDecryptionError) {
      throw new BackupSessionError(
        "backup_crypto_malformed",
        "Decrypted file bytes did not match encrypted backup metadata.",
        false,
        { fileId: record.fileId },
        cause,
      );
    }

    if (cause instanceof BackupCryptoError || cause instanceof BackupSessionError) {
      throw mapCryptoCause(cause, record.fileId);
    }

    throw cause;
  }
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
      "Encrypted Manifest.db exceeds the safe in-memory decrypt limit.",
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
