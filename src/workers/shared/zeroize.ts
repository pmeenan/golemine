/**
 * Zero-fills every distinct buffer in the list. Optional entries keep call
 * sites free of conditional spreads, and the Set dedupe makes aliased views
 * (e.g. a truncated subarray returned alongside its backing array) safe to
 * list twice without double work.
 */
export function zeroizeBuffers(
  ...buffers: readonly (Uint8Array | undefined)[]
): void {
  const distinct = new Set<Uint8Array>();

  for (const bytes of buffers) {
    if (bytes !== undefined) {
      distinct.add(bytes);
    }
  }

  for (const bytes of distinct) {
    bytes.fill(0);
  }
}
