import { BackupCryptoError } from "./errors";
import type { ParsedKeybag } from "./keybag";

const derivedKeyBytes = 32;
const maxPbkdf2Iterations = 50_000_000;

export type KdfProgressStage = "double-protection" | "passcode";

export interface KdfProgressEvent {
  readonly stage: KdfProgressStage;
  readonly state: "starting" | "complete";
  readonly completedStages: number;
  readonly totalStages: 1 | 2;
  readonly iterationCount: number;
}

export type KdfProgressCallback = (
  event: KdfProgressEvent,
) => void | Promise<void>;

/**
 * Implements both the iOS 10.2+ two-stage backup KDF and the legacy single
 * PBKDF2-SHA1 KDF. Native WebCrypto does not expose per-iteration progress,
 * so callbacks report truthful stage boundaries around each native operation.
 */
export async function derivePasscodeKey(
  password: string,
  keybag: Pick<
    ParsedKeybag,
    | "salt"
    | "iterations"
    | "doubleProtectionSalt"
    | "doubleProtectionIterations"
  >,
  progress?: KdfProgressCallback,
): Promise<Uint8Array> {
  assertIterationCount(keybag.iterations, "passcode");
  const hasDoubleProtection =
    keybag.doubleProtectionSalt !== undefined &&
    keybag.doubleProtectionIterations !== undefined;
  if (
    (keybag.doubleProtectionSalt === undefined) !==
    (keybag.doubleProtectionIterations === undefined)
  ) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "Keybag double-protection parameters are incomplete.",
    );
  }
  if (hasDoubleProtection) {
    assertIterationCount(
      keybag.doubleProtectionIterations,
      "double-protection",
    );
  }

  const passwordBytes = new TextEncoder().encode(password);
  // JS strings are immutable and cannot be zeroized. Drop this binding as
  // soon as the mutable UTF-8 encoding exists; the byte copy is cleared below.
  password = "";
  let intermediate: Uint8Array | undefined;
  const totalStages: 1 | 2 = hasDoubleProtection ? 2 : 1;

  try {
    if (hasDoubleProtection) {
      const iterationCount = keybag.doubleProtectionIterations;
      await emitKdfProgress(progress, {
        stage: "double-protection",
        state: "starting",
        completedStages: 0,
        totalStages,
        iterationCount,
      });
      intermediate = await pbkdf2(
        passwordBytes,
        keybag.doubleProtectionSalt,
        iterationCount,
        "SHA-256",
      );
      await emitKdfProgress(progress, {
        stage: "double-protection",
        state: "complete",
        completedStages: 1,
        totalStages,
        iterationCount,
      });
    }

    const completedBeforePasscode = hasDoubleProtection ? 1 : 0;
    await emitKdfProgress(progress, {
      stage: "passcode",
      state: "starting",
      completedStages: completedBeforePasscode,
      totalStages,
      iterationCount: keybag.iterations,
    });
    const passcodeKey = await pbkdf2(
      intermediate ?? passwordBytes,
      keybag.salt,
      keybag.iterations,
      "SHA-1",
    );
    await emitKdfProgress(progress, {
      stage: "passcode",
      state: "complete",
      completedStages: totalStages,
      totalStages,
      iterationCount: keybag.iterations,
    });
    return passcodeKey;
  } finally {
    passwordBytes.fill(0);
    intermediate?.fill(0);
  }
}

async function pbkdf2(
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  hash: "SHA-1" | "SHA-256",
): Promise<Uint8Array> {
  if (salt.byteLength === 0) {
    throw new BackupCryptoError(
      "malformed-keybag",
      "PBKDF2 salt must not be empty.",
    );
  }

  const materialCopy = material.slice();
  const saltCopy = salt.slice();
  try {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      materialCopy,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash, salt: saltCopy, iterations },
      baseKey,
      derivedKeyBytes * 8,
    );
    return new Uint8Array(bits);
  } catch (cause) {
    throw new BackupCryptoError(
      "unsupported-keybag",
      "WebCrypto could not derive the backup passcode key.",
      { cause },
    );
  } finally {
    materialCopy.fill(0);
    saltCopy.fill(0);
  }
}

function assertIterationCount(iterations: number, label: string): void {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new BackupCryptoError(
      "malformed-keybag",
      `The ${label} PBKDF2 iteration count is invalid.`,
    );
  }
  if (iterations > maxPbkdf2Iterations) {
    throw new BackupCryptoError(
      "unsupported-keybag",
      `The ${label} PBKDF2 iteration count exceeds the supported bound.`,
    );
  }
}

async function emitKdfProgress(
  progress: KdfProgressCallback | undefined,
  event: KdfProgressEvent,
): Promise<void> {
  await progress?.(event);
}
