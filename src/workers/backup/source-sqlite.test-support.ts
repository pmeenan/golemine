import {
  normalizeStagedManifestDatabase,
  type BackupSourceTestOverrides,
} from "./manifest-db";
import {
  openSourceSqliteDatabase,
  type SourceSqliteBlobInput,
  type SourceSqliteDatabase,
  type SourceSqliteStagingInput,
} from "./source-sqlite";

export type AnySourceSqliteTestInput =
  | SourceSqliteBlobInput
  | SourceSqliteStagingInput;

export function isStagingSourceSqliteInput(
  input: AnySourceSqliteTestInput,
): input is SourceSqliteStagingInput {
  return !(input.main instanceof Blob);
}

/** Node/Vitest-only adapter. Production source paths always use OPFS Blob import. */
export async function openBlobSourceSqliteInMemoryForTest(
  input: SourceSqliteBlobInput,
): Promise<SourceSqliteDatabase> {
  return openSourceSqliteDatabase({
    label: input.label,
    main: new Uint8Array(await input.main.arrayBuffer()),
    ...(input.wal === undefined
      ? {}
      : { wal: new Uint8Array(await input.wal.arrayBuffer()) }),
    ...(input.shm === undefined
      ? {}
      : { shm: new Uint8Array(await input.shm.arrayBuffer()) }),
  });
}

/** Node/Vitest-only encrypted Manifest staging adapter. */
export async function stageDecryptedManifestInMemoryForTest(
  chunks: AsyncIterable<Uint8Array>,
): Promise<Blob> {
  const copiedChunks: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0;

  for await (const chunk of chunks) {
    const copy = chunk.slice();
    copiedChunks.push(copy);
    byteLength += copy.byteLength;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of copiedChunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }

  // Exactly the production byte-level normalization core, adapted over the
  // in-memory buffer, so test staging never validates less than production.
  const normalizedLength = normalizeStagedManifestDatabase({
    byteLength: bytes.byteLength,
    read: (offset, length) => bytes.slice(offset, offset + length),
  });
  return new Blob([bytes.slice(0, normalizedLength)]);
}

export async function stagePlaintextInMemoryForTest(
  chunks: AsyncIterable<Uint8Array>,
  plaintextSize: number,
): Promise<Blob> {
  const bytes = new Uint8Array(plaintextSize);
  let offset = 0;

  for await (const chunk of chunks) {
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error("Test plaintext chunks exceeded the declared size.");
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Blob([bytes]);
}

/** Runs a staged (decrypt-streamed) main source into an in-memory buffer. */
async function stageSourceSqliteMainInMemoryForTest(
  main: SourceSqliteStagingInput["main"],
): Promise<Uint8Array> {
  const bytes = new Uint8Array(main.declaredByteLength);
  let offset = 0;

  await main.stage({
    write(chunk) {
      if (offset + chunk.byteLength > bytes.byteLength) {
        throw new Error("Staged test bytes exceeded the declared main size.");
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    },
    extendZeros(byteLength) {
      // The destination buffer is zero-initialized; advancing suffices.
      offset += byteLength;
    },
  });

  if (offset !== bytes.byteLength) {
    throw new Error("Staged test bytes did not match the declared main size.");
  }

  return bytes;
}

/** Node/Vitest-only adapter covering both Blob and decrypt-streamed mains. */
export async function openAnySourceSqliteInMemoryForTest(
  input: AnySourceSqliteTestInput,
): Promise<SourceSqliteDatabase> {
  if (!isStagingSourceSqliteInput(input)) {
    return openBlobSourceSqliteInMemoryForTest(input);
  }

  return openSourceSqliteDatabase({
    label: input.label,
    main: await stageSourceSqliteMainInMemoryForTest(input.main),
    ...(input.wal === undefined
      ? {}
      : { wal: new Uint8Array(await input.wal.arrayBuffer()) }),
    ...(input.shm === undefined
      ? {}
      : { shm: new Uint8Array(await input.shm.arrayBuffer()) }),
  });
}

/**
 * The standard in-memory replacement set for manifest-db's
 * `setBackupSourceOverridesForTests`. Spread and refine per test when a seam
 * needs instrumentation; always reset in afterEach/finally.
 */
export const inMemoryBackupSourceOverridesForTest = {
  openSourceSqlite: openAnySourceSqliteInMemoryForTest,
  stageDecryptedMain: stageDecryptedManifestInMemoryForTest,
  stagePlaintext: stagePlaintextInMemoryForTest,
} as const satisfies BackupSourceTestOverrides;
