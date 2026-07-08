export const maxStringChunkCodeUnits = 8_192;

/**
 * Builds a string from UTF-16 code units in bounded chunks so hostile inputs
 * cannot blow the argument-spread limit of String.fromCharCode.
 */
export function stringFromCodeUnits(codeUnits: readonly number[]): string {
  let text = "";

  for (let offset = 0; offset < codeUnits.length; offset += maxStringChunkCodeUnits) {
    text += String.fromCharCode(
      ...codeUnits.slice(offset, offset + maxStringChunkCodeUnits),
    );
  }

  return text;
}

/**
 * Returns true when `bytes` contains `prefix` starting at `offset`.
 */
export function bytesStartWith(
  bytes: Uint8Array,
  prefix: Uint8Array | readonly number[],
  offset = 0,
): boolean {
  if (offset < 0 || offset + prefix.length > bytes.byteLength) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}
