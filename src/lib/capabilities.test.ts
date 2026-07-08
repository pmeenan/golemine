import { describe, expect, it, vi } from "vitest";

import {
  detectBootBrowserCapabilities,
  detectBrowserCapabilities,
} from "./capabilities";

function constructorWithPrototype(methods: readonly string[]): { prototype: Record<string, unknown> } {
  return {
    prototype: Object.fromEntries(methods.map((method) => [method, () => undefined])),
  };
}

describe("detectBrowserCapabilities", () => {
  it("reports the M1 Chrome APIs as supported when every feature probe is present", () => {
    const snapshot = detectBrowserCapabilities({
      showDirectoryPicker: () => undefined,
      navigator: {
        storage: {
          getDirectory: () => undefined,
        },
      },
      FileSystemFileHandle: constructorWithPrototype(["createSyncAccessHandle"]),
      DataTransferItem: constructorWithPrototype(["getAsFileSystemHandle"]),
    });

    expect(snapshot.isSupported).toBe(true);
    expect(snapshot.missingRequired).toEqual([]);
  });

  it("names missing required capabilities without user-agent sniffing", () => {
    const snapshot = detectBrowserCapabilities({
      navigator: {
        storage: {},
      },
      FileSystemFileHandle: constructorWithPrototype([]),
      DataTransferItem: constructorWithPrototype([]),
    });

    expect(snapshot.isSupported).toBe(false);
    expect(snapshot.missingRequired.map((check) => check.id)).toEqual([
      "show-directory-picker",
      "opfs-root",
      "opfs-sync-access-handle",
      "drag-drop-directory-handle",
    ]);
  });
});

describe("detectBootBrowserCapabilities", () => {
  function chromeLikeTargetWithoutWindowSyncAccess() {
    return {
      showDirectoryPicker: () => undefined,
      navigator: {
        storage: {
          getDirectory: () => undefined,
        },
      },
      FileSystemFileHandle: constructorWithPrototype([]),
      DataTransferItem: constructorWithPrototype(["getAsFileSystemHandle"]),
    };
  }

  it("accepts worker-only sync access handle support via the fallback probe", async () => {
    const probe = vi.fn(() => Promise.resolve(true));

    const snapshot = await detectBootBrowserCapabilities({
      target: chromeLikeTargetWithoutWindowSyncAccess(),
      probeWorkerSyncAccessHandle: probe,
    });

    expect(probe).toHaveBeenCalledOnce();
    expect(snapshot.isSupported).toBe(true);
    expect(snapshot.missingRequired).toEqual([]);
  });

  it("blocks the workspace when the worker probe reports the API is missing", async () => {
    const snapshot = await detectBootBrowserCapabilities({
      target: chromeLikeTargetWithoutWindowSyncAccess(),
      probeWorkerSyncAccessHandle: () => Promise.resolve(false),
    });

    expect(snapshot.isSupported).toBe(false);
    expect(snapshot.missingRequired.map((check) => check.id)).toEqual([
      "opfs-sync-access-handle",
    ]);
  });

  it("skips the worker probe when other required window checks already failed", async () => {
    const probe = vi.fn(() => Promise.resolve(true));

    const snapshot = await detectBootBrowserCapabilities({
      target: {
        ...chromeLikeTargetWithoutWindowSyncAccess(),
        // Remove another required capability so the gate blocks regardless.
        navigator: { storage: {} },
      },
      probeWorkerSyncAccessHandle: probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(snapshot.isSupported).toBe(false);
    expect(snapshot.missingRequired.map((check) => check.id)).toEqual([
      "opfs-root",
      "opfs-sync-access-handle",
    ]);
  });

  it("skips the worker probe when the window probe already passes", async () => {
    const probe = vi.fn(() => Promise.resolve(false));

    const snapshot = await detectBootBrowserCapabilities({
      target: {
        ...chromeLikeTargetWithoutWindowSyncAccess(),
        FileSystemFileHandle: constructorWithPrototype(["createSyncAccessHandle"]),
      },
      probeWorkerSyncAccessHandle: probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(snapshot.isSupported).toBe(true);
  });
});
