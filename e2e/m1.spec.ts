import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { appName } from "../src/lib/constants";
import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../src/lib/recents";
import { iosMiniBackupUdid } from "./fixtures/ios-mini-backup.mjs";

interface FixtureFile {
  base64: string;
  relativePath: string;
}

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const iosMiniBackupRoot = path.join(
  fixturesDir,
  "fixtures",
  "generated",
  "ios-mini-backup",
  iosMiniBackupUdid,
);

const derivedDataPath = {
  appDirectoryName: derivedDataOpfsAppDirectoryName,
  backupsDirectoryName: derivedDataOpfsBackupsDirectoryName,
};

test("blocks workspace routes without required Chrome APIs while guides remain accessible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "showDirectoryPicker");

    if ("FileSystemFileHandle" in window) {
      Reflect.deleteProperty(
        FileSystemFileHandle.prototype,
        "createSyncAccessHandle",
      );
    }

    if ("DataTransferItem" in window) {
      Reflect.deleteProperty(
        DataTransferItem.prototype,
        "getAsFileSystemHandle",
      );
    }

    const storagePrototype = Object.getPrototypeOf(navigator.storage) as {
      getDirectory?: unknown;
    };

    Reflect.deleteProperty(storagePrototype, "getDirectory");
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Chrome is required for this workspace",
    }),
  ).toBeVisible();
  await expect(page.getByText("Open local backup folders")).toBeVisible();

  await page.goto("/guide/iphone");
  await expect(
    page.getByRole("heading", { level: 1, name: "iPhone backup guide" }),
  ).toBeVisible();
});

test("opens a synthetic iPhone backup, persists recents, renames, and removes derived data", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMiniBackupRoot),
    rootName: iosMiniBackupUdid,
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Local backup workspace" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Mina's iPhone backup" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("C39SYNTH0001")).toBeVisible();
  await expect(page.getByText("+15555550123")).toBeVisible();

  await createDerivedDataSentinel(page, iosMiniBackupUdid);
  await page.getByRole("link", { name: appName }).click();

  await expect(page.getByRole("heading", { name: "Recent backups" })).toBeVisible();
  await expect(page.getByText("Mina's iPhone backup")).toBeVisible();

  await page.getByRole("button", { name: "Rename backup" }).click();
  await page.getByLabel("Backup name").fill("Evidence iPhone");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Evidence iPhone" })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "Open" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Evidence iPhone" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: appName }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Local backup workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Evidence iPhone" })).toBeVisible();

  await page.getByRole("button", { name: "Remove recent backup" }).click();
  await page.getByRole("button", { name: "Remove Evidence iPhone" }).click();
  await expect(page.getByText("No recent backups are stored.")).toBeVisible();
  await expect.poll(() => derivedDataDirectoryExists(page, iosMiniBackupUdid)).toBe(false);
});

function readFixtureFiles(root: string): FixtureFile[] {
  return readFixtureFilesRecursive(root, root);
}

function readFixtureFilesRecursive(root: string, current: string): FixtureFile[] {
  const files: FixtureFile[] = [];

  for (const entry of readdirSync(current)) {
    const entryPath = path.join(current, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      files.push(...readFixtureFilesRecursive(root, entryPath));
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    files.push({
      relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
      base64: readFileSync(entryPath).toString("base64"),
    });
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function installFixtureDirectoryPicker(
  page: Page,
  payload: { files: readonly FixtureFile[]; rootName: string },
): Promise<void> {
  await page.addInitScript((fixture: { files: readonly FixtureFile[]; rootName: string }) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const opfsRoot = await navigator.storage.getDirectory();

        await removeIfPresent(opfsRoot, "e2e-source-backups");

        const sourceRoot = await opfsRoot.getDirectoryHandle("e2e-source-backups", {
          create: true,
        });
        const backupRoot = await sourceRoot.getDirectoryHandle(fixture.rootName, {
          create: true,
        });

        for (const file of fixture.files) {
          await writeFixtureFile(backupRoot, file);
        }

        return backupRoot;
      },
    });

    async function writeFixtureFile(
      root: FileSystemDirectoryHandle,
      file: FixtureFile,
    ): Promise<void> {
      const pathParts = file.relativePath.split("/");
      const fileName = pathParts.pop();

      if (fileName === undefined) {
        throw new Error("Fixture file path is empty.");
      }

      let directory = root;
      for (const pathPart of pathParts) {
        directory = await directory.getDirectoryHandle(pathPart, { create: true });
      }

      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();

      await writable.write(base64ToArrayBuffer(file.base64));
      await writable.close();
    }

    function base64ToArrayBuffer(base64: string): ArrayBuffer {
      const binary = atob(base64);
      const buffer = new ArrayBuffer(binary.length);
      const bytes = new Uint8Array(buffer);

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      return buffer;
    }

    async function removeIfPresent(
      root: FileSystemDirectoryHandle,
      name: string,
    ): Promise<void> {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "NotFoundError") {
          throw cause;
        }
      }
    }
  }, payload);
}

async function createDerivedDataSentinel(page: Page, backupId: string): Promise<void> {
  await page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      const root = await navigator.storage.getDirectory();
      const appDirectory = await root.getDirectoryHandle(appDirectoryName, {
        create: true,
      });
      const backupsDirectory = await appDirectory.getDirectoryHandle(
        backupsDirectoryName,
        { create: true },
      );
      const backupDirectory = await backupsDirectory.getDirectoryHandle(id, {
        create: true,
      });
      const sentinel = await backupDirectory.getFileHandle("sentinel.txt", {
        create: true,
      });
      const writable = await sentinel.createWritable();

      await writable.write("synthetic derived data");
      await writable.close();
    },
    { ...derivedDataPath, id: backupId },
  );
}

async function derivedDataDirectoryExists(
  page: Page,
  backupId: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const appDirectory = await root.getDirectoryHandle(appDirectoryName, {
          create: false,
        });
        const backupsDirectory = await appDirectory.getDirectoryHandle(
          backupsDirectoryName,
          { create: false },
        );

        await backupsDirectory.getDirectoryHandle(id, { create: false });
        return true;
      } catch (cause) {
        if (cause instanceof Error && cause.name === "NotFoundError") {
          return false;
        }

        throw cause;
      }
    },
    { ...derivedDataPath, id: backupId },
  );
}
