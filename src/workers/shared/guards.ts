/**
 * Narrowing guard for "plain object we can safely Reflect.get on". Shared by
 * worker modules that probe host globals or parse untrusted JSON shapes.
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
