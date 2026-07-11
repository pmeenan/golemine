import { BackupCryptoError } from "./errors";

const aesBlockBytes = 16;
const aes256KeyBytes = 32;
const defaultChunkBytes = 4 * 1024 * 1024;
const zeroIv: Uint8Array<ArrayBuffer> = new Uint8Array(aesBlockBytes);

export interface CbcChunkProgressEvent {
  readonly processedEncryptedBytes: number;
  readonly totalEncryptedBytes: number;
  readonly emittedPlaintextBytes: number;
  readonly totalPlaintextBytes: number;
}

export type CbcChunkProgressCallback = (
  event: CbcChunkProgressEvent,
) => void | Promise<void>;

export interface CbcChunkDecryptOptions {
  readonly chunkBytes?: number;
  readonly progress?: CbcChunkProgressCallback;
  readonly signal?: AbortSignal;
  /**
   * Receives each sliced ciphertext chunk, in order from byte 0, before it is
   * decrypted, so stored-source hashing can fold into the decrypt read pass.
   * The chunk is a borrowed buffer that is zeroized once the generator moves
   * on; copy it if the bytes must outlive the callback. Only the block-aligned
   * prefix the decrypt pass actually reads is teed (see the read bound below);
   * callers hashing the complete stored file own the unread tail.
   */
  readonly onCiphertextChunk?: (chunk: Uint8Array) => void;
}

/** The subset of Blob/File used by the bounded random-access decrypt path. */
export interface CbcEncryptedBlob {
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

/**
 * Decrypts a file-sized Blob in bounded, independently processed CBC chunks.
 * It never materializes the whole encrypted source, and reads only the
 * block-aligned ciphertext prefix needed for the materialized plaintext. Each
 * yielded array is a borrowed chunk valid until the generator resumes;
 * consumers must copy it if they retain it. Temporary ciphertext and
 * plaintext buffers are cleared.
 */
export async function* decryptAes256CbcBlobChunks(
  source: CbcEncryptedBlob,
  keyBytes: Uint8Array,
  plaintextSize: number,
  options: CbcChunkDecryptOptions = {},
): AsyncGenerator<Uint8Array, void, void> {
  assertCiphertextShape(source.size, plaintextSize);
  options.signal?.throwIfAborted();
  if (source.size === 0) {
    return;
  }

  const chunkBytes = options.chunkBytes ?? defaultChunkBytes;
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < aesBlockBytes ||
    chunkBytes % aesBlockBytes !== 0
  ) {
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "CBC chunk size must be a positive multiple of 16 bytes.",
    );
  }

  const key = await importAesCbcKey(keyBytes);
  let iv = zeroIv.slice();
  let emittedPlaintextBytes = 0;
  const materializedPlaintextBytes = Math.min(plaintextSize, source.size);
  // Decrypt work is bounded by the materialized plaintext: only the
  // block-aligned ciphertext prefix that can contribute emitted bytes is read
  // and decrypted. A hostile stored tail beyond MBFile.Size therefore costs
  // no AES work; callers that need a hash of the complete stored file fold
  // the unread tail in separately.
  const ciphertextReadBytes = Math.min(
    source.size,
    Math.ceil(materializedPlaintextBytes / aesBlockBytes) * aesBlockBytes,
  );
  // One reusable ciphertext scratch (chunk plus the synthetic padding block)
  // for the whole file, instead of a fresh allocation and copy per chunk. It
  // only ever holds ciphertext-derived bytes and is zeroized when done.
  let scratch: Uint8Array<ArrayBuffer> | undefined;

  try {
    for (let offset = 0; offset < ciphertextReadBytes; offset += chunkBytes) {
      options.signal?.throwIfAborted();
      const end = Math.min(ciphertextReadBytes, offset + chunkBytes);
      const encrypted = new Uint8Array(
        await source.slice(offset, end).arrayBuffer(),
      );
      if (encrypted.byteLength !== end - offset) {
        encrypted.fill(0);
        throw new BackupCryptoError(
          "malformed-ciphertext",
          "Encrypted source returned a short read.",
        );
      }
      try {
        options.signal?.throwIfAborted();
        // Borrowed view: the buffer is zeroized in this chunk's finally below.
        options.onCiphertextChunk?.(encrypted);
      } catch (cause) {
        encrypted.fill(0);
        throw cause;
      }

      const nextIv = encrypted.slice(-aesBlockBytes);
      let decrypted: Uint8Array | undefined;
      try {
        scratch ??= new Uint8Array(chunkBytes + aesBlockBytes);
        decrypted = await decryptRawCbcChunk(encrypted, key, iv, {
          finalCiphertextBlock: nextIv,
          scratch,
        });
        options.signal?.throwIfAborted();
      } catch (cause) {
        decrypted?.fill(0);
        throw cause;
      } finally {
        encrypted.fill(0);
        iv.fill(0);
        iv = nextIv;
      }

      const remaining = materializedPlaintextBytes - emittedPlaintextBytes;
      const emitBytes = Math.min(decrypted.byteLength, Math.max(0, remaining));
      // Borrowed view: consumers copy before the generator resumes, so the
      // truncated tail never needs its own allocation.
      const output = decrypted.subarray(0, emitBytes);
      emittedPlaintextBytes += output.byteLength;

      try {
        await options.progress?.({
          processedEncryptedBytes: end,
          totalEncryptedBytes: source.size,
          emittedPlaintextBytes,
          totalPlaintextBytes: plaintextSize,
        });
        options.signal?.throwIfAborted();
        if (output.byteLength > 0) {
          yield output;
        }
        options.signal?.throwIfAborted();
      } finally {
        // The consumer has had an opportunity to copy/write this bounded
        // chunk. Zeroizing the full plaintext buffer also covers the borrowed
        // view, and runs when progress throws or iteration is cancelled.
        decrypted.fill(0);
      }
    }
  } finally {
    iv.fill(0);
    scratch?.fill(0);
  }

  if (emittedPlaintextBytes !== materializedPlaintextBytes) {
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "Encrypted source did not yield its complete materialized plaintext prefix.",
    );
  }
}

async function importAesCbcKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.byteLength !== aes256KeyBytes) {
    throw new BackupCryptoError(
      "malformed-key-material",
      "AES-256-CBC key must be 32 bytes.",
    );
  }
  const keyCopy = keyBytes.slice();
  try {
    return await crypto.subtle.importKey(
      "raw",
      keyCopy,
      "AES-CBC",
      false,
      ["encrypt", "decrypt"],
    );
  } catch (cause) {
    throw new BackupCryptoError(
      "malformed-key-material",
      "WebCrypto could not import the AES-256-CBC key.",
      { cause },
    );
  } finally {
    keyCopy.fill(0);
  }
}

interface RawCbcChunkContext {
  /**
   * Caller-owned copy of the chunk's final ciphertext block. Passing it in
   * avoids re-slicing bytes the caller already extracted; it is NOT zeroized
   * here because the caller reuses it (as the next chunk's IV).
   */
  readonly finalCiphertextBlock?: Uint8Array<ArrayBuffer>;
  /**
   * Reusable ciphertext scratch of at least chunk + 16 bytes. The caller owns
   * zeroization once the whole file is processed.
   */
  readonly scratch?: Uint8Array<ArrayBuffer>;
}

/**
 * WebCrypto's AES-CBC primitive always validates/removes PKCS#7. Apple backup
 * files are instead truncated using MBFile.Size. Appending one synthetic
 * encrypted padding block makes WebCrypto return every raw source block; the
 * caller then performs the authoritative size truncation.
 */
async function decryptRawCbcChunk(
  encrypted: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  context: RawCbcChunkContext = {},
): Promise<Uint8Array> {
  const ownsFinalBlock = context.finalCiphertextBlock === undefined;
  const finalSourceBlock =
    context.finalCiphertextBlock ?? encrypted.slice(-aesBlockBytes);
  let syntheticPaddingBlock: Uint8Array<ArrayBuffer> | undefined;
  let decryptInput: Uint8Array<ArrayBuffer> | undefined;
  try {
    syntheticPaddingBlock = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: finalSourceBlock },
        key,
        new Uint8Array(),
      ),
    );
    if (syntheticPaddingBlock.byteLength !== aesBlockBytes) {
      throw new BackupCryptoError(
        "decryption-failed",
        "WebCrypto returned an unexpected CBC padding block.",
      );
    }

    const inputLength = encrypted.byteLength + aesBlockBytes;
    decryptInput =
      context.scratch !== undefined && context.scratch.byteLength >= inputLength
        ? context.scratch.subarray(0, inputLength)
        : new Uint8Array(inputLength);
    decryptInput.set(encrypted);
    decryptInput.set(syntheticPaddingBlock, encrypted.byteLength);
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-CBC", iv },
        key,
        decryptInput,
      ),
    );
    if (decrypted.byteLength !== encrypted.byteLength) {
      decrypted.fill(0);
      throw new BackupCryptoError(
        "decryption-failed",
        "WebCrypto returned an unexpected CBC plaintext length.",
      );
    }
    return decrypted;
  } catch (cause) {
    if (cause instanceof BackupCryptoError) {
      throw cause;
    }
    throw new BackupCryptoError(
      "decryption-failed",
      "AES-256-CBC decryption failed.",
      { cause },
    );
  } finally {
    if (ownsFinalBlock) {
      finalSourceBlock.fill(0);
    }
    syntheticPaddingBlock?.fill(0);
    if (
      decryptInput !== undefined &&
      decryptInput.buffer !== context.scratch?.buffer
    ) {
      decryptInput.fill(0);
    }
  }
}

function assertCiphertextShape(
  encryptedSize: number,
  plaintextSize: number,
): void {
  if (
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize < 0 ||
    encryptedSize % aesBlockBytes !== 0
  ) {
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "AES-CBC ciphertext length must be a multiple of 16 bytes.",
    );
  }
  // Apple-compatible readers resize decrypted storage to MBFile.Size. Some
  // backups retain a longer aligned source tail, while sparse logical files
  // can declare a larger size than their materialized ciphertext prefix. This
  // generator emits only decrypted stored bytes; the bounded caller owns any
  // zero-extension to the declared logical size.
  if (
    !Number.isSafeInteger(plaintextSize) ||
    plaintextSize < 0
  ) {
    throw new BackupCryptoError(
      "malformed-ciphertext",
      "Declared plaintext size is inconsistent with CBC ciphertext length.",
    );
  }
}
