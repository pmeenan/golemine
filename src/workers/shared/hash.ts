/**
 * FNV-1a 32-bit hash of a string, rendered as 8 lowercase hex characters.
 * Used for stable, collision-tolerant identifiers (SAH pool VFS names,
 * sanitized thumbnail cache keys) — never for security purposes.
 */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
