import { createCapabilityProbeWorker } from "./worker-client";

export type BrowserCapabilityId =
  | "show-directory-picker"
  | "opfs-root"
  | "opfs-sync-access-handle"
  | "drag-drop-directory-handle";

export interface BrowserCapabilityCheck {
  id: BrowserCapabilityId;
  label: string;
  required: boolean;
  supported: boolean;
}

export interface BrowserCapabilitySnapshot {
  checkedAt: string;
  isSupported: boolean;
  checks: readonly BrowserCapabilityCheck[];
  missingRequired: readonly BrowserCapabilityCheck[];
}

type CapabilityOverrides = Partial<Record<BrowserCapabilityId, boolean>>;

interface CapabilityProbeTarget {
  DataTransferItem?: unknown;
  FileSystemFileHandle?: unknown;
  navigator?: {
    storage?: {
      getDirectory?: unknown;
    };
  };
  showDirectoryPicker?: unknown;
}

const requiredCapabilityLabels: Record<BrowserCapabilityId, string> = {
  "show-directory-picker": "Open local backup folders",
  "opfs-root": "Store derived data in OPFS",
  "opfs-sync-access-handle": "Run SQLite with opfs-sahpool",
  "drag-drop-directory-handle": "Accept dragged backup folders",
};

export function detectBrowserCapabilities(
  target: CapabilityProbeTarget = globalThis,
  overrides: CapabilityOverrides = {},
): BrowserCapabilitySnapshot {
  const checks: readonly BrowserCapabilityCheck[] = [
    {
      id: "show-directory-picker",
      label: requiredCapabilityLabels["show-directory-picker"],
      required: true,
      supported: "showDirectoryPicker" in target,
    },
    {
      id: "opfs-root",
      label: requiredCapabilityLabels["opfs-root"],
      required: true,
      supported: typeof target.navigator?.storage?.getDirectory === "function",
    },
    {
      id: "opfs-sync-access-handle",
      label: requiredCapabilityLabels["opfs-sync-access-handle"],
      required: true,
      supported:
        overrides["opfs-sync-access-handle"] ??
        hasPrototypeMethod(target.FileSystemFileHandle, "createSyncAccessHandle"),
    },
    {
      id: "drag-drop-directory-handle",
      label: requiredCapabilityLabels["drag-drop-directory-handle"],
      required: true,
      supported: hasPrototypeMethod(target.DataTransferItem, "getAsFileSystemHandle"),
    },
  ];
  const missingRequired = checks.filter((check) => check.required && !check.supported);

  return {
    checkedAt: new Date().toISOString(),
    isSupported: missingRequired.length === 0,
    checks,
    missingRequired,
  };
}

export interface BootCapabilityProbeOptions {
  target?: CapabilityProbeTarget;
  probeWorkerSyncAccessHandle?: () => Promise<boolean>;
}

let bootBrowserCapabilities: Promise<BrowserCapabilitySnapshot> | undefined;
let resolvedBootBrowserCapabilities: BrowserCapabilitySnapshot | undefined;

/**
 * Lazily-started, memoized boot capability detection. Lazy so the worker
 * probe cannot run during module evaluation (its helpers may not be
 * initialized yet) and so importing this module stays side-effect free.
 */
export function getBootBrowserCapabilities(): Promise<BrowserCapabilitySnapshot> {
  bootBrowserCapabilities ??= detectBootBrowserCapabilities().then((snapshot) => {
    resolvedBootBrowserCapabilities = snapshot;

    return snapshot;
  });

  return bootBrowserCapabilities;
}

/**
 * Synchronous view of the already-resolved boot snapshot, so route
 * transitions can render the gate's verdict immediately instead of flashing
 * the checking screen while an effect re-awaits the memoized promise.
 */
export function getResolvedBootBrowserCapabilities():
  | BrowserCapabilitySnapshot
  | undefined {
  return resolvedBootBrowserCapabilities;
}

export async function detectBootBrowserCapabilities(
  options: BootCapabilityProbeOptions = {},
): Promise<BrowserCapabilitySnapshot> {
  const target = options.target ?? globalThis;
  const windowSnapshot = detectBrowserCapabilities(target);
  const syncAccessCheck = windowSnapshot.checks.find(
    (check) => check.id === "opfs-sync-access-handle",
  );

  if (syncAccessCheck?.supported === true) {
    return windowSnapshot;
  }

  if (
    windowSnapshot.missingRequired.some(
      (check) => check.id !== "opfs-sync-access-handle",
    )
  ) {
    // The gate blocks regardless, so don't delay the block screen behind a
    // worker spawn, and don't let a fail-open probe result claim the SQLite
    // capability is "Available" on a browser that was never verified.
    return windowSnapshot;
  }

  const probe =
    options.probeWorkerSyncAccessHandle ?? detectWorkerSyncAccessHandleSupport;
  let workerSupport: boolean;

  try {
    workerSupport = await probe();
  } catch (cause) {
    // A crashed probe must never leave the gate stuck on the checking screen
    // or falsely block a capable browser; only an explicit `false` blocks.
    console.warn("Worker capability probe failed; assuming supported.", cause);
    workerSupport = true;
  }

  return detectBrowserCapabilities(target, {
    "opfs-sync-access-handle": workerSupport,
  });
}

function hasPrototypeMethod(constructorLike: unknown, method: string): boolean {
  if (constructorLike === null || constructorLike === undefined) {
    return false;
  }

  const maybeConstructor = constructorLike as { prototype?: unknown };

  return (
    typeof maybeConstructor.prototype === "object" &&
    maybeConstructor.prototype !== null &&
    method in maybeConstructor.prototype
  );
}

const workerProbeTimeoutMs = 3_000;
const workerProbeStorageKey = "golemine-worker-opfs-sync-access-handle";

async function detectWorkerSyncAccessHandleSupport(): Promise<boolean> {
  const cached = readCachedWorkerProbeResult();

  if (cached !== undefined) {
    return cached;
  }

  const probed = await probeWorkerSyncAccessHandle();

  if (probed === undefined) {
    // The probe timed out or the worker failed to start — an environment
    // problem, not evidence the API is missing. A browser that reaches this
    // fallback already passed the other Chrome-only probes, so fail open
    // instead of showing a false "Chrome is required" block screen on a slow
    // dev/CI start. An explicit `false` answer from the worker still blocks.
    console.warn(
      "Could not verify worker OPFS sync access handles before the probe timeout; assuming supported.",
    );
    return true;
  }

  writeCachedWorkerProbeResult(probed);

  return probed;
}

function probeWorkerSyncAccessHandle(): Promise<boolean | undefined> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let worker: Worker;

    try {
      worker = createCapabilityProbeWorker();
    } catch {
      resolve(undefined);
      return;
    }

    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve(undefined);
    }, workerProbeTimeoutMs);

    worker.onmessage = (event: MessageEvent<{ opfsSyncAccessHandle?: unknown }>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(event.data.opfsSyncAccessHandle === true);
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(undefined);
    };
  });
}

function readCachedWorkerProbeResult(): boolean | undefined {
  try {
    const cached = sessionStorage.getItem(workerProbeStorageKey);

    return cached === null ? undefined : cached === "true";
  } catch {
    return undefined;
  }
}

function writeCachedWorkerProbeResult(value: boolean): void {
  try {
    sessionStorage.setItem(workerProbeStorageKey, String(value));
  } catch {
    // Storage may be unavailable (e.g. blocked third-party context); the
    // probe simply re-runs on the next boot.
  }
}
