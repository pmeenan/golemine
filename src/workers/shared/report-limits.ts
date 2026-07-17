/**
 * Report validation bounds enforced by the db-worker report API. Import-safe
 * from UI code (like media-limits.ts) so form `maxLength` attributes and the
 * worker-side validators share one source of truth.
 */
export const maxReportTitleLength = 200;
export const maxCaseFieldLength = 500;
export const maxReportNoteLength = 20_000;
export const maxReportItems = 10_000;
