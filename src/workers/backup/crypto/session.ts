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

  async *decryptManifestDatabaseChunks(
    encrypted: CbcEncryptedBlob,
    manifestKeyBlob: Uint8Array,
    options?: CbcChunkDecryptOptions,
  ): AsyncGenerator<Uint8Array, void, void> {
    this.assertUsable();
    const key = await unwrapClassWrappedKey(this.classKeys, manifestKeyBlob);
    // Manifest.db is raw, page-aligned CBC in iOS backups. It has no
    // MBFile.Size field. Some producers append PKCS#7 while others emit the
    // exact page-aligned raw ciphertext, so decrypt every raw block and
    // normalize only against SQLite's own page-size invariant afterwards.
    try {
      yield* decryptAes256CbcBlobChunks(
        encrypted,
        key,
        encrypted.size,
        options,
      );
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

  /**
   * Verifies a Manifest MBFile wrapped key without retaining the resulting
   * per-file key. Required source databases call this before the destructive
   * ingest boundary so corrupt main/WAL/SHM keys cannot fail after prepare.
   */
  async verifyFileKey(encryptionKeyBlob: Uint8Array): Promise<void> {
    this.assertUsable();
    const key = await unwrapClassWrappedKey(this.classKeys, encryptionKeyBlob);

    key.fill(0);
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
