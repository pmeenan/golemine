import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { appName } from "../src/lib/constants";
import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../src/lib/recents";

import {
  iosMiniEncryptedBackupExpectedMetadata,
  iosMiniEncryptedBackupPassword,
  iosMiniEncryptedBackupUdid,
} from "./fixtures/ios-mini-backup.mjs";
import {
  installFixtureDirectoryPicker,
  readFixtureFiles,
} from "./support/fixture-directory-picker";

test.setTimeout(90_000);

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const iosMiniEncryptedBackupRoot = path.join(
  fixturesDir,
  "fixtures",
  "generated",
  "ios-mini-encrypted-backup",
  iosMiniEncryptedBackupUdid,
);
const existingExtractionContents = "existing destination must survive";
const extractionDestinationName = "existing-ore-map.png";

interface M5TestWindow extends Window {
  __m5BackupWorkerCount: number;
  __m5PermissionRequested: boolean;
  __m5ResolvePermission?: () => void;
}

test("retries a wrong encrypted-backup password, ingests with the correct password, and decrypts an attachment", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMiniEncryptedBackupRoot),
    rootName: iosMiniEncryptedBackupUdid,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Mina's encrypted iPhone backup",
    }),
  ).toBeVisible({ timeout: 15_000 });

  const ingestPanel = page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "Ingest" }),
  });
  const passwordInput = page.getByLabel("Backup password");
  const ingestButton = page.getByRole("button", { name: "Ingest messages" });

  await expect(passwordInput).toBeVisible();
  await passwordInput.fill("wrong-synthetic-password");
  await ingestButton.click();
  await expect(
    page.getByText(/password.*incorrect|incorrect.*password/i).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(passwordInput).toHaveValue("");
  await expect(passwordInput).toBeFocused();
  await expect(ingestPanel.getByText("Ingested", { exact: true })).toHaveCount(0);
  await expect(ingestButton).toBeEnabled();

  await passwordInput.fill(iosMiniEncryptedBackupPassword);
  await ingestButton.click();
  await expect(page.getByRole("status")).toContainText(
    `Extracted ${String(
      iosMiniEncryptedBackupExpectedMetadata.counts.normalizedMessages,
    )} messages from ${String(
      iosMiniEncryptedBackupExpectedMetadata.counts.conversations,
    )} conversations.`,
    { timeout: 30_000 },
  );
  await expect(passwordInput).toHaveValue("");
  await expect(ingestPanel.getByText("Ingested", { exact: true })).toBeVisible();

  // A completed overview ingest must leave no decrypted plaintext staged under
  // transient/ (the session's decrypted Manifest sahpool included), even though
  // the one-shot ingest worker is terminated without an explicit lock RPC.
  // Checked here, before the messages route runs, because a later fresh
  // worker's first staging open sweeps crash leftovers and would mask them.
  await expect
    .poll(() => transientEntries(page, iosMiniEncryptedBackupUdid))
    .toEqual([]);

  const persistedSessionText = await page.evaluate(async (backupId) => {
    function storageEntries(storage: Storage): Record<string, string> {
      const entries: Record<string, string> = {};

      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);

        if (key !== null) {
          entries[key] = storage.getItem(key) ?? "";
        }
      }

      return entries;
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("golemine-recents");
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not inspect recents storage."));
      };
    });

    try {
      const record = await new Promise<Record<string, unknown> | undefined>(
        (resolve, reject) => {
          const request = database
            .transaction("backups", "readonly")
            .objectStore("backups")
            .get(backupId) as IDBRequest<Record<string, unknown> | undefined>;
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            reject(
              request.error ?? new Error("Could not inspect the encrypted recent."),
            );
          };
        },
      );
      const storedRecord =
        record === undefined
          ? undefined
          : { ...record, directoryHandle: undefined };

      return JSON.stringify({
        localStorage: storageEntries(localStorage),
        recent: storedRecord,
        sessionStorage: storageEntries(sessionStorage),
      });
    } finally {
      database.close();
    }
  }, iosMiniEncryptedBackupUdid);

  expect(persistedSessionText).toContain(iosMiniEncryptedBackupUdid);
  expect(persistedSessionText).toContain('"isEncrypted":true');
  expect(persistedSessionText).not.toContain(iosMiniEncryptedBackupPassword);
  expect(persistedSessionText).not.toMatch(
    /passcode|password|classKey|manifestKey/iu,
  );

  await page.getByRole("link", { name: /Messages/ }).click();
  await expect(page.getByTestId("m3-conversation-list")).toBeVisible();

  const attachmentPasswordInput = page.getByLabel("Backup password");
  const attachmentUnlockForm = page.locator("form").filter({
    has: attachmentPasswordInput,
  });
  await expect(attachmentPasswordInput).toBeVisible();
  await page.getByRole("button", { name: /Field Notes/ }).click();
  const timeline = page.getByTestId("m3-message-timeline");

  await expect(timeline.getByText("Attaching the synthetic ore map.")).toBeVisible();
  await timeline.getByText("Attaching the synthetic ore map.").click();
  const detailsOverlay = page.getByTestId("message-details-overlay");

  await expect(detailsOverlay).toBeVisible();
  await detailsOverlay
    .getByRole("button", { name: "Unlock attachments" })
    .click();
  await expect(detailsOverlay).toHaveCount(0);
  await expect(attachmentPasswordInput).toBeFocused();

  await attachmentPasswordInput.fill(iosMiniEncryptedBackupPassword);
  await attachmentUnlockForm
    .getByRole("button", { name: "Unlock attachments" })
    .click();

  await expect(
    timeline.getByRole("img", {
      name: iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment.transferName,
    }),
  ).toBeVisible({ timeout: 15_000 });

  await page.evaluate(
    async ({ attachmentFileId, backupId, destinationContents, destinationName }) => {
      const root = await navigator.storage.getDirectory();
      const sourceBackups = await root.getDirectoryHandle("e2e-source-backups");
      const sourceBackup = await sourceBackups.getDirectoryHandle(backupId);
      const shard = await sourceBackup.getDirectoryHandle(attachmentFileId.slice(0, 2));
      const sourceHandle = await shard.getFileHandle(attachmentFileId);
      const sourceFile = await sourceHandle.getFile();
      const corruptedCiphertext = new Uint8Array(await sourceFile.arrayBuffer());

      corruptedCiphertext[0] ^= 0xff;
      const sourceWritable = await sourceHandle.createWritable();
      await sourceWritable.write(corruptedCiphertext);
      await sourceWritable.close();

      const destinations = await root.getDirectoryHandle("e2e-extractions", {
        create: true,
      });
      const destination = await destinations.getFileHandle(destinationName, {
        create: true,
      });
      const destinationWritable = await destination.createWritable();
      await destinationWritable.write(destinationContents);
      await destinationWritable.close();

      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: () => Promise.resolve(destination),
      });
    },
    {
      attachmentFileId:
        iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment.fileID,
      backupId: iosMiniEncryptedBackupUdid,
      destinationContents: existingExtractionContents,
      destinationName: extractionDestinationName,
    },
  );

  await timeline.getByText("Attaching the synthetic ore map.").click();
  await expect(detailsOverlay).toBeVisible();
  await detailsOverlay.getByRole("button", { name: "Extract original" }).click();
  await expect(detailsOverlay.getByText(/hash no longer matches/iu)).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(() => readExtractionDestination(page, extractionDestinationName))
    .toBe(existingExtractionContents);
  await detailsOverlay
    .getByRole("button", { name: "Close message details" })
    .click();
  await expect(detailsOverlay).toHaveCount(0);

  await page.getByRole("button", { name: "Lock attachments" }).click();
  await expect(attachmentPasswordInput).toBeVisible();
  await expect(attachmentPasswordInput).toBeFocused();
  await expect
    .poll(() => transientEntries(page, iosMiniEncryptedBackupUdid))
    .toEqual([]);

  await page.evaluate(() => {
    const testWindow = window as unknown as M5TestWindow;
    const NativeWorker = window.Worker;

    testWindow.__m5BackupWorkerCount = 0;
    testWindow.__m5PermissionRequested = false;
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          const options = args[1] as WorkerOptions | undefined;

          if (options?.name === "golemine-backup-worker") {
            testWindow.__m5BackupWorkerCount += 1;
          }

          return Reflect.construct(target, args, newTarget) as Worker;
        },
      }),
    });

    let resolvePermission: ((permission: PermissionState) => void) | undefined;
    let deferPermission = true;
    const permission = new Promise<PermissionState>((resolve) => {
      resolvePermission = resolve;
    });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "queryPermission", {
      configurable: true,
      value: () => Promise.resolve(deferPermission ? "prompt" : "granted"),
    });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, "requestPermission", {
      configurable: true,
      value: () => {
        testWindow.__m5PermissionRequested = true;
        return permission;
      },
    });
    testWindow.__m5ResolvePermission = () => {
      deferPermission = false;
      resolvePermission?.("granted");
    };
  });

  await attachmentPasswordInput.fill(iosMiniEncryptedBackupPassword);
  await attachmentUnlockForm
    .getByRole("button", { name: "Unlock attachments" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as M5TestWindow).__m5PermissionRequested,
      ),
    )
    .toBe(true);

  await page.getByRole("link", { name: "Overview" }).click();
  await page.evaluate(() => {
    (window as unknown as M5TestWindow).__m5ResolvePermission?.();
  });
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(
      () => (window as unknown as M5TestWindow).__m5BackupWorkerCount,
    ),
  ).toBe(0);

  await page.getByRole("link", { name: appName }).click();
  await page.getByRole("button", { name: "Remove recent backup" }).click();
  await page
    .getByRole("button", { name: "Remove Mina's encrypted iPhone backup" })
    .click();
  await expect(page.getByText("No recent backups are stored.")).toBeVisible();
  await expect
    .poll(() => transientDirectoryExists(page, iosMiniEncryptedBackupUdid))
    .toBe(false);
});

async function transientEntries(
  page: import("@playwright/test").Page,
  backupId: string,
): Promise<string[]> {
  return page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle(appDirectoryName);
        const backups = await app.getDirectoryHandle(backupsDirectoryName);
        const backup = await backups.getDirectoryHandle(id);
        const transient = await backup.getDirectoryHandle("transient");
        const names: string[] = [];
        const entries = transient as FileSystemDirectoryHandle & {
          entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        };
        for await (const [name] of entries.entries()) {
          names.push(name);
        }
        return names.sort();
      } catch (cause) {
        if (cause instanceof Error && cause.name === "NotFoundError") {
          return [];
        }
        throw cause;
      }
    },
    {
      appDirectoryName: derivedDataOpfsAppDirectoryName,
      backupsDirectoryName: derivedDataOpfsBackupsDirectoryName,
      id: backupId,
    },
  );
}

async function readExtractionDestination(
  page: import("@playwright/test").Page,
  destinationName: string,
): Promise<string | undefined> {
  return page.evaluate(async (name) => {
    try {
      const root = await navigator.storage.getDirectory();
      const destinations = await root.getDirectoryHandle("e2e-extractions");
      const destination = await destinations.getFileHandle(name);
      return await (await destination.getFile()).text();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "NotFoundError") {
        return undefined;
      }
      throw cause;
    }
  }, destinationName);
}

async function transientDirectoryExists(
  page: import("@playwright/test").Page,
  backupId: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle(appDirectoryName);
        const backups = await app.getDirectoryHandle(backupsDirectoryName);
        const backup = await backups.getDirectoryHandle(id);
        await backup.getDirectoryHandle("transient");
        return true;
      } catch (cause) {
        if (cause instanceof Error && cause.name === "NotFoundError") {
          return false;
        }
        throw cause;
      }
    },
    {
      appDirectoryName: derivedDataOpfsAppDirectoryName,
      backupsDirectoryName: derivedDataOpfsBackupsDirectoryName,
      id: backupId,
    },
  );
}
