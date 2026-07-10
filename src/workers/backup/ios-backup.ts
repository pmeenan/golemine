import {
  type BackupDetectionResult,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  createWorkerProgressEvent,
  toWorkerError,
  workerFail,
  workerOk,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import {
  asReadonlySourceDirectory,
  type ReadonlySourceDirectoryHandle,
} from "./read-only-source";
import {
  getPlistBoolean,
  getPlistData,
  getPlistDateIso,
  getPlistScalarString,
  getPlistString,
  isPlistDictionary,
  parsePlist,
  PlistParseError,
  type PlistDictionary,
} from "./plist";

const sqliteHeader = "SQLite format 3\u0000";

const requiredBackupFiles = [
  "Info.plist",
  "Manifest.plist",
  "Manifest.db",
  "Status.plist",
] as const;

type RequiredBackupFileName = (typeof requiredBackupFiles)[number];
type RootPlistFileName = Exclude<RequiredBackupFileName, "Manifest.db">;

// D-019 role-specific root plist bound, shared with the encrypted-session
// Manifest.plist key-material read so the limit has one source of truth.
export const maxCompanionRootPlistBytes = 8 * 1024 * 1024;
const maxInfoPlistBytes = 32 * 1024 * 1024;
const rootPlistByteLimits = {
  "Info.plist": maxInfoPlistBytes,
  "Manifest.plist": maxCompanionRootPlistBytes,
  "Status.plist": maxCompanionRootPlistBytes,
} satisfies Record<RootPlistFileName, number>;

interface RequiredBackupFiles {
  "Info.plist": File;
  "Manifest.plist": File;
  "Manifest.db": File;
  "Status.plist": File;
}

export class BackupDetectionError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly details?: Record<string, WorkerStructuredValue>,
    readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "BackupDetectionError";
  }
}

export async function detectBackupDirectory(
  rootHandle: FileSystemDirectoryHandle,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<BackupDetectionResult>> {
  await progress?.(
    createWorkerProgressEvent({
      worker: "backup",
      phase: "starting",
      label: "Starting backup detection",
      completedUnits: 0,
      totalUnits: 2,
    }),
  );

  try {
    const root = asReadonlySourceDirectory(rootHandle);

    await progress?.(
      createWorkerProgressEvent({
        worker: "backup",
        phase: "scanning",
        label: "Reading backup manifest files",
        completedUnits: 1,
        totalUnits: 2,
      }),
    );

    const result = await detectIosBackup(root);

    await progress?.(
      createWorkerProgressEvent({
        worker: "backup",
        phase: "complete",
        label: "Backup detection complete",
        completedUnits: 2,
        totalUnits: 2,
      }),
    );

    return workerOk(result);
  } catch (cause) {
    return workerFail<BackupDetectionResult>(toBackupWorkerError(cause));
  }
}

/**
 * Single identity contract between a caller-supplied backup id and a
 * detection result: an absent/blank id matches anything, otherwise the id
 * must equal the detection id or the device UDID (both trimmed). Every
 * backup-id assertion (session unlock, source reads, ingest) goes through
 * this predicate so the matching rules cannot drift between entry points.
 */
export function backupIdMatchesDetection(
  backupId: string | undefined,
  detection: BackupDetectionResult,
): boolean {
  const normalized = backupId?.trim();

  return (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized === detection.id.trim() ||
    normalized === detection.deviceInfo.udid.trim()
  );
}

export async function detectIosBackup(
  root: ReadonlySourceDirectoryHandle,
): Promise<BackupDetectionResult> {
  const files = await readRequiredBackupFiles(root);
  const info = await parseDictionaryFile(files["Info.plist"], "Info.plist");
  const manifest = await parseDictionaryFile(
    files["Manifest.plist"],
    "Manifest.plist",
  );

  await parseDictionaryFile(files["Status.plist"], "Status.plist");

  const isEncrypted = getPlistBoolean(manifest, "IsEncrypted");
  if (isEncrypted === undefined) {
    throw new BackupDetectionError(
      "backup_invalid",
      "Manifest.plist is missing the IsEncrypted flag.",
      { file: "Manifest.plist", key: "IsEncrypted" },
    );
  }

  await validateManifestDatabase(files["Manifest.db"], manifest, isEncrypted);

  const udid = readBackupUdid(info, root.name);
  const displayName = cleanString(getPlistString(info, "Display Name"));
  const deviceName = cleanString(getPlistString(info, "Device Name"));
  const friendlyName = displayName ?? deviceName ?? udid;

  // Translate Apple plist keys into the normalized device identity here, in
  // the provider, so no Apple-isms cross the worker boundary (hard rule 8).
  return {
    provider: "ios-itunes",
    sourceKind: "itunes-finder",
    id: udid,
    friendlyName,
    sourceFolderName: root.name,
    isEncrypted,
    deviceInfo: {
      udid,
      ...(deviceName === undefined ? {} : { name: deviceName }),
      ...optionalStringField("model", getPlistString(info, "Product Type")),
      ...optionalStringField("osVersion", getPlistString(info, "Product Version")),
      ...optionalStringField("serialNumber", getPlistString(info, "Serial Number")),
      ...optionalStringField("phoneNumber", getPlistString(info, "Phone Number")),
    },
    ...optionalStringField("lastBackupDate", getPlistDateIso(info, "Last Backup Date")),
    ...optionalStringField("backupFormatVersion", getPlistScalarString(manifest, "Version")),
    ...optionalStringField("backupDate", getPlistDateIso(manifest, "Date")),
  };
}

async function readRequiredBackupFiles(
  root: ReadonlySourceDirectoryHandle,
): Promise<RequiredBackupFiles> {
  const entries = await Promise.all(
    requiredBackupFiles.map(async (name) => ({
      name,
      file: await readOptionalRootFile(root, name),
    })),
  );
  const missing = entries
    .filter((entry) => entry.file === undefined)
    .map((entry) => entry.name);

  if (missing.length > 0) {
    throw new BackupDetectionError(
      "backup_not_found",
      `This folder does not look like an iTunes/Finder backup. Missing ${formatList(
        missing,
      )}.`,
      { missingFiles: missing.join(", ") },
    );
  }

  const files: Partial<Record<RequiredBackupFileName, File>> = {};
  for (const entry of entries) {
    if (entry.file !== undefined) {
      files[entry.name] = entry.file;
    }
  }

  return files as RequiredBackupFiles;
}

async function readOptionalRootFile(
  root: ReadonlySourceDirectoryHandle,
  name: RequiredBackupFileName,
): Promise<File | undefined> {
  try {
    return await root.getFile(name);
  } catch (cause) {
    if (isMissingHandleError(cause)) {
      return undefined;
    }

    throw new BackupDetectionError(
      "backup_access_failed",
      `Could not read ${name} from the selected folder.`,
      { file: name },
      cause,
    );
  }
}

async function parseDictionaryFile(
  file: File,
  label: RootPlistFileName,
): Promise<PlistDictionary> {
  try {
    if (file.size > rootPlistByteLimits[label]) {
      throw new BackupDetectionError(
        "backup_invalid",
        `${label} is too large to be a normal backup metadata plist.`,
        { file: label, bytes: file.size },
      );
    }

    const parsed = parsePlist(new Uint8Array(await file.arrayBuffer()));

    if (!isPlistDictionary(parsed.value)) {
      throw new BackupDetectionError(
        "backup_invalid",
        `${label} is not a plist dictionary.`,
        { file: label, format: parsed.format },
      );
    }

    return parsed.value;
  } catch (cause) {
    if (cause instanceof BackupDetectionError) {
      throw cause;
    }

    if (cause instanceof PlistParseError) {
      throw new BackupDetectionError(
        "backup_parse_failed",
        `${label} could not be parsed as a plist.`,
        { file: label },
        cause,
      );
    }

    throw new BackupDetectionError(
      "backup_access_failed",
      `Could not read ${label}.`,
      { file: label },
      cause,
    );
  }
}

async function validateManifestDatabase(
  manifestDatabase: File,
  manifest: PlistDictionary,
  isEncrypted: boolean,
): Promise<void> {
  if (manifestDatabase.size <= 0) {
    throw new BackupDetectionError(
      "backup_invalid",
      "Manifest.db is empty, so this folder is not a usable iTunes/Finder backup.",
      { file: "Manifest.db" },
    );
  }

  if (isEncrypted) {
    requireManifestData(manifest, "BackupKeyBag");
    requireManifestData(manifest, "ManifestKey");
    return;
  }

  const header = await manifestDatabase.slice(0, sqliteHeader.length).text();

  if (header !== sqliteHeader) {
    throw new BackupDetectionError(
      "backup_invalid",
      "Manifest.db is not a SQLite database.",
      { file: "Manifest.db" },
    );
  }
}

function requireManifestData(manifest: PlistDictionary, key: string): void {
  const value = getPlistData(manifest, key);

  if (value !== undefined && value.byteLength > 0) {
    return;
  }

  throw new BackupDetectionError(
    "backup_invalid",
    `Encrypted Manifest.plist is missing ${key}.`,
    { file: "Manifest.plist", key },
  );
}

function readBackupUdid(info: PlistDictionary, folderName: string): string {
  const fromInfo =
    cleanString(getPlistString(info, "Unique Identifier")) ??
    cleanString(getPlistString(info, "Target Identifier"));

  return fromInfo ?? folderName;
}

function optionalStringField<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Partial<Record<TKey, string>> {
  const cleaned = cleanString(value);
  return cleaned === undefined ? {} : { [key]: cleaned } as Record<TKey, string>;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function isMissingHandleError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "NotFoundError" || cause.name === "TypeMismatchError")
  );
}

function formatList(values: readonly string[]): string {
  if (values.length === 1) {
    return values[0];
  }

  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function toBackupWorkerError(cause: unknown) {
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
    code: "worker_failed",
    message: "Backup detection failed unexpectedly.",
    recoverable: true,
    cause,
  });
}
