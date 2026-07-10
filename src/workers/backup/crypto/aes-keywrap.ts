import { BackupCryptoError } from "./errors";
import type { KeybagClassKey } from "./keybag";

const aes256KeyBytes = 32;
const wrappedAes256KeyBytes = 40;
const wrappedKeyBlobBytes = 4 + wrappedAes256KeyBytes;
const passcodeWrapFlag = 2;
const deviceWrapFlag = 1;

export interface ParsedClassWrappedKey {
  readonly protectionClass: number;
  readonly wrappedKey: Uint8Array;
}

export interface UnwrappedClassKeys {
  readonly classKeys: Map<number, Uint8Array>;
  /**
   * Protection classes whose AES-KW integrity check failed while sibling keys
   * unwrapped with the same passcode key. Hostile or damaged keybag entries
   * are skipped and reported (hard rule 4) instead of discarding the classes
   * the backup actually needs; files in a failed class stay unreadable and
   * surface as unsupported when their key is requested.
   */
  readonly failedProtectionClasses: readonly number[];
}

export async function unwrapClassKeys(
  classKeyRecords: readonly KeybagClassKey[],
  passcodeKey: Uint8Array,
): Promise<UnwrappedClassKeys> {
  assertAes256Key(passcodeKey, "Passcode key");

  const candidates = classKeyRecords.filter(
    (
      record,
    ): record is KeybagClassKey & { readonly wrappedKey: Uint8Array } =>
      record.keyType === 0 &&
      (record.wrapFlags & passcodeWrapFlag) !== 0 &&
      record.wrappedKey !== undefined,
  );
  if (candidates.length === 0) {
    const hasDeviceWrappedKeys = classKeyRecords.some(
      (record) => (record.wrapFlags & deviceWrapFlag) !== 0,
    );
    throw new BackupCryptoError(
      "unsupported-keybag",
      hasDeviceWrappedKeys
        ? "Keybag class keys require a device key that is not available in a computer backup."
        : "Keybag has no supported passcode-wrapped AES class keys.",
    );
  }

  const unwrapped = new Map<number, Uint8Array>();
  const failedProtectionClasses: number[] = [];

  for (const record of candidates) {
    try {
      const key = await unwrapAes256Key(
        passcodeKey,
        record.wrappedKey,
      );
      unwrapped.set(record.protectionClass, key);
    } catch (cause) {
      if (
        cause instanceof BackupCryptoError &&
        cause.code === "key-unwrap-failed"
      ) {
        failedProtectionClasses.push(record.protectionClass);
        continue;
      }
      zeroizeClassKeys(unwrapped);
      throw cause;
    }
  }

  // Every candidate failing AES-KW is the wrong-password signal. A partial
  // failure with the same passcode key can only be a corrupt keybag entry.
  if (unwrapped.size === 0) {
    throw new BackupCryptoError(
      "wrong-password",
      "The backup password is incorrect.",
    );
  }

  return { classKeys: unwrapped, failedProtectionClasses };
}

export function parseClassWrappedKeyBlob(
  blob: Uint8Array,
): ParsedClassWrappedKey {
  if (blob.byteLength !== wrappedKeyBlobBytes) {
    throw new BackupCryptoError(
      "malformed-key-material",
      "Wrapped file key must contain a 4-byte class and a 40-byte AES-KW value.",
    );
  }
  const protectionClass = new DataView(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength,
  ).getUint32(0, true);
  if (protectionClass === 0) {
    throw new BackupCryptoError(
      "malformed-key-material",
      "Wrapped file key has an invalid protection class.",
    );
  }
  return {
    protectionClass,
    wrappedKey: blob.slice(4),
  };
}

export async function unwrapClassWrappedKey(
  classKeys: ReadonlyMap<number, Uint8Array>,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const parsed = parseClassWrappedKeyBlob(blob);
  const classKey = classKeys.get(parsed.protectionClass);
  if (classKey === undefined) {
    throw new BackupCryptoError(
      "unsupported-keybag",
      `No unlocked key is available for protection class ${String(parsed.protectionClass)}.`,
    );
  }
  try {
    return await unwrapAes256Key(classKey, parsed.wrappedKey);
  } catch (cause) {
    if (
      cause instanceof BackupCryptoError &&
      cause.code === "key-unwrap-failed"
    ) {
      throw new BackupCryptoError(
        "key-unwrap-failed",
        "The wrapped file key failed its AES-KW integrity check.",
        { cause },
      );
    }
    throw cause;
  } finally {
    parsed.wrappedKey.fill(0);
  }
}

export async function unwrapAes256Key(
  wrappingKeyBytes: Uint8Array,
  wrappedKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  assertAes256Key(wrappingKeyBytes, "AES-KW wrapping key");
  if (wrappedKeyBytes.byteLength !== wrappedAes256KeyBytes) {
    throw new BackupCryptoError(
      "malformed-key-material",
      "Wrapped AES-256 key must be 40 bytes.",
    );
  }

  const wrappingKeyCopy = wrappingKeyBytes.slice();
  const wrappedKeyCopy = wrappedKeyBytes.slice();
  try {
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      wrappingKeyCopy,
      "AES-KW",
      false,
      ["unwrapKey"],
    );
    const unwrappedKey = await crypto.subtle.unwrapKey(
      "raw",
      wrappedKeyCopy,
      wrappingKey,
      "AES-KW",
      { name: "AES-KW", length: 256 },
      true,
      ["wrapKey", "unwrapKey"],
    );
    const raw = await crypto.subtle.exportKey("raw", unwrappedKey);
    const result = new Uint8Array(raw);
    if (result.byteLength !== aes256KeyBytes) {
      result.fill(0);
      throw new BackupCryptoError(
        "malformed-key-material",
        "Unwrapped AES key has an unexpected size.",
      );
    }
    return result;
  } catch (cause) {
    if (cause instanceof BackupCryptoError) {
      throw cause;
    }
    throw new BackupCryptoError(
      "key-unwrap-failed",
      "Wrapped AES key failed its integrity check.",
      { cause },
    );
  } finally {
    wrappingKeyCopy.fill(0);
    wrappedKeyCopy.fill(0);
  }
}

export function zeroizeClassKeys(classKeys: Map<number, Uint8Array>): void {
  for (const key of classKeys.values()) {
    key.fill(0);
  }
  classKeys.clear();
}

function assertAes256Key(key: Uint8Array, label: string): void {
  if (key.byteLength !== aes256KeyBytes) {
    throw new BackupCryptoError(
      "malformed-key-material",
      `${label} must be 32 bytes.`,
    );
  }
}
