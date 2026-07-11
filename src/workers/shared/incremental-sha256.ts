import { assertPositiveSafeInteger } from "./guards";

const SHA256_BLOCK_BYTES = 64;
const SHA256_DIGEST_BYTES = 32;
const DEFAULT_BLOB_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Blobs at or below this size hash through native `crypto.subtle.digest`
 * (the project-preferred WebCrypto path) with a single in-memory read;
 * larger payloads stream through `IncrementalSha256` in bounded chunks.
 */
export const nativeSha256MaxBlobBytes = 64 * 1024 * 1024;

/**
 * Receives each hashed chunk in order so callers can tee bytes to a sink
 * while hashing. The chunk is a borrowed view into a buffer that is reused
 * or zeroized after the callback settles: treat it as read-only and copy it
 * when the bytes must outlive the call.
 */
export type Sha256ChunkCallback = (chunk: Uint8Array) => void | Promise<void>;

const initialState = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const roundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, places: number): number {
  return (value >>> places) | (value << (32 - places));
}

/**
 * Dependency-free incremental SHA-256 for streaming integrity provenance.
 *
 * A digest finalizes the instance. Call `clone()` before finalization when a
 * caller needs to branch a common prefix into multiple independent hashes.
 */
export class IncrementalSha256 {
  readonly #state = new Uint32Array(initialState);
  readonly #buffer = new Uint8Array(SHA256_BLOCK_BYTES);
  readonly #schedule = new Uint32Array(SHA256_BLOCK_BYTES);
  #bufferLength = 0;
  #bytesHashedLow = 0;
  #bytesHashedHigh = 0;
  #finalized = false;

  update(bytes: Uint8Array): this {
    this.#assertActive();
    this.#addByteLength(bytes.byteLength);

    let offset = 0;

    if (this.#bufferLength > 0) {
      const take = Math.min(
        SHA256_BLOCK_BYTES - this.#bufferLength,
        bytes.byteLength,
      );
      this.#buffer.set(bytes.subarray(0, take), this.#bufferLength);
      this.#bufferLength += take;
      offset = take;

      if (this.#bufferLength === SHA256_BLOCK_BYTES) {
        this.#compress(this.#buffer, 0);
        this.#bufferLength = 0;
      }
    }

    while (offset + SHA256_BLOCK_BYTES <= bytes.byteLength) {
      this.#compress(bytes, offset);
      offset += SHA256_BLOCK_BYTES;
    }

    if (offset < bytes.byteLength) {
      this.#buffer.set(bytes.subarray(offset), 0);
      this.#bufferLength = bytes.byteLength - offset;
    }

    return this;
  }

  clone(): IncrementalSha256 {
    this.#assertActive();

    const copy = new IncrementalSha256();
    copy.#state.set(this.#state);
    copy.#buffer.set(this.#buffer);
    copy.#bufferLength = this.#bufferLength;
    copy.#bytesHashedLow = this.#bytesHashedLow;
    copy.#bytesHashedHigh = this.#bytesHashedHigh;
    return copy;
  }

  digest(): Uint8Array {
    this.#assertActive();
    this.#finalized = true;

    this.#buffer[this.#bufferLength] = 0x80;
    this.#buffer.fill(0, this.#bufferLength + 1);

    if (this.#bufferLength >= 56) {
      this.#compress(this.#buffer, 0);
      this.#buffer.fill(0);
    }

    const bitLengthHigh =
      ((this.#bytesHashedHigh << 3) | (this.#bytesHashedLow >>> 29)) >>> 0;
    const bitLengthLow = (this.#bytesHashedLow << 3) >>> 0;
    writeUint32BigEndian(this.#buffer, 56, bitLengthHigh);
    writeUint32BigEndian(this.#buffer, 60, bitLengthLow);
    this.#compress(this.#buffer, 0);

    const digest = new Uint8Array(SHA256_DIGEST_BYTES);
    for (let index = 0; index < this.#state.length; index += 1) {
      writeUint32BigEndian(digest, index * 4, this.#state[index]);
    }

    this.#buffer.fill(0);
    this.#schedule.fill(0);
    return digest;
  }

  digestHex(): string {
    return hexFromBytes(this.digest());
  }

  #assertActive(): void {
    if (this.#finalized) {
      throw new Error("SHA-256 instance has already been finalized.");
    }
  }

  #addByteLength(byteLength: number): void {
    const lowAddition = byteLength >>> 0;
    const lowTotal = this.#bytesHashedLow + lowAddition;
    const carry = lowTotal > 0xffffffff ? 1 : 0;

    this.#bytesHashedLow = lowTotal >>> 0;
    this.#bytesHashedHigh =
      (this.#bytesHashedHigh + Math.floor(byteLength / 0x100000000) + carry) >>>
      0;
  }

  #compress(bytes: Uint8Array, offset: number): void {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      this.#schedule[index] =
        ((bytes[wordOffset] << 24) |
          (bytes[wordOffset + 1] << 16) |
          (bytes[wordOffset + 2] << 8) |
          bytes[wordOffset + 3]) >>>
        0;
    }

    for (let index = 16; index < this.#schedule.length; index += 1) {
      const previous15 = this.#schedule[index - 15];
      const previous2 = this.#schedule[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);

      this.#schedule[index] =
        (this.#schedule[index - 16] +
          sigma0 +
          this.#schedule[index - 7] +
          sigma1) >>>
        0;
    }

    let a = this.#state[0];
    let b = this.#state[1];
    let c = this.#state[2];
    let d = this.#state[3];
    let e = this.#state[4];
    let f = this.#state[5];
    let g = this.#state[6];
    let h = this.#state[7];

    for (let index = 0; index < this.#schedule.length; index += 1) {
      const choice = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const temporary1 =
        (h + sum1 + choice + roundConstants[index] + this.#schedule[index]) >>> 0;
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.#state[0] = (this.#state[0] + a) >>> 0;
    this.#state[1] = (this.#state[1] + b) >>> 0;
    this.#state[2] = (this.#state[2] + c) >>> 0;
    this.#state[3] = (this.#state[3] + d) >>> 0;
    this.#state[4] = (this.#state[4] + e) >>> 0;
    this.#state[5] = (this.#state[5] + f) >>> 0;
    this.#state[6] = (this.#state[6] + g) >>> 0;
    this.#state[7] = (this.#state[7] + h) >>> 0;
  }
}

export async function sha256BlobHex(
  blob: Blob,
  options: {
    chunkBytes?: number;
    signal?: AbortSignal;
    /**
     * Tees every hashed chunk to the caller (see `Sha256ChunkCallback`).
     * Supplying a callback forces the streaming path so the tee also sees
     * payloads below the native-digest threshold.
     */
    onChunk?: Sha256ChunkCallback;
  } = {},
): Promise<string> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_BLOB_CHUNK_BYTES;
  assertPositiveSafeInteger(chunkBytes, "SHA-256 Blob chunk size");

  // The native digest needs the whole payload resident at once and cannot
  // tee chunks, so it is reserved for bounded pure-hash reads.
  if (options.onChunk === undefined && blob.size <= nativeSha256MaxBlobBytes) {
    return nativeSha256BlobHex(blob, options.signal);
  }

  const hasher = new IncrementalSha256();

  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const end = Math.min(blob.size, offset + chunkBytes);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());

    try {
      options.signal?.throwIfAborted();
      if (chunk.byteLength !== end - offset) {
        throw new Error("Blob returned a short read while hashing.");
      }
      hasher.update(chunk);
      await options.onChunk?.(chunk);
    } finally {
      chunk.fill(0);
    }
  }

  options.signal?.throwIfAborted();
  return hasher.digestHex();
}

async function nativeSha256BlobHex(
  blob: Blob,
  signal: AbortSignal | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  try {
    signal?.throwIfAborted();
    if (bytes.byteLength !== blob.size) {
      throw new Error("Blob returned a short read while hashing.");
    }

    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    signal?.throwIfAborted();
    return hexFromBytes(digest);
  } finally {
    bytes.fill(0);
  }
}

export function updateSha256WithZeros(
  hasher: IncrementalSha256,
  byteLength: number,
  chunkBytes?: number,
): void;
export function updateSha256WithZeros(
  hasher: IncrementalSha256,
  byteLength: number,
  chunkBytes: number | undefined,
  onChunk: Sha256ChunkCallback,
): Promise<void>;
export function updateSha256WithZeros(
  hasher: IncrementalSha256,
  byteLength: number,
  chunkBytes = DEFAULT_BLOB_CHUNK_BYTES,
  onChunk?: Sha256ChunkCallback,
): void | Promise<void> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("SHA-256 zero-fill length must be a non-negative integer.");
  }
  assertPositiveSafeInteger(chunkBytes, "SHA-256 zero-fill chunk size");

  const zeros = new Uint8Array(Math.min(chunkBytes, byteLength));

  if (onChunk === undefined) {
    for (let remaining = byteLength; remaining > 0;) {
      const currentLength = Math.min(remaining, zeros.byteLength);
      hasher.update(zeros.subarray(0, currentLength));
      remaining -= currentLength;
    }
    return;
  }

  return (async () => {
    for (let remaining = byteLength; remaining > 0;) {
      const currentLength = Math.min(remaining, zeros.byteLength);
      const chunk = zeros.subarray(0, currentLength);
      hasher.update(chunk);
      // The zero scratch is reused across iterations; the tee must treat the
      // borrowed chunk as read-only (see `Sha256ChunkCallback`).
      await onChunk(chunk);
      remaining -= currentLength;
    }
  })();
}

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

function writeUint32BigEndian(
  destination: Uint8Array,
  offset: number,
  value: number,
): void {
  destination[offset] = value >>> 24;
  destination[offset + 1] = value >>> 16;
  destination[offset + 2] = value >>> 8;
  destination[offset + 3] = value;
}
