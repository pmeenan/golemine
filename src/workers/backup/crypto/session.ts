import {
  decryptAes256CbcBlobChunks,
  type CbcChunkDecryptOptions,
  type CbcEncryptedBlob,
} from "./aes-cbc";
import {
  unwrapClassKeys,
  unwrapClassWrappedKey,
  zeroizeClassKeys,
} from "./aes-keywrap";
import { BackupCryptoError } from "./errors";
import { derivePasscodeKey, type KdfProgressCallback } from "./kdf";
import { parseKeybag } from "./keybag";

export interface UnlockedKeybagWarning {
  readonly code: "class-key-unwrap-failed";
  readonly protectionClass: number;
}

export class UnlockedBackupKeybag {
  private destroyed = false;

  constructor(
    private readonly classKeys: Map<number, Uint8Array>,
    /**
     * Skip-and-report record of class keys that failed their AES-KW integrity
     * check while sibling keys unwrapped (corrupt keybag entries). Files in
     * those protection classes stay unreadable and surface as unsupported.
     */
    readonly warnings: readonly UnlockedKeybagWarning[] = [],
  ) {}

  async decryptManifestDatabase(
    encrypted: Uint8Array,
    manifestKeyBlob: Uint8Array,
  ): Promise<Uint8Array> {
    this.assertUsable();
    const key = await unwrapClassWrappedKey(this.classKeys, manifestKeyBlob);
    // Manifest.db is raw, page-aligned CBC in iOS backups. It has no
    // MBFile.Size field. Some producers append PKCS#7 while others emit the
    // exact page-aligned raw ciphertext, so decrypt every raw block and
    // normalize only against SQLite's own page-size invariant afterwards.
    // Chunked decryption bounds the transient WebCrypto input instead of
    // duplicating a potentially hundreds-of-MiB ciphertext buffer.
    const plaintext = new Uint8Array(encrypted.byteLength);
    let offset = 0;

    try {
      const source: CbcEncryptedBlob = {
        size: encrypted.byteLength,
        slice: (start?: number, end?: number) =>
          // The view is only ever chunk-sized; Blob copies it internally. The
          // narrowing cast is safe because this project never allocates
          // SharedArrayBuffer-backed views (D-008).
          new Blob([
            encrypted.subarray(
              start ?? 0,
              end ?? encrypted.byteLength,
            ) as Uint8Array<ArrayBuffer>,
          ]),
      };

      for await (const chunk of decryptAes256CbcBlobChunks(
        source,
        key,
        encrypted.byteLength,
      )) {
        plaintext.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return normalizeManifestDatabaseLength(plaintext);
    } catch (cause) {
      plaintext.fill(0);
      throw cause;
    } finally {
      key.fill(0);
    }
  }

  async *decryptFileChunks(
    source: CbcEncryptedBlob,
    encryptionKeyBlob: Uint8Array,
    plaintextSize: number,
    options?: CbcChunkDecryptOptions,
  ): AsyncGenerator<Uint8Array, void, void> {
    this.assertUsable();
    options?.signal?.throwIfAborted();
    const key = await unwrapClassWrappedKey(this.classKeys, encryptionKeyBlob);
    try {
      options?.signal?.throwIfAborted();
      yield* decryptAes256CbcBlobChunks(
        source,
        key,
        plaintextSize,
        options,
      );
      options?.signal?.throwIfAborted();
    } finally {
      key.fill(0);
    }
  }

  destroy(): void {
    if (!this.destroyed) {
      zeroizeClassKeys(this.classKeys);
      this.destroyed = true;
    }
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new BackupCryptoError(
        "malformed-key-material",
        "The unlocked keybag session has been destroyed.",
      );
    }
  }
}

const sqliteHeader = new TextEncoder().encode("SQLite format 3\u0000");

function normalizeManifestDatabaseLength(decrypted: Uint8Array): Uint8Array {
  if (
    decrypted.byteLength < 100 ||
    !sqliteHeader.every((byte, index) => decrypted[index] === byte)
  ) {
    decrypted.fill(0);
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "Decrypted Manifest database does not have a valid SQLite header.",
    );
  }

  const encodedPageSize = new DataView(
    decrypted.buffer,
    decrypted.byteOffset,
    decrypted.byteLength,
  ).getUint16(16, false);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (
    pageSize < 512 ||
    pageSize > 65_536 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    decrypted.fill(0);
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "Decrypted Manifest database has an invalid SQLite page size.",
    );
  }

  const trailingBytes = decrypted.byteLength % pageSize;
  if (trailingBytes === 0) {
    return decrypted;
  }
  if (
    trailingBytes > 16 ||
    !decrypted
      .subarray(decrypted.byteLength - trailingBytes)
      .every((byte) => byte === trailingBytes)
  ) {
    decrypted.fill(0);
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "Decrypted Manifest database has invalid trailing bytes.",
    );
  }

  // Borrowed view instead of a full copy: dropping 1-16 PKCS#7 pad-count
  // bytes must not duplicate a potentially hundreds-of-MiB plaintext. Callers
  // zeroize the returned view; the excluded pad bytes carry no plaintext.
  return decrypted.subarray(0, decrypted.byteLength - trailingBytes);
}

/**
 * Unlocks a keybag without retaining the password or derived passcode key.
 * The returned object owns only class keys and provides an explicit destroy.
 */
export async function unlockBackupKeybag(
  keybagBytes: Uint8Array,
  password: string,
  progress?: KdfProgressCallback,
): Promise<UnlockedBackupKeybag> {
  const keybag = parseKeybag(keybagBytes);
  const derivePromise = derivePasscodeKey(password, keybag, progress);
  password = "";
  const passcodeKey = await derivePromise;
  try {
    const { classKeys, failedProtectionClasses } = await unwrapClassKeys(
      keybag.classKeys,
      passcodeKey,
    );

    return new UnlockedBackupKeybag(
      classKeys,
      failedProtectionClasses.map((protectionClass) => ({
        code: "class-key-unwrap-failed",
        protectionClass,
      })),
    );
  } finally {
    passcodeKey.fill(0);
  }
}
