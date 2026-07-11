/**
 * Narrowing guard for "plain object we can safely Reflect.get on". Shared by
 * worker modules that probe host globals or parse untrusted JSON shapes.
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Asserts that `value` is a positive safe integer. Shared by worker modules
 * that validate caller-supplied chunk and buffer byte counts before
 * allocating or looping over them.
 */
export function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}
