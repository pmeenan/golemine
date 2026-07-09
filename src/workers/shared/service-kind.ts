import type { MessageServiceKind } from "../../lib/worker-types";

/**
 * Maps a provider-reported message service string to the normalized service
 * kind used for presentation decisions (e.g. bubble accent color). Matching
 * is case-insensitive on the exact trimmed token — variants such as
 * "SMS-forwarded" intentionally fall through to "unknown" rather than being
 * guessed at (hard rule 8: no provider quirks above ingest).
 */
export function classifyServiceKind(
  service: string | undefined,
): MessageServiceKind {
  const normalized = service?.trim().toLowerCase();

  if (normalized === "imessage") {
    return "imessage";
  }

  if (normalized === "sms" || normalized === "mms" || normalized === "rcs") {
    return "sms-family";
  }

  return "unknown";
}
